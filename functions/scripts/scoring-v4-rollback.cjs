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
  SCORING_RULES_V3_VERSION,
  defaultScoringRules,
  scoringRulesV3,
} = require('../lib/shared/core/scoring/scoring-rules.js');
const {
  isProjectionPointerId,
  normalizeDraftStatus,
} = require('./scoring-v4-migration.util.cjs');

const RELEASE = 'Scoring Batch V4A';
const AUTHORITY = 'scoring-v4-rollback-authority';
const APPLY_GUARD = 'RINKRAT_ROLLBACK_SCORING_V4';
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
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting or rolling back Production Scoring V4.');
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
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return undefined;
}
function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function fingerprint(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }

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
  return data.scoringRulesVersion === version && stableJson(data.scoringRules) === stableJson(rules);
}

async function inspectState(db, leagueId) {
  const [cycles, draft, picks, projections] = await Promise.all([
    db.collection(`leagues/${leagueId}/cycles`).limit(1).get(),
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    db.collection(`leagues/${leagueId}/draft/current/picks`).limit(1).get(),
    readAll(db.collection(`leagues/${leagueId}/projectionSnapshots`)),
  ]);
  return {
    cycleCount: cycles.size,
    pickCount: picks.size,
    draftExists: draft.exists,
    draftStatus: normalizeDraftStatus(draft.exists ? draft.data()?.status : null),
    draftRef: draft.ref,
    projectionPointerRefs: projections.filter((doc) => isProjectionPointerId(doc.id)).map((doc) => doc.ref),
  };
}

async function main() {
  const db = getFirestore();
  const leagues = await loadLeagues(db);
  const plans = [];

  for (const leagueDocument of leagues) {
    const data = leagueDocument.data();
    const state = await inspectState(db, leagueDocument.id);
    const alreadyV3 = scoringMatches(data, SCORING_RULES_V3_VERSION, scoringRulesV3);
    const canonicalV4 = scoringMatches(data, CURRENT_SCORING_RULES_VERSION, defaultScoringRules);
    const blocked = !alreadyV3 && (
      !canonicalV4 ||
      state.cycleCount > 0 ||
      state.pickCount > 0 ||
      !['missing', 'setup', 'scheduled'].includes(state.draftStatus)
    );
    plans.push({ leagueDocument, data, state, alreadyV3, canonicalV4, blocked });

    console.log(
      `${leagueDocument.id}: Scoring V${data.scoringRulesVersion ?? 'legacy'}; ` +
      `${alreadyV3 ? 'already canonical V3' : canonicalV4 ? 'canonical V4 rollback candidate' : 'noncanonical scoring'}; ` +
      `Draft ${state.draftStatus}; ${state.pickCount} pick(s); ${state.cycleCount} cycle document(s)` +
      `${blocked ? ' — BLOCKED' : ''}.`,
    );
  }

  const blockers = plans.filter((plan) => plan.blocked);
  if (blockers.length) {
    throw new Error('Preseason rollback is blocked once any competition cycle exists and is allowed only for canonical V4 leagues with no Draft picks and no live/complete Draft.');
  }

  const updates = plans.filter((plan) => !plan.alreadyV3);
  if (!apply) {
    console.log(`\nProduction Scoring V4 rollback dry run for ${projectId}:`);
    console.log(`- Leagues inspected: ${plans.length}`);
    console.log(`- Already canonical V3: ${plans.length - updates.length}`);
    console.log(`- Would restore to V3: ${updates.length}`);
    console.log('- Dry run only. No data was changed.');
    console.log(`- Set ${APPLY_GUARD}=${APPLY_VALUE} only before any Draft pick or competition cycle exists.`);
    return;
  }

  const writer = db.bulkWriter();
  writer.onWriteError((error) => error.failedAttempts < 4);

  for (const plan of updates) {
    writer.set(plan.leagueDocument.ref, {
      scoringRules: scoringRulesV3,
      scoringRulesVersion: SCORING_RULES_V3_VERSION,
      scoringRulesUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (plan.state.draftExists) {
      writer.set(plan.state.draftRef, {
        projectionPreparationRequestId: null,
        projectionPreparationStatus: 'error',
        serverDraftProjectionSnapshotId: null,
        serverDraftProjectionSnapshotHash: null,
        serverDraftProjectionAuthorityVersion: null,
        serverDraftProjectionCatalogHash: null,
        serverAutomationMessage: 'Scoring restored to V3 before competition. Regenerate and save the verified V3 Draft board.',
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    plan.state.projectionPointerRefs.forEach((ref) => writer.delete(ref));

    writer.set(db.doc(`leagues/${plan.leagueDocument.id}/audit/scoring-v4-rollback`), {
      schemaVersion: 2,
      action: 'scoring-v4-rolled-back-before-competition',
      authority: AUTHORITY,
      release: RELEASE,
      fromVersion: CURRENT_SCORING_RULES_VERSION,
      toVersion: SCORING_RULES_V3_VERSION,
      previousRulesFingerprint: fingerprint(plan.data.scoringRules ?? null),
      restoredRulesFingerprint: fingerprint(scoringRulesV3),
      invalidatedProjectionPointerCount: plan.state.projectionPointerRefs.length,
      existingCycleCount: 0,
      existingDraftPickCount: 0,
      immutableCompletedWindowsRewritten: false,
      projectionAssetsRewritten: false,
      occurredAt: FieldValue.serverTimestamp(),
    });
  }

  await writer.close();
  console.log(`\nProduction Scoring V4 preseason rollback applied for ${projectId}:`);
  console.log(`- Leagues restored to V3: ${updates.length}`);
  console.log('- Current/target projection pointers were invalidated; immutable snapshot documents were retained.');
  console.log('- No score, cycle, window, standing, roster, Draft-pick, transaction, or waiver document was rewritten.');
}

main().catch((error) => {
  console.error('Production Scoring V4 preseason rollback failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
