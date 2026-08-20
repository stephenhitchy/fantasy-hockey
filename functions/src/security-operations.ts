import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { db } from './shared/core/firebase';

const FUNCTION_REGION = 'us-central1';
const CSP_REPORT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const CSP_REPORT_MAX_BYTES = 16 * 1_024;
const CSP_REPORT_RATE_WINDOW_MILLISECONDS = 60 * 1_000;
const CSP_REPORT_REQUESTS_PER_WINDOW = 30;
const CSP_REPORT_GLOBAL_REQUESTS_PER_WINDOW = 120;
const CSP_REPORT_RATE_MAP_MAX_ENTRIES = 5_000;
const RETENTION_QUERY_LIMIT = 250;
const RETENTION_MAX_PASSES = 4;

interface CspRateWindow {
  startedAt: number;
  count: number;
  lastSeenAt: number;
}

interface NormalizedCspViolation {
  documentUri: string;
  blockedUri: string;
  violatedDirective: string;
  effectiveDirective: string;
  sourceFile: string;
  lineNumber: number | null;
  columnNumber: number | null;
  statusCode: number | null;
  disposition: string;
}

interface RetentionTarget {
  collection: string;
  cleanupOwner: 'security-operations' | 'league-automation';
}

const cspRateWindows = new Map<string, CspRateWindow>();
let cspGlobalRateWindow: CspRateWindow | null = null;

const SECURITY_RETENTION_TARGETS: readonly RetentionTarget[] = [
  { collection: 'clientErrorReports', cleanupOwner: 'security-operations' },
  { collection: 'feedbackReports', cleanupOwner: 'security-operations' },
  { collection: 'projectionGenerationRequests', cleanupOwner: 'security-operations' },
  { collection: 'leagueCreationRequests', cleanupOwner: 'security-operations' },
  { collection: 'leagueJoinRequests', cleanupOwner: 'security-operations' },
  { collection: 'cspViolationReports', cleanupOwner: 'security-operations' },
  { collection: 'betaEvidenceEvents', cleanupOwner: 'security-operations' },
  { collection: 'betaOperationsDaily', cleanupOwner: 'security-operations' },
  { collection: 'nhlSharedDataCache', cleanupOwner: 'security-operations' },
  { collection: 'privacyRequestOperations', cleanupOwner: 'security-operations' },
  { collection: 'privacyExportAudits', cleanupOwner: 'security-operations' },
  // The scoring queue already owns a dedicated, more frequent cleanup worker.
  { collection: 'leagueAutomationTasks', cleanupOwner: 'league-automation' },
] as const;

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }

  return typeof value === 'string' ? value.trim() : '';
}

function hashedRequesterIdentity(input: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const forwarded = headerValue(input.headers['x-forwarded-for'])
    .split(',')[0]
    ?.trim() ?? '';
  const rawIdentity = input.ip?.trim() || forwarded || 'unknown-csp-reporter';

  return createHash('sha256')
    .update(`rinkrat-csp:${rawIdentity}`)
    .digest('hex')
    .slice(0, 24);
}

function consumeCspGlobalRateLimit(): boolean {
  const now = Date.now();

  if (
    !cspGlobalRateWindow ||
    now - cspGlobalRateWindow.startedAt >= CSP_REPORT_RATE_WINDOW_MILLISECONDS
  ) {
    cspGlobalRateWindow = {
      startedAt: now,
      count: 1,
      lastSeenAt: now,
    };
    return true;
  }

  cspGlobalRateWindow.lastSeenAt = now;

  if (cspGlobalRateWindow.count >= CSP_REPORT_GLOBAL_REQUESTS_PER_WINDOW) {
    return false;
  }

  cspGlobalRateWindow.count += 1;
  return true;
}

