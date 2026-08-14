#!/usr/bin/env node

const process = require('node:process');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const {
  FieldPath,
  FieldValue,
  Timestamp,
  getFirestore,
} = require('firebase-admin/firestore');

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
const apply = process.env.RINKRAT_APPLY_TRANSACTION_PRIVACY === 'APPLY';

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting or applying transaction privacy projections.');
  process.exit(1);
}

if (exactLeagueId && !/^[A-Za-z0-9_-]{3,128}$/.test(exactLeagueId)) {
  console.error('The --league value is not a valid RinkRat league ID.');
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId });
}

function asTimestamp(value) {
  if (value instanceof Timestamp) return value;
  if (value && typeof value.toDate === 'function') return Timestamp.fromDate(value.toDate());
  if (value instanceof Date && Number.isFinite(value.getTime())) return Timestamp.fromDate(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return Timestamp.fromDate(parsed);
  }
  return Timestamp.now();
}

async function forEachDocument(reference, callback, pageSize = 250) {
  let cursor = null;

  for (;;) {
    let request = reference.orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor) request = request.startAfter(cursor);
    const snapshot = await request.get();

    for (const document of snapshot.docs) {
      await callback(document);
    }

    if (snapshot.size < pageSize) return;
    cursor = snapshot.docs.at(-1);
  }
}

async function loadLeagueIds(db) {
  if (exactLeagueId) {
    const snapshot = await db.doc(`leagues/${exactLeagueId}`).get();
    if (!snapshot.exists) {
      throw new Error(`League ${exactLeagueId} was not found.`);
    }
    return [exactLeagueId];
  }

  const leagueIds = [];
  await forEachDocument(db.collection('leagues'), async (document) => {
    leagueIds.push(document.id);
  });
  return leagueIds;
}

