#!/usr/bin/env node
'use strict';

const process = require('node:process');
const { createHash } = require('node:crypto');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, getFirestore } = require('firebase-admin/firestore');

const {
  CURRENT_SCORING_RULES_VERSION,
  SCORING_RULES_V3_VERSION,
  defaultScoringRules,
  scoringRulesV3,
} = require('../lib/shared/core/scoring/scoring-rules.js');

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
const allowLegacyHistory = process.argv.includes('--allow-legacy-history');

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting Production Scoring V4.');
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
function isSha256(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

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

function classifyRules(data) {
  if (
    data.scoringRulesVersion === CURRENT_SCORING_RULES_VERSION &&
    stableJson(data.scoringRules) === stableJson(defaultScoringRules)
  ) {
    return 'v4';
  }
  if (
    data.scoringRulesVersion === SCORING_RULES_V3_VERSION &&
    stableJson(data.scoringRules) === stableJson(scoringRulesV3)
  ) {
    return 'v3';
  }
  return 'invalid';
}

function inspectProjectionPointer(pointer, scoringClass) {
  if (!pointer.exists) {
    return scoringClass === 'v4'
      ? ['current Projection V11 pointer is missing after the scoring migration']
      : [];
  }

  const data = pointer.data() ?? {};
  const expectedVersion = scoringClass === 'v4'
    ? CURRENT_SCORING_RULES_VERSION
    : SCORING_RULES_V3_VERSION;
  const issues = [];

  if (data.status !== 'ready') issues.push(`current projection status is ${data.status ?? 'missing'}, expected ready`);
  if (data.projectionVersion !== 11) issues.push(`current projection version is ${data.projectionVersion ?? 'missing'}, expected 11`);
  if (data.scoringRulesVersion !== expectedVersion) {
    issues.push(`current projection uses Scoring V${data.scoringRulesVersion ?? 'missing'}, expected V${expectedVersion}`);
  }
  if (data.generatedByAuthority !== 'server') issues.push('current projection is not server-authoritative');
  if (data.snapshotIntegrityStatus !== 'verified') issues.push('current projection integrity is not verified');
  if (!isSha256(data.snapshotContentHash)) issues.push('current projection content hash is missing');
  if (scoringClass === 'v4' && data.snapshotHashSchemaVersion !== 2) {
    issues.push(`current V4 projection hash schema is ${data.snapshotHashSchemaVersion ?? 'missing'}, expected 2`);
  }
  if (scoringClass === 'v3' && ![1, 2].includes(data.snapshotHashSchemaVersion)) {
    issues.push(`current V3 projection hash schema is ${data.snapshotHashSchemaVersion ?? 'missing'}, expected 1 or 2`);
  }

  return issues;
}

async function main() {
  const db = getFirestore();
  const leagues = await loadLeagues(db);
  const issues = [];
  const counts = { v3: 0, v4: 0, invalid: 0, mixedHistory: 0, preservedLegacyHistory: 0 };

  for (const league of leagues) {
    const data = league.data();
    const scoringClass = classifyRules(data);
    counts[scoringClass] += 1;

    if (scoringClass === 'invalid') {
      issues.push(`${league.ref.path}: scoring version/formula is neither canonical V3 nor canonical V4`);
      continue;
    }

    const [pointer, audit, cycleEvidence, pickEvidence] = await Promise.all([
      db.doc(`leagues/${league.id}/projectionSnapshots/current`).get(),
      db.doc(`leagues/${league.id}/audit/scoring-v4-upgrade`).get(),
      db.collection(`leagues/${league.id}/cycles`).limit(1).get(),
      db.collection(`leagues/${league.id}/draft/current/picks`).limit(1).get(),
    ]);

    const hasCompetitionHistory = !cycleEvidence.empty || !pickEvidence.empty;

    if (scoringClass === 'v3') {
      if (!allowLegacyHistory) {
        issues.push(`${league.ref.path}: remains on canonical V3; migrate it before treating V4 cutover as complete`);
      } else if (!hasCompetitionHistory) {
        issues.push(`${league.ref.path}: remains on V3 without competition history and should be migrated`);
      } else {
        counts.preservedLegacyHistory += 1;
      }
    }

    inspectProjectionPointer(pointer, scoringClass).forEach((issue) => {
      issues.push(`${league.ref.path}: ${issue}`);
    });

    if (audit.exists && audit.data()?.mixedHistoricalScoring === true) {
      counts.mixedHistory += 1;
    }

    console.log(
      `${league.id}: canonical Scoring ${scoringClass.toUpperCase()}; ` +
      `${pointer.exists ? `projection Scoring V${pointer.data()?.scoringRulesVersion ?? 'missing'}, hash schema ${pointer.data()?.snapshotHashSchemaVersion ?? 'missing'}` : 'projection pointer missing'}.`,
    );
  }

  console.log(`\nScoring-version inspection for ${projectId}:`);
  console.log(`- Leagues inspected: ${leagues.length}`);
  console.log(`- Canonical V4 leagues: ${counts.v4}`);
  console.log(`- Canonical legacy V3 leagues: ${counts.v3}`);
  console.log(`- Invalid/drifted scoring contracts: ${counts.invalid}`);
  console.log(`- Explicit mixed-history test leagues: ${counts.mixedHistory}`);
  console.log(`- Preserved V3 leagues with competition history: ${counts.preservedLegacyHistory}`);
  console.log(`- Legacy-history allowance: ${allowLegacyHistory ? 'ENABLED' : 'DISABLED'}`);
  console.log(`- V4 rules fingerprint: ${fingerprint(defaultScoringRules)}`);
  console.log(`- V3 rules fingerprint: ${fingerprint(scoringRulesV3)}`);
  console.log(`- Inspection issues: ${issues.length}`);

  if (issues.length) {
    console.error('\nScoring issues:');
    issues.slice(0, 100).forEach((issue) => console.error(`  - ${issue}`));
    if (issues.length > 100) console.error(`  - ...and ${issues.length - 100} more`);
    throw new Error('Scoring-version inspection found unresolved league or projection issues.');
  }

  console.log('\nScoring-version inspection passed.');
  console.log('Inspection only. No league, score, cycle, window, standing, roster, Draft, transaction, waiver, or projection was changed.');
}

main().catch((error) => {
  console.error('Scoring-version inspection failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
