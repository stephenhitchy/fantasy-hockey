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
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
} = require('../lib/shared/core/scoring/scoring-rules.js');
const {
  classifyScoringV4Migration,
  isProjectionPointerId,
  normalizeDraftStatus,
} = require('./scoring-v4-migration.util.cjs');

const RELEASE = 'Scoring Batch V4A';
const AUTHORITY = 'scoring-v4-migration-authority';
const APPLY_GUARD = 'RINKRAT_APPLY_SCORING_V4';
const MIXED_HISTORY_GUARD = 'RINKRAT_ALLOW_MIXED_SCORING_HISTORY';
const MIXED_HISTORY_VALUE = 'ALLOW_TEST_LEAGUE_ONLY';

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
const apply = process.env[APPLY_GUARD] === 'APPLY';
const allowMixedHistory =
  exactLeagueId.length > 0 &&
  process.env[MIXED_HISTORY_GUARD] === MIXED_HISTORY_VALUE;

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting or applying Production Scoring V4.');
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

if (eligibleOnly && process.env[MIXED_HISTORY_GUARD]) {
  console.error('--eligible-only cannot be combined with the disposable mixed-history override.');
  process.exit(1);
}

if (process.env[MIXED_HISTORY_GUARD] && !exactLeagueId) {
  console.error(`${MIXED_HISTORY_GUARD} is allowed only with one exact --league disposable test league.`);
  process.exit(1);
}

if (
  process.env[MIXED_HISTORY_GUARD] &&
  process.env[MIXED_HISTORY_GUARD] !== MIXED_HISTORY_VALUE
) {
  console.error(`${MIXED_HISTORY_GUARD} must equal ${MIXED_HISTORY_VALUE}.`);
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId });
}

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

function scoringMatchesV4(data) {
  return data.scoringRulesVersion === CURRENT_SCORING_RULES_VERSION &&
    stableJson(data.scoringRules) === stableJson(defaultScoringRules);
}

