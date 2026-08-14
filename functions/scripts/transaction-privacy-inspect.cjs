#!/usr/bin/env node

const process = require('node:process');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, getFirestore } = require('firebase-admin/firestore');

const {
  buildPrivateTransactionProjection,
  buildPrivateWaiverClaimProjections,
  buildPublicTransactionResultProjection,
  buildPublicWaiverProjection,
  getPrivateTransactionDocumentId,
  getPublicTransactionResultDocumentId,
  getTransactionPrivacyFingerprint,
} = require('../lib/shared/core/league/league-activity.util.js');

const projectArgument = process.argv.find((value) => value.startsWith('--project='));
const leagueArgument = process.argv.find((value) => value.startsWith('--league='));
const projectId = (
  projectArgument?.slice('--project='.length) ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  ''
).trim();
const exactLeagueId = (leagueArgument?.slice('--league='.length) || '').trim();

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting transaction privacy projections.');
  process.exit(1);
}

if (exactLeagueId && !/^[A-Za-z0-9_-]{3,128}$/.test(exactLeagueId)) {
  console.error('The --league value is not a valid RinkRat league ID.');
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId });
}

const RELEASE = 'Social Batch C1B';
const AUTHORITY = 'transaction-privacy-authority';
const TRANSACTION_METADATA_FIELDS = new Set([
  'sourceFingerprint',
  'occurredAt',
  'projectedAt',
  'authority',
  'release',
]);
const WAIVER_METADATA_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'processedAt',
  'projectedAt',
  'authority',
  'release',
]);
const PUBLIC_FORBIDDEN_FIELDS = new Set([
  'claims',
  'claimOwnerIds',
  'claimedAt',
  'dropSlotId',
  'targetSlotId',
  'activeSlotId',
  'benchSlotId',
  'irSlotId',
  'waiverPriorityAtClaim',
  'queuedMoveId',
  'rosterSlotId',
  'requestId',
  'submissionId',
  'reason',
]);
const PRIVATE_FORBIDDEN_FIELDS = new Set([
  'claims',
  'claimOwnerIds',
  'waiverPriorityAtClaim',
  'requestId',
  'submissionId',
  'reason',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !(value instanceof Date) && typeof value.toDate !== 'function';
}

function isTimestampLike(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime());
  }
  return false;
}

function findForbiddenFields(value, forbidden, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenFields(entry, forbidden, `${prefix}[${index}]`));
  }

  const matches = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (forbidden.has(key)) matches.push(path);
    matches.push(...findForbiddenFields(child, forbidden, path));
  }
  return matches;
}

function comparePayload(expected, actual, path, issues) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      issues.push(`${path}: expected an array`);
      return;
    }
    if (expected.length !== actual.length) {
      issues.push(`${path}: expected ${expected.length} entries but found ${actual.length}`);
      return;
    }
    expected.forEach((entry, index) => comparePayload(entry, actual[index], `${path}[${index}]`, issues));
    return;
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      issues.push(`${path}: expected an object`);
      return;
    }
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.join('\0') !== actualKeys.join('\0')) {
      const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
      const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
      if (missing.length) issues.push(`${path}: missing sanitized fields ${missing.join(', ')}`);
      if (unexpected.length) issues.push(`${path}: unexpected sanitized fields ${unexpected.join(', ')}`);
    }
    for (const key of expectedKeys) {
      if (Object.prototype.hasOwnProperty.call(actual, key)) {
        comparePayload(expected[key], actual[key], `${path}.${key}`, issues);
      }
    }
    return;
  }

  if (!Object.is(expected, actual)) {
    issues.push(`${path}: expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}`);
  }
}

function compareProjectionDocument(options) {
  const {
    document,
    expected,
    metadataFields,
    forbiddenFields,
    expectedFingerprint,
    issues,
  } = options;
  const data = document.data();
  const payload = {};
  const expectedKeys = new Set(Object.keys(expected));
  const allowedTopLevelKeys = new Set([...expectedKeys, ...metadataFields]);

  for (const [key, value] of Object.entries(data)) {
    if (expectedKeys.has(key)) payload[key] = value;
    if (!allowedTopLevelKeys.has(key)) {
      issues.push(`${document.ref.path}: unexpected top-level field ${key}`);
    }
  }

  comparePayload(expected, payload, document.ref.path, issues);

  const forbidden = findForbiddenFields(data, forbiddenFields);
  if (forbidden.length) {
    issues.push(`${document.ref.path}: sensitive fields ${forbidden.join(', ')}`);
  }
  if (data.authority !== AUTHORITY) {
    issues.push(`${document.ref.path}: missing transaction-privacy authority marker`);
  }
  if (data.release !== RELEASE) {
    issues.push(`${document.ref.path}: expected release marker ${RELEASE}`);
  }
  if (!isTimestampLike(data.projectedAt)) {
    issues.push(`${document.ref.path}: projectedAt is missing or not a timestamp`);
  }
  if (expectedFingerprint !== undefined && data.sourceFingerprint !== expectedFingerprint) {
    issues.push(`${document.ref.path}: source fingerprint does not match the canonical document`);
  }
  if (metadataFields === TRANSACTION_METADATA_FIELDS && !isTimestampLike(data.occurredAt)) {
    issues.push(`${document.ref.path}: occurredAt is missing or not a timestamp`);
  }
}

