#!/usr/bin/env node
'use strict';

const process = require('node:process');
const { createHash } = require('node:crypto');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, getFirestore } = require('firebase-admin/firestore');

const {
  SCORING_RULES_V3_VERSION,
  SCORING_RULES_V4_VERSION,
  SCORING_RULES_V5_VERSION,
  scoringRulesV3,
  scoringRulesV4,
  scoringRulesV5,
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

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting Scoring V5 compatibility.');
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

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
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

function classifyRules(data) {
  if (
    data.scoringRulesVersion === SCORING_RULES_V3_VERSION &&
    stableJson(data.scoringRules) === stableJson(scoringRulesV3)
  ) {
    return 'v3';
  }
  if (
    data.scoringRulesVersion === SCORING_RULES_V5_VERSION &&
    stableJson(data.scoringRules) === stableJson(scoringRulesV5)
  ) {
    return 'v5';
  }
  if (
    data.scoringRulesVersion === SCORING_RULES_V4_VERSION &&
    stableJson(data.scoringRules) === stableJson(scoringRulesV4)
  ) {
    return 'v4';
  }
  return 'invalid';
}

function inspectProjectionPointer(pointer, scoringClass) {
  if (!pointer.exists) {
    return scoringClass === 'v3'
      ? []
      : [`current Projection V11 pointer is missing for canonical Scoring ${scoringClass.toUpperCase()}`];
  }

  const data = pointer.data() ?? {};
  const expectedVersion = scoringClass === 'v5'
    ? SCORING_RULES_V5_VERSION
    : scoringClass === 'v4'
      ? SCORING_RULES_V4_VERSION
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
  if (
    scoringClass === 'v3'
      ? ![1, 2].includes(data.snapshotHashSchemaVersion)
      : data.snapshotHashSchemaVersion !== 2
  ) {
    issues.push(
      `current projection hash schema is ${data.snapshotHashSchemaVersion ?? 'missing'}, ` +
      `${scoringClass === 'v3' ? 'expected 1 or 2' : 'expected 2'}`,
    );
  }

  return issues;
}

function inspectV5Audit(audit) {
  if (!audit.exists) return ['Scoring V5 migration audit evidence is missing'];
  const data = audit.data() ?? {};
  const issues = [];

  if (data.fromVersion !== SCORING_RULES_V4_VERSION) {
    issues.push(`V5 audit source version is ${data.fromVersion ?? 'missing'}, expected V4`);
  }
  if (data.toVersion !== SCORING_RULES_V5_VERSION) {
    issues.push(`V5 audit target version is ${data.toVersion ?? 'missing'}, expected V5`);
  }
  if ((Number(data.existingCycleCount) || 0) !== 0) {
    issues.push('V5 audit reports pre-existing competition cycles');
  }
  if ((Number(data.existingDraftPickCount) || 0) !== 0) {
    issues.push('V5 audit reports pre-existing Draft picks');
  }
  if (data.mixedHistoricalScoring === true || data.testOnlyMixedHistoryOverride === true) {
    issues.push('V5 audit contains a forbidden mixed-history override');
  }

  return issues;
}

async function main() {
  const db = getFirestore();
  const leagues = await loadLeagues(db);
  const issues = [];
  const counts = { v3: 0, v4: 0, v5: 0, invalid: 0 };

  for (const league of leagues) {
    const data = league.data();
    const scoringClass = classifyRules(data);
    counts[scoringClass] += 1;

    if (scoringClass === 'invalid') {
      issues.push(`${league.ref.path}: scoring version/formula is not canonical V3, V4, or V5`);
      continue;
    }

    const [pointer, audit] = await Promise.all([
      db.doc(`leagues/${league.id}/projectionSnapshots/current`).get(),
      db.doc(`leagues/${league.id}/audit/scoring-v5-upgrade`).get(),
    ]);

    inspectProjectionPointer(pointer, scoringClass).forEach((issue) => {
      issues.push(`${league.ref.path}: ${issue}`);
    });
    if (scoringClass === 'v5') {
      inspectV5Audit(audit).forEach((issue) => {
        issues.push(`${league.ref.path}: ${issue}`);
      });
    }

    console.log(
      `${league.id}: canonical Scoring ${scoringClass.toUpperCase()}; ` +
      `${pointer.exists ? `projection Scoring V${pointer.data()?.scoringRulesVersion ?? 'missing'}, hash schema ${pointer.data()?.snapshotHashSchemaVersion ?? 'missing'}` : 'projection pointer missing'}; ` +
      `${scoringClass === 'v5'
        ? audit.exists ? 'V5 migration audit present' : 'V5 migration audit missing'
        : scoringClass === 'v4'
          ? 'production-default V4 retained'
          : 'supported legacy V3 retained'}.`,
    );
  }

  console.log(`\nScoring V4/V5 compatibility inspection for ${projectId}:`);
  console.log(`- Leagues inspected: ${leagues.length}`);
  console.log(`- Canonical supported legacy V3 leagues: ${counts.v3}`);
  console.log(`- Canonical production-default V4 leagues: ${counts.v4}`);
  console.log(`- Canonical opt-in V5 leagues: ${counts.v5}`);
  console.log(`- Invalid/drifted scoring contracts: ${counts.invalid}`);
  console.log(`- V3 rules fingerprint: ${fingerprint(scoringRulesV3)}`);
  console.log(`- V4 rules fingerprint: ${fingerprint(scoringRulesV4)}`);
  console.log(`- V5 rules fingerprint: ${fingerprint(scoringRulesV5)}`);
  console.log(`- Inspection issues: ${issues.length}`);

  if (issues.length) {
    console.error('\nScoring issues:');
    issues.slice(0, 100).forEach((issue) => console.error(`  - ${issue}`));
    if (issues.length > 100) console.error(`  - ...and ${issues.length - 100} more`);
    throw new Error('Scoring V4/V5 compatibility inspection found unresolved league or projection issues.');
  }

  console.log('\nScoring V4/V5 compatibility inspection passed.');
  console.log('Inspection only. No league, score, cycle, window, standing, roster, Draft, transaction, waiver, or projection was changed.');
}

main().catch((error) => {
  console.error('Scoring V4/V5 compatibility inspection failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
