#!/usr/bin/env node
'use strict';

const process = require('node:process');
const { createHash } = require('node:crypto');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const {
  FieldPath,
  FieldValue,
  getFirestore,
} = require('firebase-admin/firestore');

const {
  SCORING_RULES_V4_VERSION,
  SCORING_RULES_V5_VERSION,
  scoringRulesV4,
  scoringRulesV5,
} = require('../lib/shared/core/scoring/scoring-rules.js');
const {
  classifyPreseasonScoringTransition,
  isProjectionPointerId,
  normalizeDraftStatus,
} = require('./scoring-v5-migration.util.cjs');

const RELEASE = 'Scoring V5 Shootout';
const AUTHORITY = 'scoring-v5-migration-authority';
const APPLY_GUARD = 'RINKRAT_APPLY_SCORING_V5';
const APPLY_VALUE = 'APPLY_PRESEASON_ONLY';

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
const eligibleOnly = process.argv.includes('--eligible-only');
const apply = process.env[APPLY_GUARD] === APPLY_VALUE;

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting or applying Scoring V5.');
  process.exit(1);
}
if (exactLeagueId && !/^[A-Za-z0-9_-]{3,128}$/.test(exactLeagueId)) {
  console.error('The --league value is not a valid RinkRat league ID.');
  process.exit(1);
}
if (eligibleOnly && exactLeagueId) {
  console.error('--eligible-only is a global migration option and cannot be combined with --league.');
  process.exit(1);
}
if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId });

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Scoring rules contain a non-finite number.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return undefined;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

