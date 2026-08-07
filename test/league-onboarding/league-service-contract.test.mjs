import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sourceUrl = new URL(
  '../../src/app/core/league/league.service.ts',
  import.meta.url,
);
const source = await readFile(sourceUrl, 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('createLeague delegates the complete workflow to createLeagueSecure', () => {
  const createLeagueSource = section(
    'export async function createLeague(',
    'export async function getMyLeagues()',
  );

  assert.match(createLeagueSource, /httpsCallable<[\s\S]*?>\(functions, 'createLeagueSecure'/);
  assert.match(createLeagueSource, /timeout: 50_000/);
  assert.match(createLeagueSource, /requestId: pending\.requestId/);
  assert.match(createLeagueSource, /profileIconId: pending\.profileIconId/);
  assert.doesNotMatch(createLeagueSource, /writeBatch\(|batch\.set\(|ensureFantasyRoster\(/);
});

test('createLeague retries a lost response with the same exact request identity', () => {
  assert.match(source, /PENDING_LEAGUE_CREATION_STORAGE_KEY/);
  assert.match(source, /getOrCreatePendingLeagueCreation\(fingerprint\)/);
  assert.match(source, /existing\?\.fingerprint === fingerprint/);
  assert.match(source, /clearPendingLeagueCreation\(pending\.requestId\)/);
});

test('joinLeagueByInviteCode delegates the complete membership workflow to joinLeagueSecure', () => {
  const joinLeagueSource = section(
    'export async function joinLeagueByInviteCode(',
    'export async function ensureLeagueProfileIcon(',
  );

  assert.match(joinLeagueSource, /httpsCallable<[\s\S]*?>\(functions, 'joinLeagueSecure'/);
  assert.match(joinLeagueSource, /timeout: 60_000/);
  assert.match(joinLeagueSource, /requestId: pending\.requestId/);
  assert.match(joinLeagueSource, /profileIconId: pending\.profileIconId/);
  assert.doesNotMatch(
    joinLeagueSource,
    /writeBatch\(|setDoc\(|getDoc\(|ensureFantasyRoster\(|getLeagueInviteRef/,
  );
});

test('join retries a lost response with the same exact request identity', () => {
  assert.match(source, /PENDING_LEAGUE_JOIN_STORAGE_KEY/);
  assert.match(source, /getOrCreatePendingLeagueJoin\(fingerprint\)/);
  assert.match(source, /existing\?\.fingerprint === fingerprint/);
  assert.match(source, /clearPendingLeagueJoin\(pending\.requestId\)/);
});