async function readCollection(reference, pageSize = 250) {
  const documents = [];
  let cursor = null;

  for (;;) {
    let request = reference.orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor) request = request.startAfter(cursor);
    const snapshot = await request.get();
    documents.push(...snapshot.docs);
    if (snapshot.size < pageSize) return documents;
    cursor = snapshot.docs.at(-1);
  }
}

async function loadLeagueIds(db) {
  if (exactLeagueId) {
    const snapshot = await db.doc(`leagues/${exactLeagueId}`).get();
    if (!snapshot.exists) throw new Error(`League ${exactLeagueId} was not found.`);
    return [exactLeagueId];
  }
  return (await readCollection(db.collection('leagues'))).map((document) => document.id);
}

function compareMapKeys(expected, actual, label, issues) {
  for (const value of expected.keys()) {
    if (!actual.has(value)) issues.push(`Missing ${label}: ${value}`);
  }
  for (const value of actual.keys()) {
    if (!expected.has(value)) issues.push(`Unexpected ${label}: ${value}`);
  }
}

function mapDocuments(documents) {
  return new Map(documents.map((document) => [document.id, document]));
}

async function main() {
  const db = getFirestore();
  const leagueIds = await loadLeagueIds(db);
  const issues = [];
  const totals = {
    leagues: leagueIds.length,
    rawTransactions: 0,
    privateTransactions: 0,
    publicResults: 0,
    rawWaivers: 0,
    publicWaivers: 0,
    privateClaims: 0,
  };

  for (const leagueId of leagueIds) {
    const rawTransactions = await readCollection(db.collection(`leagues/${leagueId}/transactions`));
    const rawWaivers = await readCollection(db.collection(`leagues/${leagueId}/waivers`));
    const members = await readCollection(db.collection(`leagues/${leagueId}/members`));
    const expectedPrivateTransactions = new Map();
    const expectedPrivateClaims = new Map();
    const expectedPublicResults = new Map();
    const expectedPublicWaivers = new Map();

    totals.rawTransactions += rawTransactions.length;
    totals.rawWaivers += rawWaivers.length;

    for (const document of rawTransactions) {
      const source = document.data();
      const privateProjection = buildPrivateTransactionProjection(source);
      const publicProjection = buildPublicTransactionResultProjection(source);
      const fingerprint = getTransactionPrivacyFingerprint(document.id);

      if (!privateProjection && !publicProjection) {
        issues.push(`${leagueId}: unsupported canonical transaction ${document.id}`);
      }
      if (privateProjection) {
        const ownerMap = expectedPrivateTransactions.get(privateProjection.ownerId) || new Map();
        ownerMap.set(getPrivateTransactionDocumentId(document.id), {
          payload: privateProjection,
          fingerprint,
        });
        expectedPrivateTransactions.set(privateProjection.ownerId, ownerMap);
      }
      if (publicProjection) {
        expectedPublicResults.set(getPublicTransactionResultDocumentId(document.id), {
          payload: publicProjection,
          fingerprint,
        });
      }
    }

    for (const document of rawWaivers) {
      const source = document.data();
      const publicProjection = buildPublicWaiverProjection(document.id, source);
      if (!publicProjection) {
        issues.push(`${leagueId}: invalid canonical waiver ${document.id}`);
        continue;
      }
      expectedPublicWaivers.set(document.id, { payload: publicProjection });
      for (const claim of buildPrivateWaiverClaimProjections(document.id, source)) {
        const ownerMap = expectedPrivateClaims.get(claim.ownerId) || new Map();
        ownerMap.set(document.id, { payload: claim });
        expectedPrivateClaims.set(claim.ownerId, ownerMap);
      }
    }

    const publicResults = mapDocuments(
      await readCollection(db.collection(`leagues/${leagueId}/transactionResults`)),
    );
    const publicWaivers = mapDocuments(
      await readCollection(db.collection(`leagues/${leagueId}/waiverPool`)),
    );
    totals.publicResults += publicResults.size;
    totals.publicWaivers += publicWaivers.size;
    compareMapKeys(expectedPublicResults, publicResults, `${leagueId} public result`, issues);
    compareMapKeys(expectedPublicWaivers, publicWaivers, `${leagueId} public waiver`, issues);

    for (const [documentId, expected] of expectedPublicResults) {
      const document = publicResults.get(documentId);
      if (!document) continue;
      compareProjectionDocument({
        document,
        expected: expected.payload,
        metadataFields: TRANSACTION_METADATA_FIELDS,
        forbiddenFields: PUBLIC_FORBIDDEN_FIELDS,
        expectedFingerprint: expected.fingerprint,
        issues,
      });
    }

    for (const [documentId, expected] of expectedPublicWaivers) {
      const document = publicWaivers.get(documentId);
      if (!document) continue;
      compareProjectionDocument({
        document,
        expected: expected.payload,
        metadataFields: WAIVER_METADATA_FIELDS,
        forbiddenFields: PUBLIC_FORBIDDEN_FIELDS,
        issues,
      });
    }

    const memberIds = new Set(members.map((document) => document.id));
    for (const ownerId of new Set([
      ...memberIds,
      ...expectedPrivateTransactions.keys(),
      ...expectedPrivateClaims.keys(),
    ])) {
      const privateTransactions = mapDocuments(
        await readCollection(db.collection(`leagues/${leagueId}/members/${ownerId}/transactions`)),
      );
      const privateClaims = mapDocuments(
        await readCollection(db.collection(`leagues/${leagueId}/members/${ownerId}/waiverClaims`)),
      );
      const expectedTransactions = expectedPrivateTransactions.get(ownerId) || new Map();
      const expectedClaims = expectedPrivateClaims.get(ownerId) || new Map();
      totals.privateTransactions += privateTransactions.size;
      totals.privateClaims += privateClaims.size;
      compareMapKeys(
        expectedTransactions,
        privateTransactions,
        `${leagueId}/${ownerId} private transaction`,
        issues,
      );
      compareMapKeys(
        expectedClaims,
        privateClaims,
        `${leagueId}/${ownerId} private claim`,
        issues,
      );

      for (const [documentId, expected] of expectedTransactions) {
        const document = privateTransactions.get(documentId);
        if (!document) continue;
        compareProjectionDocument({
          document,
          expected: expected.payload,
          metadataFields: TRANSACTION_METADATA_FIELDS,
          forbiddenFields: PRIVATE_FORBIDDEN_FIELDS,
          expectedFingerprint: expected.fingerprint,
          issues,
        });
        if (document.data().ownerId !== ownerId) {
          issues.push(`${document.ref.path}: ownerId does not match the private path`);
        }
      }

      for (const [documentId, expected] of expectedClaims) {
        const document = privateClaims.get(documentId);
        if (!document) continue;
        compareProjectionDocument({
          document,
          expected: expected.payload,
          metadataFields: WAIVER_METADATA_FIELDS,
          forbiddenFields: PRIVATE_FORBIDDEN_FIELDS,
          issues,
        });
        if (document.data().ownerId !== ownerId) {
          issues.push(`${document.ref.path}: ownerId does not match the private path`);
        }
      }
    }

    console.log(
      `${leagueId}: raw ${rawTransactions.length} transactions / ${rawWaivers.length} waivers; ` +
      `projected ${publicResults.size} public results / ${publicWaivers.size} public waivers.`,
    );
  }

  console.log(`\nTransaction privacy inspection for ${projectId}:`);
  console.log(`- Leagues: ${totals.leagues}`);
  console.log(`- Raw transactions: ${totals.rawTransactions}`);
  console.log(`- Owner-private transactions: ${totals.privateTransactions}`);
  console.log(`- Public completed results: ${totals.publicResults}`);
  console.log(`- Raw waivers: ${totals.rawWaivers}`);
  console.log(`- Public waiver pool entries: ${totals.publicWaivers}`);
  console.log(`- Owner-private claim records: ${totals.privateClaims}`);
  console.log(`- Privacy issues: ${issues.length}`);

  if (issues.length) {
    for (const issue of issues.slice(0, 100)) console.error(`  - ${issue}`);
    if (issues.length > 100) console.error(`  - ...and ${issues.length - 100} more`);
    throw new Error('Transaction privacy projections are not ready for the browser Rules cutover.');
  }

  console.log('\nPrivacy projection inspection passed.');
  console.log('Inspection only. No raw transaction, waiver, league, score, or production setting was changed.');
}

main().catch((error) => {
  console.error('Transaction privacy inspection failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
