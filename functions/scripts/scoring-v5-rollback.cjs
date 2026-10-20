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
  SCORING_RULES_V3_VERSION,
  SCORING_RULES_V4_VERSION,
  SCORING_RULES_V5_VERSION,
  scoringRulesV3,
  scoringRulesV4,
  scoringRulesV5,
} = require('../lib/shared/core/scoring/scoring-rules.js');
const {
  classifyPreseasonScoringTransition,
  isProjectionPointerId,
  normalizeDraftStatus,
} = require('./scoring-v5-migration.util.cjs');

const RELEASE = 'Scoring V5 Shootout';
const AUTHORITY = 'scoring-v5-rollback-authority';
const APPLY_GUARD = 'RINKRAT_ROLLBACK_SCORING_V5';
const APPLY_VALUE = 'ROLLBACK_PRESEASON_ONLY';

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
const apply = process.env[APPLY_GUARD] === APPLY_VALUE;

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting or rolling back Scoring V5.');
  process.exit(1);
}
if (exactLeagueId && !/^[A-Za-z0-9_-]{3,128}$/.test(exactLeagueId)) {
  console.error('The --league value is not a valid RinkRat league ID.');
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
    const alreadyV4 = scoringMatches(data, SCORING_RULES_V4_VERSION, scoringRulesV4);
    const canonicalV3 = scoringMatches(data, SCORING_RULES_V3_VERSION, scoringRulesV3);
    const canonicalV5 = scoringMatches(data, SCORING_RULES_V5_VERSION, scoringRulesV5);
    const classification = classifyPreseasonScoringTransition({
      alreadyTarget: alreadyV4,
      canonicalSource: canonicalV5,
      cycleCount: state.cycleCount,
      pickCount: state.pickCount,
      draftStatus: state.draftStatus,
    });

    plans.push({
      leagueDocument,
      data,
      state,
      alreadyV4,
      canonicalV3,
      canonicalV5,
      classification,
    });

    console.log(
      `${leagueDocument.id}: Scoring V${data.scoringRulesVersion ?? 'legacy'}; ` +
      `${alreadyV4
        ? 'already canonical V4'
        : canonicalV5
          ? 'canonical V5 rollback candidate'
          : canonicalV3
            ? 'supported legacy V3 preserved'
            : 'noncanonical V5 source'}; ` +
      `Draft ${state.draftStatus}; ${state.pickCount > 0 ? 'at least one' : 'no'} pick(s); ` +
      `${state.cycleCount > 0 ? 'at least one' : 'no'} cycle document(s); ` +
      `${state.projectionPointerRefs.length} mutable projection pointer(s); ` +
      `blockers: ${formatBlockers(classification.blockers)}.`,
    );
  }

  const blockers = plans.filter(
    (plan) => !plan.classification.eligible && !plan.canonicalV3,
  );
  if (blockers.length > 0) {
    console.error('\nScoring V5 rollback stopped before any write.');
    blockers.forEach((plan) => {
      console.error(`- ${plan.leagueDocument.id}: ${formatBlockers(plan.classification.blockers)}`);
    });
    console.error('\nRollback is allowed only from canonical V5 to canonical V4 before any Draft pick or competition cycle exists and only while the Draft is missing, setup, or scheduled.');
    console.error('There is no mixed-history override.');
    throw new Error(`${blockers.length} league(s) are not eligible for the V5-to-V4 rollback.`);
  }

  const updates = plans.filter((plan) => plan.canonicalV5 && plan.classification.eligible);

  if (!apply) {
    console.log(`\nScoring V5 rollback dry run for ${projectId}:`);
    console.log(`- Leagues inspected: ${plans.length}`);
    console.log(`- Already canonical V4: ${plans.filter((plan) => plan.alreadyV4).length}`);
    console.log(`- Supported legacy V3 preserved: ${plans.filter((plan) => plan.canonicalV3).length}`);
    console.log(`- Would restore V5 to V4: ${updates.length}`);
    console.log(`- Mutable projection pointers that would be invalidated: ${updates.reduce((total, plan) => total + plan.state.projectionPointerRefs.length, 0)}`);
    console.log('- Dry run only. No data was changed.');
    console.log(`- Set ${APPLY_GUARD}=${APPLY_VALUE} only before any Draft pick or competition cycle exists.`);
    return;
  }

  let rolledBackLeagueCount = 0;
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
        throw new Error(`League ${leagueId} disappeared before rollback commit.`);
      }
      if (projectionDocuments.size > 200) {
        throw new Error(
          `League ${leagueId} has more than 200 projection documents; rollback stopped before a partial invalidation.`,
        );
      }

      const data = leagueDocument.data();
      const alreadyV4 = scoringMatches(
        data,
        SCORING_RULES_V4_VERSION,
        scoringRulesV4,
      );
      const canonicalV5 = scoringMatches(
        data,
        SCORING_RULES_V5_VERSION,
        scoringRulesV5,
      );
      const classification = classifyPreseasonScoringTransition({
        alreadyTarget: alreadyV4,
        canonicalSource: canonicalV5,
        cycleCount: cycles.size,
        pickCount: picks.size,
        draftStatus: normalizeDraftStatus(draft.exists ? draft.data()?.status : null),
      });

      if (alreadyV4) {
        return { rolledBack: false, invalidatedProjectionPointerCount: 0 };
      }
      if (!classification.eligible || !canonicalV5) {
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
          scoringRules: scoringRulesV4,
          scoringRulesVersion: SCORING_RULES_V4_VERSION,
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
              'Scoring restored to V4 before competition. Regenerate and save the verified Projection V11 Draft board before opening the Draft.',
            serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      projectionPointerRefs.forEach((reference) => transaction.delete(reference));

      transaction.set(
        db.doc(`leagues/${leagueId}/audit/scoring-v5-rollback`),
        {
          schemaVersion: 1,
          action: 'scoring-v5-rolled-back-to-v4-before-competition',
          authority: AUTHORITY,
          release: RELEASE,
          fromVersion: SCORING_RULES_V5_VERSION,
          toVersion: SCORING_RULES_V4_VERSION,
          previousRulesFingerprint: fingerprint(data.scoringRules ?? null),
          restoredRulesFingerprint: fingerprint(scoringRulesV4),
          existingDraftStatus: classification.draftStatus,
          existingDraftPickCount: 0,
          existingCycleCount: 0,
          invalidatedProjectionPointerCount: projectionPointerRefs.length,
          immutableCompletedWindowsRewritten: false,
          projectionFormulaChanged: false,
          projectionAssetsRewritten: false,
          occurredAt: FieldValue.serverTimestamp(),
        },
      );

      return {
        rolledBack: true,
        invalidatedProjectionPointerCount: projectionPointerRefs.length,
      };
    });

    if (result.rolledBack) rolledBackLeagueCount += 1;
    invalidatedProjectionPointerCount += result.invalidatedProjectionPointerCount;
  }

  console.log(`\nScoring V5 preseason rollback applied for ${projectId}:`);
  console.log(`- Leagues restored from V5 to V4: ${rolledBackLeagueCount}`);
  console.log(`- Already V4: ${plans.filter((plan) => plan.alreadyV4).length}`);
  console.log(`- Mutable projection pointers invalidated: ${invalidatedProjectionPointerCount}`);
  console.log('- Only current/target projection pointers were invalidated; immutable Projection V11 snapshot documents were retained.');
  console.log('- No score, cycle, window, standing, roster, Draft-pick, transaction, or waiver document was rewritten.');
}

main().catch((error) => {
  console.error('Scoring V5 preseason rollback failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