async function readAll(reference, pageSize = 250) {
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

async function loadLeagues(db) {
  if (exactLeagueId) {
    const snapshot = await db.doc(`leagues/${exactLeagueId}`).get();
    if (!snapshot.exists) throw new Error(`League ${exactLeagueId} was not found.`);
    return [snapshot];
  }
  return readAll(db.collection('leagues'));
}

function scoringMatches(data, version, rules) {
  return data.scoringRulesVersion === version &&
    stableJson(data.scoringRules) === stableJson(rules);
}

async function inspectCompetitionState(db, leagueId) {
  const [cycles, draft, picks, projectionDocuments] = await Promise.all([
    db.collection(`leagues/${leagueId}/cycles`).limit(1).get(),
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    db.collection(`leagues/${leagueId}/draft/current/picks`).limit(1).get(),
    readAll(db.collection(`leagues/${leagueId}/projectionSnapshots`)),
  ]);

  return {
    cycleCount: cycles.size,
    draftExists: draft.exists,
    draftStatus: normalizeDraftStatus(draft.exists ? draft.data()?.status : null),
    draftRef: draft.ref,
    pickCount: picks.size,
    projectionPointerRefs: projectionDocuments
      .filter((document) => isProjectionPointerId(document.id))
      .map((document) => document.ref),
  };
}

function formatBlockers(blockers) {
  return blockers.length ? blockers.join(', ') : 'none';
}

async function main() {
  const db = getFirestore();
  const leagues = await loadLeagues(db);
  const plans = [];

  for (const leagueDocument of leagues) {
    const data = leagueDocument.data();
    const state = await inspectCompetitionState(db, leagueDocument.id);
    const canonicalV4 = scoringMatches(data, SCORING_RULES_V4_VERSION, scoringRulesV4);
    const alreadyV5 = scoringMatches(data, SCORING_RULES_V5_VERSION, scoringRulesV5);
    const classification = classifyPreseasonScoringTransition({
      alreadyTarget: alreadyV5,
      canonicalSource: canonicalV4,
      cycleCount: state.cycleCount,
      pickCount: state.pickCount,
      draftStatus: state.draftStatus,
    });

    plans.push({
      leagueDocument,
      data,
      state,
      canonicalV4,
      alreadyV5,
      classification,
    });

    console.log(
      `${leagueDocument.id}: Scoring V${data.scoringRulesVersion ?? 'legacy'}; ` +
      `${alreadyV5 ? 'already canonical V5' : canonicalV4 ? 'canonical V4 migration candidate' : 'noncanonical V4 source'}; ` +
      `Draft ${state.draftStatus}; ${state.pickCount > 0 ? 'at least one' : 'no'} pick(s); ` +
      `${state.cycleCount > 0 ? 'at least one' : 'no'} cycle document(s); ` +
      `${state.projectionPointerRefs.length} mutable projection pointer(s); ` +
      `blockers: ${formatBlockers(classification.blockers)}.`,
    );
  }

  const blockers = plans.filter((plan) => !plan.classification.eligible);
  if (blockers.length > 0 && !eligibleOnly) {
    console.error('\nScoring V5 migration stopped before any write.');
    blockers.forEach((plan) => {
      console.error(`- ${plan.leagueDocument.id}: ${formatBlockers(plan.classification.blockers)}`);
    });
    console.error('\nA league may migrate from canonical V4 only before any Draft pick or competition cycle exists and only while its Draft is missing, setup, or scheduled.');
    console.error('There is no mixed-history override. Preserve every started league on its existing scoring contract.');
    console.error('For a global preseason pass that skips ineligible leagues, add --eligible-only.');
    throw new Error(`${blockers.length} league(s) are not eligible for the V4-to-V5 transition.`);
  }

  if (blockers.length > 0 && eligibleOnly) {
    console.log(`\n--eligible-only will skip ${blockers.length} blocked league(s) and will not alter their scoring contract.`);
    blockers.forEach((plan) => {
      console.log(`- Skipping ${plan.leagueDocument.id}: ${formatBlockers(plan.classification.blockers)}`);
    });
  }

  const updates = plans.filter((plan) => plan.canonicalV4 && plan.classification.eligible);

  if (!apply) {
    console.log(`\nScoring V5 dry run for ${projectId}:`);
    console.log(`- Leagues inspected: ${plans.length}`);
    console.log(`- Already V5: ${plans.filter((plan) => plan.alreadyV5).length}`);
    console.log(`- Blocked/skipped: ${blockers.length}`);
    console.log(`- Would migrate V4 to V5: ${updates.length}`);
    console.log(`- Mutable projection pointers that would be invalidated: ${updates.reduce((total, plan) => total + plan.state.projectionPointerRefs.length, 0)}`);
    console.log('- Dry run only. No league, score, cycle, window, standing, roster, Draft pick, transaction, waiver, or immutable projection snapshot was changed.');
    console.log(`- Set ${APPLY_GUARD}=${APPLY_VALUE} only after reviewing every league above.`);
    return;
  }

  let migratedLeagueCount = 0;
  let invalidatedProjectionPointerCount = 0;

  for (const plan of updates) {
    const result = await db.runTransaction(async (transaction) => {
      const leagueId = plan.leagueDocument.id;
      const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
      const [leagueDocument, cycles, draft, picks, projectionDocuments] =
        await Promise.all([
          transaction.get(plan.leagueDocument.ref),
          transaction.get(db.collection(`leagues/${leagueId}/cycles`).limit(1)),
          transaction.get(draftRef),
          transaction.get(
            db.collection(`leagues/${leagueId}/draft/current/picks`).limit(1),
          ),
          transaction.get(
            db.collection(`leagues/${leagueId}/projectionSnapshots`)
              .orderBy(FieldPath.documentId())
              .limit(201),
          ),
        ]);

      if (!leagueDocument.exists) {
        throw new Error(`League ${leagueId} disappeared before migration commit.`);
      }
      if (projectionDocuments.size > 200) {
        throw new Error(
          `League ${leagueId} has more than 200 projection documents; migration stopped before a partial invalidation.`,
        );
      }

      const data = leagueDocument.data();
      const canonicalV4 = scoringMatches(
        data,
        SCORING_RULES_V4_VERSION,
        scoringRulesV4,
      );
      const alreadyV5 = scoringMatches(
        data,
        SCORING_RULES_V5_VERSION,
        scoringRulesV5,
      );
      const classification = classifyPreseasonScoringTransition({
        alreadyTarget: alreadyV5,
        canonicalSource: canonicalV4,
        cycleCount: cycles.size,
        pickCount: picks.size,
        draftStatus: normalizeDraftStatus(draft.exists ? draft.data()?.status : null),
      });

      if (alreadyV5) {
        return { migrated: false, invalidatedProjectionPointerCount: 0 };
      }
      if (!classification.eligible || !canonicalV4) {
        throw new Error(
          `League ${leagueId} changed after inspection; blockers: ${formatBlockers(classification.blockers)}.`,
        );
      }

      const projectionPointerRefs = projectionDocuments.docs
        .filter((document) => isProjectionPointerId(document.id))
        .map((document) => document.ref);

      transaction.set(
        leagueDocument.ref,
        {
          scoringRules: scoringRulesV5,
          scoringRulesVersion: SCORING_RULES_V5_VERSION,
          scoringRulesUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (draft.exists) {
        transaction.set(
          draftRef,
          {
            projectionPreparationRequestId: null,
            projectionPreparationStatus: 'error',
            serverDraftReadinessStatus: null,
            serverDraftReadinessScheduledStartAt: null,
            serverDraftReadinessAvailabilityRevision: null,
            serverDraftReadinessProjectionRequestId: null,
            serverDraftReadinessProjectionSnapshotId: null,
            serverDraftReadinessProjectionSnapshotHash: null,
            serverDraftReadinessAttemptCount: 0,
            serverDraftReadinessRetryAfterAt: null,
            serverDraftReadinessMessage: null,
            serverDraftReadinessUpdatedAt: FieldValue.serverTimestamp(),
            serverDraftProjectionSnapshotId: null,
            serverDraftProjectionSnapshotHash: null,
            serverDraftProjectionAuthorityVersion: null,
            serverDraftProjectionCatalogHash: null,
            serverAutomationMessage:
              'Scoring migrated to V5 before competition. Regenerate and save the verified Projection V11 Draft board before opening the Draft.',
            serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      projectionPointerRefs.forEach((reference) => transaction.delete(reference));

      transaction.set(
        db.doc(`leagues/${leagueId}/audit/scoring-v5-upgrade`),
        {
          schemaVersion: 1,
          action: 'scoring-v4-upgraded-to-v5-before-competition',
          authority: AUTHORITY,
          release: RELEASE,
          fromVersion: SCORING_RULES_V4_VERSION,
          toVersion: SCORING_RULES_V5_VERSION,
          previousRulesFingerprint: fingerprint(data.scoringRules ?? null),
          scoringRulesFingerprint: fingerprint(scoringRulesV5),
          existingDraftStatus: classification.draftStatus,
          existingDraftPickCount: 0,
          existingCycleCount: 0,
          invalidatedProjectionPointerCount: projectionPointerRefs.length,
          shootoutCategoryAdded: true,
          immutableCompletedWindowsRewritten: false,
          projectionFormulaChanged: false,
          projectionAssetsRewritten: false,
          occurredAt: FieldValue.serverTimestamp(),
        },
      );

      return {
        migrated: true,
        invalidatedProjectionPointerCount: projectionPointerRefs.length,
      };
    });

    if (result.migrated) migratedLeagueCount += 1;
    invalidatedProjectionPointerCount += result.invalidatedProjectionPointerCount;
  }

  console.log(`\nScoring V5 applied for ${projectId}:`);
  console.log(`- Leagues migrated from V4 to V5: ${migratedLeagueCount}`);
  console.log(`- Already V5: ${plans.filter((plan) => plan.alreadyV5).length}`);
  console.log(`- Blocked/skipped: ${blockers.length}`);
  console.log(`- Mutable projection pointers invalidated: ${invalidatedProjectionPointerCount}`);
  console.log('- Only current/target projection pointers were invalidated; immutable Projection V11 snapshot documents were retained as evidence.');
  console.log('- No score, cycle, window, standing, roster, Draft-pick, transaction, or waiver document was rewritten.');
  console.log('- Regenerate and verify each migrated league Projection V11 snapshot before opening its Draft.');
}

main().catch((error) => {
  console.error('Scoring V5 migration failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
