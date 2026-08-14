#!/usr/bin/env node

const process = require('node:process');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, getFirestore } = require('firebase-admin/firestore');

const projectArgument = process.argv.find((value) => value.startsWith('--project='));
const leagueArgument = process.argv.find((value) => value.startsWith('--league='));
const projectId = (
  projectArgument?.slice('--project='.length) ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  ''
).trim();
const leagueId = (leagueArgument?.slice('--league='.length) || '').trim();

if (!projectId) {
  console.error('Provide --project=YOUR_FIREBASE_PROJECT_ID before inspecting matchup activity.');
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]{3,128}$/.test(leagueId)) {
  console.error('Provide one exact Internal Test league with --league=YOUR_LEAGUE_ID.');
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId });
}

const EXPECTED_FIELDS = new Set([
  'schemaVersion',
  'category',
  'eventType',
  'ownerId',
  'primaryAsset',
  'secondaryAsset',
  'overallPick',
  'round',
  'selectionType',
  'effectiveCycleNumber',
  'effectiveLabel',
  'matchupPhase',
  'matchupCycleNumber',
  'teamAOwnerId',
  'teamBOwnerId',
  'teamAScore',
  'teamBScore',
  'winnerOwnerId',
  'playoffBracketType',
  'playoffRoundNumber',
  'winnerPlace',
  'loserPlace',
  'tieBrokenByHigherSeed',
  'sourceKind',
  'sourceFingerprint',
  'occurredAt',
  'publishedAt',
  'authority',
  'release',
]);
const FORBIDDEN_FIELDS = new Set([
  'sourceDocumentId',
  'matchupId',
  'cycleId',
  'playoffMatchupId',
  'teamASeed',
  'teamBSeed',
  'teamAWindowNumber',
  'teamBWindowNumber',
  'teamAWindowCycleNumber',
  'teamBWindowCycleNumber',
  'scoreLedger',
  'playerScores',
  'projection',
  'projections',
  'requestId',
  'taskId',
  'retryId',
  'reason',
]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{40}$/;

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

function asTimestampDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function isOwnerId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function isScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -100_000 && value <= 100_000;
}

function isPositiveIntegerOrNull(value) {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function findForbiddenFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenFields(entry, `${prefix}[${index}]`));
  }
  if (!isPlainObject(value)) return [];

  const matches = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_FIELDS.has(key)) matches.push(path);
    matches.push(...findForbiddenFields(child, path));
  }
  return matches;
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

function inspectMatchupActivity(document, issues) {
  const data = document.data();
  const path = document.ref.path;

  for (const key of Object.keys(data)) {
    if (!EXPECTED_FIELDS.has(key)) {
      issues.push(`${path}: unexpected top-level field ${key}`);
    }
  }
  for (const field of EXPECTED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      issues.push(`${path}: missing field ${field}`);
    }
  }

  const forbidden = findForbiddenFields(data);
  if (forbidden.length) {
    issues.push(`${path}: forbidden internal fields ${forbidden.join(', ')}`);
  }

  if (data.schemaVersion !== 1) issues.push(`${path}: schemaVersion must be 1`);
  if (data.category !== 'matchup') issues.push(`${path}: category must be matchup`);
  if (data.eventType !== 'matchup-result') issues.push(`${path}: eventType must be matchup-result`);
  if (data.sourceKind !== 'matchup') issues.push(`${path}: sourceKind must be matchup`);
  if (data.authority !== 'league-activity-authority') {
    issues.push(`${path}: missing league-activity authority marker`);
  }
  if (data.release !== 'Social Batch C1C') {
    issues.push(`${path}: release marker must be Social Batch C1C`);
  }
  if (!FINGERPRINT_PATTERN.test(data.sourceFingerprint || '')) {
    issues.push(`${path}: sourceFingerprint is not a 40-character SHA-256 prefix`);
  } else if (document.id !== `activity-${data.sourceFingerprint}`) {
    issues.push(`${path}: document ID does not match the source fingerprint`);
  }
  if (!isTimestampLike(data.occurredAt)) issues.push(`${path}: occurredAt is missing or invalid`);
  if (!isTimestampLike(data.publishedAt)) issues.push(`${path}: publishedAt is missing or invalid`);

  if (data.primaryAsset !== null || data.secondaryAsset !== null) {
    issues.push(`${path}: matchup activity must not contain roster assets`);
  }
  if (
    data.overallPick !== null ||
    data.round !== null ||
    data.selectionType !== null ||
    data.effectiveCycleNumber !== null ||
    data.effectiveLabel !== null
  ) {
    issues.push(`${path}: matchup activity contains unrelated Draft or transaction fields`);
  }

  if (data.matchupPhase !== 'regular_season' && data.matchupPhase !== 'playoffs') {
    issues.push(`${path}: matchupPhase is invalid`);
  }
  if (!Number.isInteger(data.matchupCycleNumber) || data.matchupCycleNumber <= 0) {
    issues.push(`${path}: matchupCycleNumber is invalid`);
  }
  if (!isOwnerId(data.teamAOwnerId) || !isOwnerId(data.teamBOwnerId)) {
    issues.push(`${path}: both matchup owner IDs must be present`);
  } else if (data.teamAOwnerId === data.teamBOwnerId) {
    issues.push(`${path}: matchup owner IDs must be distinct`);
  }
  if (!isScore(data.teamAScore) || !isScore(data.teamBScore)) {
    issues.push(`${path}: matchup scores must be finite and bounded`);
    return;
  }

  const scoresAreTied = data.teamAScore === data.teamBScore;
  const scoreWinner = data.teamAScore > data.teamBScore
    ? data.teamAOwnerId
    : data.teamBScore > data.teamAScore
      ? data.teamBOwnerId
      : null;
  const winnerIsParticipant = data.winnerOwnerId === data.teamAOwnerId ||
    data.winnerOwnerId === data.teamBOwnerId;

  if (!scoresAreTied && data.winnerOwnerId !== scoreWinner) {
    issues.push(`${path}: winnerOwnerId does not match the higher score`);
  }
  if (scoresAreTied && data.matchupPhase === 'regular_season' && data.winnerOwnerId !== null) {
    issues.push(`${path}: a regular-season tie must not name a winner`);
  }
  if (data.matchupPhase === 'playoffs') {
    if (!winnerIsParticipant) issues.push(`${path}: a playoff result must name one participant as winner`);
    if (scoresAreTied && data.tieBrokenByHigherSeed !== true) {
      issues.push(`${path}: a tied playoff result must record the higher-seed tiebreak`);
    }
  }
  if (data.ownerId !== data.winnerOwnerId) {
    issues.push(`${path}: ownerId must mirror winnerOwnerId`);
  }

  if (
    data.playoffBracketType !== null &&
    data.playoffBracketType !== 'championship' &&
    data.playoffBracketType !== 'consolation'
  ) {
    issues.push(`${path}: playoffBracketType is invalid`);
  }
  if (!isPositiveIntegerOrNull(data.playoffRoundNumber)) {
    issues.push(`${path}: playoffRoundNumber is invalid`);
  }
  if (!isPositiveIntegerOrNull(data.winnerPlace) || !isPositiveIntegerOrNull(data.loserPlace)) {
    issues.push(`${path}: placement fields are invalid`);
  }
  if (typeof data.tieBrokenByHigherSeed !== 'boolean') {
    issues.push(`${path}: tieBrokenByHigherSeed must be boolean`);
  }
  if (data.matchupPhase === 'regular_season' && (
    data.playoffBracketType !== null ||
    data.playoffRoundNumber !== null ||
    data.winnerPlace !== null ||
    data.loserPlace !== null ||
    data.tieBrokenByHigherSeed !== false
  )) {
    issues.push(`${path}: a regular-season result contains playoff-only context`);
  }
}

