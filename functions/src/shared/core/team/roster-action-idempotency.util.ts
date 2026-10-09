import { createHash } from 'node:crypto';

export const ROSTER_ACTION_SUBMISSION_SCHEMA_VERSION = 1;

export interface RosterActionSubmissionEvidence {
  schemaVersion: typeof ROSTER_ACTION_SUBMISSION_SCHEMA_VERSION;
  submissionId: string;
  requestFingerprint: string;
  result: Record<string, unknown>;
}

export type RosterActionSubmissionResolution =
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'match'; result: Record<string, unknown> };

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, entry]) => [key, stableNormalize(entry)]),
  );
}

export function createRosterActionRequestFingerprint(
  intent: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(stableNormalize(intent)))
    .digest('hex');
}

export function createRosterActionTransactionId(input: {
  namespace: 'roster-add' | 'automatic-injury-replacement';
  leagueId: string;
  ownerId: string;
  submissionId: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.namespace}:${input.leagueId}:${input.ownerId}:${input.submissionId}`)
    .digest('hex');

  return `roster-command-${digest.slice(0, 48)}`;
}

export function buildRosterActionSubmissionEvidence(input: {
  submissionId: string | null;
  requestFingerprint: string | null;
  result: Record<string, unknown>;
}): { rosterActionSubmission: RosterActionSubmissionEvidence } | Record<string, never> {
  if (!input.submissionId || !input.requestFingerprint) {
    return {};
  }

  return {
    rosterActionSubmission: {
      schemaVersion: ROSTER_ACTION_SUBMISSION_SCHEMA_VERSION,
      submissionId: input.submissionId,
      requestFingerprint: input.requestFingerprint,
      result: input.result,
    },
  };
}

export function resolveRosterActionSubmission(
  value: unknown,
  expectedSubmissionId: string | null,
  expectedRequestFingerprint: string | null,
): RosterActionSubmissionResolution {
  if (!expectedSubmissionId || !expectedRequestFingerprint) {
    return { status: 'missing' };
  }

  const document = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawEvidence = document['rosterActionSubmission'];

  if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
    return Object.keys(document).length > 0
      ? { status: 'conflict' }
      : { status: 'missing' };
  }

  const evidence = rawEvidence as Record<string, unknown>;
  if (
    evidence['schemaVersion'] !== ROSTER_ACTION_SUBMISSION_SCHEMA_VERSION ||
    evidence['submissionId'] !== expectedSubmissionId ||
    evidence['requestFingerprint'] !== expectedRequestFingerprint
  ) {
    return { status: 'conflict' };
  }

  const rawResult = evidence['result'];
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
    return { status: 'conflict' };
  }

  return {
    status: 'match',
    result: rawResult as Record<string, unknown>,
  };
}