async function inspectCompetitionState(db, leagueId) {
  const [cycles, draft, picks, projectionDocuments] = await Promise.all([
    db.collection(`leagues/${leagueId}/cycles`).limit(100).get(),
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    db.collection(`leagues/${leagueId}/draft/current/picks`).limit(100).get(),
    readAll(db.collection(`leagues/${leagueId}/projectionSnapshots`)),
  ]);
  const completedCycles = cycles.docs.filter((document) => {
    const data = document.data();
    return data.status === 'complete' || data.completedAt != null || data.finalizedAt != null;
  }).length;
  const draftStatus = normalizeDraftStatus(draft.exists ? draft.data()?.status : null);
  const projectionPointerRefs = projectionDocuments
    .filter((document) => isProjectionPointerId(document.id))
    .map((document) => document.ref);

  return {
    cycleCount: cycles.size,
    completedCycles,
    draftExists: draft.exists,
    draftStatus,
    draftRef: draft.ref,
    pickCount: picks.size,
    projectionPointerRefs,
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
    const alreadyV4 = scoringMatchesV4(data);
    const currentVersion = Number.isInteger(data.scoringRulesVersion)
      ? data.scoringRulesVersion
      : 0;
    const classification = classifyScoringV4Migration({
      alreadyV4,
      cycleCount: state.cycleCount,
      completedCycleCount: state.completedCycles,
      pickCount: state.pickCount,
      draftStatus: state.draftStatus,
      allowMixedHistory,
    });

    plans.push({
      leagueDocument,
      data,
      state,
      alreadyV4,
      currentVersion,
      classification,
    });

    const historyBlocked = classification.blockers.some((blocker) =>
      blocker === 'competition-cycle-history' ||
      blocker === 'completed-cycle-history' ||
      blocker === 'draft-picks-exist'
    );
    const blockedLabel = classification.eligible
      ? ''
      : historyBlocked
        ? ' BLOCKED: competition history exists;'
        : ' BLOCKED;';

    console.log(
      `${leagueDocument.id}: Scoring V${currentVersion || 'legacy'}; ` +
      `${alreadyV4 ? 'already canonical V4' : 'V4 update required'};` + blockedLabel + ' ' +
      `Draft ${state.draftStatus}; ${state.pickCount} pick(s); ` +
      `${state.cycleCount} cycle document(s), ${state.completedCycles} completed; ` +
      `${state.projectionPointerRefs.length} active pointer(s); ` +
      `blockers: ${formatBlockers(classification.blockers)}.`,
    );
  }

  const blockers = plans.filter((plan) => !plan.classification.eligible);
  if (blockers.length > 0 && !eligibleOnly) {
    console.error('\nProduction Scoring V4 migration stopped before any write.');
    blockers.forEach((plan) => {
      console.error(`- ${plan.leagueDocument.id}: ${formatBlockers(plan.classification.blockers)}`);
    });
    console.error('\nNormal leagues may migrate only before Draft picks or competition cycles exist.');
    console.error('For a global preseason pass that safely skips every league with history or an unsafe Draft state, add --eligible-only.');
    console.error('For one disposable historical test league only, use the exact --league ID plus:');
    console.error(`${MIXED_HISTORY_GUARD}=${MIXED_HISTORY_VALUE}`);
    console.error('A live Draft is never eligible, even with the test-only guard.');
    throw new Error(`${blockers.length} league(s) require a deliberate preseason or disposable-test decision.`);
  }

  if (blockers.length > 0 && eligibleOnly) {
    console.log(`\n--eligible-only will skip ${blockers.length} blocked league(s) and will not alter their scoring contract.`);
    blockers.forEach((plan) => {
      console.log(`- Skipping ${plan.leagueDocument.id}: ${formatBlockers(plan.classification.blockers)}`);
    });
  }

  const updates = plans.filter((plan) => !plan.alreadyV4 && plan.classification.eligible);

  if (!apply) {
    console.log(`\nProduction Scoring V4 dry run for ${projectId}:`);
    console.log(`- Leagues inspected: ${plans.length}`);
    console.log(`- Already V4: ${plans.filter((plan) => plan.alreadyV4).length}`);
    console.log(`- Blocked/skipped: ${blockers.length}`);
    console.log(`- Would update: ${updates.length}`);
    console.log(`- Projection pointers that would be invalidated: ${updates.reduce((total, plan) => total + plan.state.projectionPointerRefs.length, 0)}`);
    console.log('- Dry run only. No league, score, cycle, window, standing, roster, Draft pick, transaction, waiver, or projection asset was changed.');
    console.log(`- Set ${APPLY_GUARD}=APPLY only after reviewing every league above.`);
    return;
  }

  const writer = db.bulkWriter();
  writer.onWriteError((error) => {
    if (error.failedAttempts < 4) return true;
    console.error(`Scoring V4 migration write failed at ${error.documentRef.path}: ${error.message}`);
    return false;
  });

  for (const plan of updates) {
    const previousRules = plan.data.scoringRules ?? null;
    const mixedHistoricalScoring = plan.state.cycleCount > 0 || plan.state.pickCount > 0;

    writer.set(
      plan.leagueDocument.ref,
      {
        scoringRules: defaultScoringRules,
        scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
        scoringRulesUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (plan.state.draftExists) {
      writer.set(
        plan.state.draftRef,
        {
          projectionPreparationRequestId: null,
          projectionPreparationStatus: 'error',
          serverDraftProjectionSnapshotId: null,
          serverDraftProjectionSnapshotHash: null,
          serverDraftProjectionAuthorityVersion: null,
          serverDraftProjectionCatalogHash: null,
          serverAutomationMessage:
            'Scoring upgraded to Production V4. Regenerate and save the verified Projection V11 Draft board before opening the Draft.',
          serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    plan.state.projectionPointerRefs.forEach((reference) => writer.delete(reference));

    writer.set(
      db.doc(`leagues/${plan.leagueDocument.id}/audit/scoring-v4-upgrade`),
      {
        schemaVersion: 2,
        action: 'scoring-rules-upgraded',
        authority: AUTHORITY,
        release: RELEASE,
        fromVersion: plan.currentVersion,
        toVersion: CURRENT_SCORING_RULES_VERSION,
        previousRulesFingerprint: fingerprint(previousRules),
        scoringRulesFingerprint: fingerprint(defaultScoringRules),
        mixedHistoricalScoring,
        testOnlyMixedHistoryOverride: allowMixedHistory,
        existingDraftStatus: plan.state.draftStatus,
        existingDraftPickCount: plan.state.pickCount,
        existingCycleCount: plan.state.cycleCount,
        completedCycleCount: plan.state.completedCycles,
        invalidatedProjectionPointerCount: plan.state.projectionPointerRefs.length,
        skaterRulesChanged: false,
        goalieRulesChanged: true,
        immutableCompletedWindowsRewritten: false,
        projectionAssetsRewritten: false,
        occurredAt: FieldValue.serverTimestamp(),
      },
    );
  }

  await writer.close();

  console.log(`\nProduction Scoring V4 applied for ${projectId}:`);
  console.log(`- Leagues inspected: ${plans.length}`);
  console.log(`- Leagues updated: ${updates.length}`);
  console.log(`- Already V4: ${plans.filter((plan) => plan.alreadyV4).length}`);
  console.log(`- Blocked/skipped: ${blockers.length}`);
  console.log('- Current/target projection pointers were invalidated; immutable snapshot documents were retained for evidence.');
  console.log('- Completed cycle/window, score, standings, roster, Draft-pick, transaction, and waiver documents were not rewritten.');
  console.log('- Regenerate and verify each migrated league Projection V11 snapshot before opening its Draft or deploying RC50 to that cohort.');
}

main().catch((error) => {
  console.error('Production Scoring V4 migration failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