async function main() {
  const db = getFirestore();
  const leagueSnapshot = await db.doc(`leagues/${leagueId}`).get();
  if (!leagueSnapshot.exists) throw new Error(`League ${leagueId} was not found.`);

  const documents = await readCollection(db.collection(`leagues/${leagueId}/activity`));
  const matchupDocuments = documents.filter((document) => {
    const data = document.data();
    return data.sourceKind === 'matchup' || data.category === 'matchup' || data.eventType === 'matchup-result';
  });
  const issues = [];
  const fingerprints = new Set();

  for (const document of matchupDocuments) {
    inspectMatchupActivity(document, issues);
    const fingerprint = document.data().sourceFingerprint;
    if (typeof fingerprint === 'string') {
      if (fingerprints.has(fingerprint)) {
        issues.push(`${document.ref.path}: duplicate matchup source fingerprint ${fingerprint}`);
      }
      fingerprints.add(fingerprint);
    }
  }

  const latest = [...matchupDocuments]
    .sort((left, right) => {
      const leftDate = asTimestampDate(left.data().occurredAt)?.getTime() ?? 0;
      const rightDate = asTimestampDate(right.data().occurredAt)?.getTime() ?? 0;
      return rightDate - leftDate;
    })
    .at(0);

  console.log(`League matchup activity inspection for ${projectId} / ${leagueId}:`);
  console.log(`- Activity documents inspected: ${documents.length}`);
  console.log(`- Matchup result documents: ${matchupDocuments.length}`);
  console.log(`- Privacy/schema issues: ${issues.length}`);

  if (latest) {
    const data = latest.data();
    const occurredAt = asTimestampDate(data.occurredAt)?.toISOString() || 'unknown time';
    console.log(
      `- Latest matchup result: Matchup ${data.matchupCycleNumber} · ` +
      `${data.teamAScore}-${data.teamBScore} · ${occurredAt}`,
    );
  } else {
    console.log('- Latest matchup result: none yet');
  }

  if (issues.length) {
    console.error('\nMatchup activity issues:');
    for (const issue of issues.slice(0, 100)) console.error(`- ${issue}`);
    if (issues.length > 100) console.error(`- ...and ${issues.length - 100} more`);
    process.exitCode = 1;
  } else {
    console.log('\nMatchup activity inspection passed.');
  }

  console.log('Inspection only. No matchup, score, league, activity, or production setting was changed.');
}

main().catch((error) => {
  console.error('League matchup activity inspection failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
