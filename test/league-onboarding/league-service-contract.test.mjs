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

test('createLeague does not directly create a roster denied by Firestore rules', () => {
  const createLeagueSource = section(
    'export async function createLeague(',
    'export async function getMyLeagues(',
  );

  assert.doesNotMatch(createLeagueSource, /getFantasyRosterRef|getNewRosterDocument|batch\.set\(rosterRef/);
  assert.match(createLeagueSource, /await batch\.commit\(\)/);
  assert.match(createLeagueSource, /ensureFantasyRoster\(leagueRef\.id\)/);
});

test('joinLeagueByInviteCode delegates roster creation and repair to server authority', () => {
  const joinLeagueSource = section(
    'export async function joinLeagueByInviteCode(',
    'export async function ensureLeagueProfileIcon(',
  );

  assert.doesNotMatch(joinLeagueSource, /getNewRosterDocument|joinBatch\.set\(rosterRef|repairBatch\.set\(rosterRef/);
  assert.match(joinLeagueSource, /await joinBatch\.commit\(\)/);
  assert.ok(
    (joinLeagueSource.match(/ensureFantasyRoster\(leagueId\)/g) ?? []).length >= 2,
    'Both new and existing membership paths should initialize the roster through the callable.',
  );
});