async function main() {
  const db = getFirestore();
  const leagueIds = await loadLeagueIds(db);
  const writer = apply ? db.bulkWriter() : null;
  const invalidPaths = [];
  const totals = {
    leagues: leagueIds.length,
    rawTransactions: 0,
    privateTransactions: 0,
    publicTransactionResults: 0,
    rawWaivers: 0,
    publicWaivers: 0,
    privateClaims: 0,
    invalidTransactions: 0,
    invalidWaivers: 0,
  };

  writer?.onWriteError((error) => {
    if (error.failedAttempts < 4) return true;
    console.error(`Projection write failed at ${error.documentRef.path}: ${error.message}`);
    return false;
  });

  for (const leagueId of leagueIds) {
    const leagueCounts = {
      rawTransactions: 0,
      privateTransactions: 0,
      publicTransactionResults: 0,
      rawWaivers: 0,
      publicWaivers: 0,
      privateClaims: 0,
      invalidTransactions: 0,
      invalidWaivers: 0,
    };

    await forEachDocument(
      db.collection(`leagues/${leagueId}/transactions`),
      async (document) => {
        const source = document.data();
        const occurredAt = asTimestamp(source.createdAt);
        const fingerprint = getTransactionPrivacyFingerprint(document.id);
        const privateProjection = buildPrivateTransactionProjection(source);
        const publicProjection = buildPublicTransactionResultProjection(source);
        leagueCounts.rawTransactions += 1;

        if (privateProjection) {
          leagueCounts.privateTransactions += 1;
          writer?.set(
            db.doc(
              `leagues/${leagueId}/members/${privateProjection.ownerId}/transactions/${getPrivateTransactionDocumentId(document.id)}`,
            ),
            {
              ...privateProjection,
              sourceFingerprint: fingerprint,
              occurredAt,
              projectedAt: FieldValue.serverTimestamp(),
              authority: 'transaction-privacy-authority',
              release: 'Social Batch C1B',
            },
          );
        }

        if (publicProjection) {
          leagueCounts.publicTransactionResults += 1;
          writer?.set(
            db.doc(
              `leagues/${leagueId}/transactionResults/${getPublicTransactionResultDocumentId(document.id)}`,
            ),
            {
              ...publicProjection,
              sourceFingerprint: fingerprint,
              occurredAt,
              projectedAt: FieldValue.serverTimestamp(),
              authority: 'transaction-privacy-authority',
              release: 'Social Batch C1B',
            },
          );
        }

        if (!privateProjection && !publicProjection) {
          leagueCounts.invalidTransactions += 1;
          if (invalidPaths.length < 100) invalidPaths.push(document.ref.path);
        }
      },
    );

    await forEachDocument(
      db.collection(`leagues/${leagueId}/waivers`),
      async (document) => {
        const source = document.data();
        const publicProjection = buildPublicWaiverProjection(document.id, source);
        const privateClaims = buildPrivateWaiverClaimProjections(document.id, source);
        leagueCounts.rawWaivers += 1;

        if (!publicProjection) {
          leagueCounts.invalidWaivers += 1;
          if (invalidPaths.length < 100) invalidPaths.push(document.ref.path);
          return;
        }

        leagueCounts.publicWaivers += 1;
        leagueCounts.privateClaims += privateClaims.length;
        writer?.set(
          db.doc(`leagues/${leagueId}/waiverPool/${document.id}`),
          {
            ...publicProjection,
            createdAt: source.createdAt ?? null,
            updatedAt: source.updatedAt ?? null,
            processedAt: source.processedAt ?? null,
            projectedAt: FieldValue.serverTimestamp(),
            authority: 'transaction-privacy-authority',
            release: 'Social Batch C1B',
          },
        );

        for (const claim of privateClaims) {
          writer?.set(
            db.doc(
              `leagues/${leagueId}/members/${claim.ownerId}/waiverClaims/${document.id}`,
            ),
            {
              ...claim,
              createdAt: source.createdAt ?? null,
              updatedAt: source.updatedAt ?? null,
              processedAt: source.processedAt ?? null,
              projectedAt: FieldValue.serverTimestamp(),
              authority: 'transaction-privacy-authority',
              release: 'Social Batch C1B',
            },
          );
        }
      },
    );

    for (const key of Object.keys(leagueCounts)) totals[key] += leagueCounts[key];
    console.log(
      `${leagueId}: ${leagueCounts.rawTransactions} transactions -> ` +
      `${leagueCounts.privateTransactions} private / ${leagueCounts.publicTransactionResults} public; ` +
      `${leagueCounts.rawWaivers} waivers -> ${leagueCounts.publicWaivers} public / ` +
      `${leagueCounts.privateClaims} private claims; invalid ` +
      `${leagueCounts.invalidTransactions + leagueCounts.invalidWaivers}.`,
    );
  }

  if (totals.invalidTransactions > 0 || totals.invalidWaivers > 0) {
    await writer?.close();
    console.error('Unsupported or invalid canonical records:');
    for (const path of invalidPaths) console.error(`  - ${path}`);
    if (totals.invalidTransactions + totals.invalidWaivers > invalidPaths.length) {
      console.error(`  - ...and ${totals.invalidTransactions + totals.invalidWaivers - invalidPaths.length} more`);
    }
    throw new Error(
      `Projection preparation found ${totals.invalidTransactions} unsupported transactions and ` +
      `${totals.invalidWaivers} invalid waivers. Inspect those canonical records before applying the privacy cutover.`,
    );
  }

  await writer?.close();

  console.log(`\nTransaction privacy projection ${apply ? 'apply' : 'dry run'} for ${projectId}:`);
  console.log(`- Leagues: ${totals.leagues}`);
  console.log(`- Raw transactions inspected: ${totals.rawTransactions}`);
  console.log(`- Owner-private transaction projections: ${totals.privateTransactions}`);
  console.log(`- Public completed-result projections: ${totals.publicTransactionResults}`);
  console.log(`- Raw waivers inspected: ${totals.rawWaivers}`);
  console.log(`- Public waiver-pool projections: ${totals.publicWaivers}`);
  console.log(`- Owner-private claim projections: ${totals.privateClaims}`);

  if (!apply) {
    console.log('\nDry run only. Set RINKRAT_APPLY_TRANSACTION_PRIVACY=APPLY to write projections after the Functions deployment.');
  } else {
    console.log('\nPrivacy projections applied. Canonical transaction and waiver records were not changed.');
  }
}

main().catch((error) => {
  console.error('Transaction privacy projection backfill failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