function consumeCspRateLimit(requesterId: string): boolean {
  const now = Date.now();

  for (const [key, value] of cspRateWindows.entries()) {
    if (now - value.lastSeenAt > 5 * CSP_REPORT_RATE_WINDOW_MILLISECONDS) {
      cspRateWindows.delete(key);
    }
  }

  const current = cspRateWindows.get(requesterId);

  if (!current && cspRateWindows.size >= CSP_REPORT_RATE_MAP_MAX_ENTRIES) {
    const oldestKeys = [...cspRateWindows.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, Math.max(1, cspRateWindows.size - 4_500))
      .map(([key]) => key);

    oldestKeys.forEach((key) => cspRateWindows.delete(key));
  }

  if (!current || now - current.startedAt >= CSP_REPORT_RATE_WINDOW_MILLISECONDS) {
    cspRateWindows.set(requesterId, {
      startedAt: now,
      count: 1,
      lastSeenAt: now,
    });
    return true;
  }

  current.lastSeenAt = now;

  if (current.count >= CSP_REPORT_REQUESTS_PER_WINDOW) {
    return false;
  }

  current.count += 1;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value.trim().slice(0, maximumLength)
    : '';
}

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

function redactReportPath(pathname: string): string {
  return pathname
    .replace(/\/leagues\/[^/?#]+/gi, '/leagues/:leagueId')
    .replace(/\/players\/[^/?#]+/gi, '/players/:playerId')
    .replace(/\/assets\/[^/?#]+/gi, '/assets/:assetKey')
    .replace(/\/matchups\/[^/?#]+/gi, '/matchups/:matchupId')
    .replace(/\/users\/[^/?#]+/gi, '/users/:userId')
    .replace(/\/teams\/[^/?#]+/gi, '/teams/:teamId')
    .slice(0, 300);
}

function safeReportUrl(value: unknown): string {
  const rawValue = boundedString(value, 2_000);

  if (!rawValue) {
    return '';
  }

  if (['inline', 'eval', 'self', 'data', 'blob'].includes(rawValue.toLowerCase())) {
    return rawValue.toLowerCase();
  }

  try {
    const parsed = new URL(rawValue);
    return `${parsed.origin}${redactReportPath(parsed.pathname)}`.slice(0, 400);
  } catch {
    const relativePath = rawValue.replace(/[?#].*$/, '');
    return relativePath.startsWith('/')
      ? redactReportPath(relativePath)
      : '';
  }
}

function isRinkRatDocumentUri(value: string): boolean {
  if (!value) {
    return false;
  }

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'rinkratfantasy.com' ||
      hostname === 'www.rinkratfantasy.com' ||
      hostname === 'cycle-puck.web.app' ||
      hostname === 'cycle-puck.firebaseapp.com';
  } catch {
    return false;
  }
}

function normalizeCspViolation(value: unknown): NormalizedCspViolation | null {
  const root = asRecord(value);
  const legacyReport = asRecord(root['csp-report']);
  const report = Object.keys(legacyReport).length > 0
    ? legacyReport
    : asRecord(root['body']);
  const effectiveReport = Object.keys(report).length > 0 ? report : root;
  const documentUri = safeReportUrl(
    effectiveReport['document-uri'] ??
      effectiveReport['documentURL'] ??
      effectiveReport['documentUrl'],
  );

  if (!isRinkRatDocumentUri(documentUri)) {
    return null;
  }

  return {
    documentUri,
    blockedUri: safeReportUrl(
      effectiveReport['blocked-uri'] ??
        effectiveReport['blockedURL'] ??
        effectiveReport['blockedUrl'],
    ),
    violatedDirective: boundedString(
      effectiveReport['violated-directive'] ?? effectiveReport['violatedDirective'],
      160,
    ),
    effectiveDirective: boundedString(
      effectiveReport['effective-directive'] ?? effectiveReport['effectiveDirective'],
      160,
    ),
    sourceFile: safeReportUrl(
      effectiveReport['source-file'] ?? effectiveReport['sourceFile'],
    ),
    lineNumber: boundedNumber(
      effectiveReport['line-number'] ?? effectiveReport['lineNumber'],
    ),
    columnNumber: boundedNumber(
      effectiveReport['column-number'] ?? effectiveReport['columnNumber'],
    ),
    statusCode: boundedNumber(
      effectiveReport['status-code'] ?? effectiveReport['statusCode'],
    ),
    disposition: boundedString(effectiveReport['disposition'], 40) || 'report',
  };
}

function extractCspViolations(value: unknown): NormalizedCspViolation[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeCspViolation(entry))
      .filter((entry): entry is NormalizedCspViolation => entry !== null)
      .slice(0, 10);
  }

  const normalized = normalizeCspViolation(value);
  return normalized ? [normalized] : [];
}

function cspViolationFingerprint(violation: NormalizedCspViolation): string {
  return createHash('sha256')
    .update([
      violation.documentUri,
      violation.blockedUri,
      violation.effectiveDirective,
      violation.violatedDirective,
      violation.sourceFile,
    ].join('|'))
    .digest('hex')
    .slice(0, 32);
}

function cspDailyDocumentId(fingerprint: string): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${day}-${fingerprint}`;
}

async function saveCspViolation(
  violation: NormalizedCspViolation,
): Promise<void> {
  const fingerprint = cspViolationFingerprint(violation);
  const reference = db.doc(
    `cspViolationReports/${cspDailyDocumentId(fingerprint)}`,
  );
  const now = Timestamp.now();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const previousCount = typeof data['count'] === 'number'
      ? Math.max(0, Math.trunc(data['count']))
      : 0;

    transaction.set(
      reference,
      {
        schemaVersion: 1,
        fingerprint,
        documentUri: violation.documentUri,
        blockedUri: violation.blockedUri,
        violatedDirective: violation.violatedDirective,
        effectiveDirective: violation.effectiveDirective,
        sourceFile: violation.sourceFile,
        lineNumber: violation.lineNumber,
        columnNumber: violation.columnNumber,
        statusCode: violation.statusCode,
        disposition: violation.disposition,
        count: previousCount + 1,
        firstSeenAt: snapshot.exists
          ? data['firstSeenAt'] ?? now
          : now,
        lastSeenAt: now,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(
          Date.now() + CSP_REPORT_RETENTION_MILLISECONDS,
        ),
      },
      { merge: true },
    );
  });
}

async function recordCspReportHealth(reportCount: number): Promise<void> {
  const now = Timestamp.now();

  await db.doc('appData/securityOperations').set(
    {
      cspReportSchemaVersion: 1,
      cspReportReceivedCount: FieldValue.increment(reportCount),
      cspReportLastReceivedAt: now,
      cspReportLastBatchCount: reportCount,
      updatedAt: now,
    },
    { merge: true },
  );
}

function parseCspBody(rawBody: Buffer, parsedBody: unknown): unknown {
  if (rawBody.byteLength > CSP_REPORT_MAX_BYTES) {
    return null;
  }

  if (parsedBody && typeof parsedBody === 'object') {
    return parsedBody;
  }

  const text = rawBody.toString('utf8').trim();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const collectCspReport = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 15,
    memory: '256MiB',
    maxInstances: 5,
    cors: false,
  },
  async (request, response) => {
    response
      .set('Cache-Control', 'no-store')
      .set('X-Content-Type-Options', 'nosniff')
      .set('Referrer-Policy', 'no-referrer');

    if (request.method !== 'POST') {
      response.status(405).set('Allow', 'POST').end();
      return;
    }

    const requesterId = hashedRequesterIdentity({
      ip: request.ip,
      headers: request.headers as Record<string, string | string[] | undefined>,
    });

    if (
      !consumeCspGlobalRateLimit() ||
      !consumeCspRateLimit(requesterId)
    ) {
      response.status(204).end();
      return;
    }

    const contentType = headerValue(request.headers['content-type']).toLowerCase();
    if (
      contentType &&
      !contentType.includes('application/csp-report') &&
      !contentType.includes('application/reports+json') &&
      !contentType.includes('application/json')
    ) {
      response.status(204).end();
      return;
    }

    const parsedBody = parseCspBody(request.rawBody, request.body);
    const violations = extractCspViolations(parsedBody);

    if (violations.length === 0) {
      response.status(204).end();
      return;
    }

    try {
      await Promise.all(violations.map((violation) => saveCspViolation(violation)));
      await recordCspReportHealth(violations.length);
    } catch (error: unknown) {
      logger.error('CSP report could not be persisted.', {
        violationCount: violations.length,
        error,
      });
    }

    // Reporting endpoints should never create a retry storm in the browser.
    response.status(204).end();
  },
);

async function deleteExpiredDocumentsFromCollection(
  collectionName: string,
  now: Timestamp,
): Promise<number> {
  let deletedCount = 0;

  for (let pass = 0; pass < RETENTION_MAX_PASSES; pass += 1) {
    const snapshot = await db.collection(collectionName)
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'asc')
      .limit(RETENTION_QUERY_LIMIT)
      .get();

    if (snapshot.empty) {
      break;
    }

    if (collectionName === 'privacyRequestOperations') {
      const concurrency = 8;
      for (let index = 0; index < snapshot.docs.length; index += concurrency) {
        await Promise.all(
          snapshot.docs
            .slice(index, index + concurrency)
            .map((document) => db.recursiveDelete(document.ref)),
        );
      }
    } else {
      const batch = db.batch();
      for (const document of snapshot.docs) {
        batch.delete(document.ref);
      }
      await batch.commit();
    }

    deletedCount += snapshot.size;

    if (snapshot.size < RETENTION_QUERY_LIMIT) {
      break;
    }
  }

  return deletedCount;
}

function collectionResult(
  target: RetentionTarget,
  deletedCount: number,
): Record<string, unknown> {
  return {
    collection: target.collection,
    cleanupOwner: target.cleanupOwner,
    deletedCount,
  };
}

export const cleanupExpiredSecurityData = onSchedule(
  {
    schedule: '35 4 * * *',
    timeZone: 'UTC',
    region: FUNCTION_REGION,
    timeoutSeconds: 300,
    memory: '512MiB',
    maxInstances: 1,
  },
  async () => {
    const startedAt = Date.now();
    const now = Timestamp.now();
    const results: Array<Record<string, unknown>> = [];
    let deletedCount = 0;
    let failureCount = 0;

    for (const target of SECURITY_RETENTION_TARGETS) {
      if (target.cleanupOwner !== 'security-operations') {
        results.push(collectionResult(target, 0));
        continue;
      }

      try {
        const collectionDeletedCount = await deleteExpiredDocumentsFromCollection(
          target.collection,
          now,
        );
        deletedCount += collectionDeletedCount;
        results.push(collectionResult(target, collectionDeletedCount));
      } catch (error: unknown) {
        failureCount += 1;
        results.push({
          ...collectionResult(target, 0),
          status: 'error',
        });
        logger.error('Security retention cleanup failed for a collection.', {
          collection: target.collection,
          error,
        });
      }
    }

    const status = failureCount === 0 ? 'success' : 'partial-failure';
    const completedAt = Timestamp.now();

    const retentionHealth: Record<string, unknown> = {
      retentionSchemaVersion: 1,
      retentionCleanupStatus: status,
      retentionCleanupLastStartedAt: Timestamp.fromMillis(startedAt),
      retentionCleanupLastCompletedAt: completedAt,
      retentionCleanupDurationMilliseconds: Math.max(0, Date.now() - startedAt),
      retentionCleanupDeletedCount: deletedCount,
      retentionCleanupFailureCount: failureCount,
      retentionManagedCollectionCount: SECURITY_RETENTION_TARGETS.length,
      retentionCleanupResults: results,
      updatedAt: completedAt,
    };

    if (failureCount === 0) {
      retentionHealth['retentionCleanupLastSuccessfulAt'] = completedAt;
    }

    await db.doc('appData/securityOperations').set(
      retentionHealth,
      { merge: true },
    );

    logger.info('Security retention cleanup completed.', {
      status,
      deletedCount,
      failureCount,
      durationMilliseconds: Math.max(0, Date.now() - startedAt),
    });

    if (failureCount > 0) {
      throw new Error(`Security retention cleanup failed for ${failureCount} collection(s).`);
    }
  },
);

// Exported only for focused unit/source-contract tests.
export const SECURITY_RETENTION_COLLECTIONS = SECURITY_RETENTION_TARGETS.map(
  (target) => target.collection,
);
