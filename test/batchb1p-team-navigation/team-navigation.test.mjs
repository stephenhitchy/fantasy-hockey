import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  selectCurrentMatchupCycles,
  selectCurrentMatchupsByOwner,
} from '../../src/app/core/cycle/current-matchup-selection.util.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function cycle(cycleNumber, status) {
  return { cycleNumber, status };
}

function matchup(id, cycleNumber, teamAOwnerId, teamBOwnerId, status) {
  return { id, cycleNumber, teamAOwnerId, teamBOwnerId, status };
}

test('multi-active-cycle resolver selects the earliest unfinished matchup per team', () => {
  const cycles = selectCurrentMatchupCycles([
    cycle(1, 'complete'),
    cycle(2, 'active'),
    cycle(3, 'active'),
  ]);
  const cycleTwoMatchup = matchup('matchup-1', 2, 'owner-a', 'owner-b', 'active');
  const cycleThreeMatchup = matchup('matchup-1', 3, 'owner-a', 'owner-c', 'active');
  const matchupsByCycle = new Map([
    [1, [matchup('matchup-1', 1, 'owner-a', 'owner-d', 'complete')]],
    [2, [cycleTwoMatchup]],
    [3, [cycleThreeMatchup]],
  ]);

  const selected = selectCurrentMatchupsByOwner(cycles, matchupsByCycle);

  assert.equal(selected.get('owner-a'), cycleTwoMatchup);
  assert.equal(selected.get('owner-b'), cycleTwoMatchup);
  assert.equal(selected.get('owner-c'), cycleThreeMatchup);
  assert.equal(selected.get('owner-d')?.cycleNumber, 1);
});

test('both participants resolve to the same stored matchup and completed fallback', () => {
  const cycles = selectCurrentMatchupCycles([
    cycle(4, 'complete'),
    cycle(5, 'complete'),
  ]);
  const completed = matchup('matchup-2', 5, 'owner-left', 'owner-right', 'complete');
  const selected = selectCurrentMatchupsByOwner(cycles, new Map([[5, [completed]]]));

  assert.deepEqual(cycles.map((entry) => entry.cycleNumber), [5]);
  assert.equal(selected.get('owner-left'), completed);
  assert.equal(selected.get('owner-right'), completed);
});

test('League HQ exposes explicit roster and selected-team matchup links', async () => {
  const [template, component, routes] = await Promise.all([
    read('src/app/features/leagues/league-detail/league-detail.html'),
    read('src/app/features/leagues/league-detail/league-detail.ts'),
    read('src/app/app.routes.ts'),
  ]);

  assert.match(template, /View Matchup/);
  assert.match(template, /View Roster/);
  assert.match(template, /team-identity-link/);
  assert.match(component, /listenToEarliestUnfinishedLeagueMatchups/);
  assert.match(component, /getTeamMatchupLink\(team: FantasyTeam\)/);
  assert.match(routes, /path: 'leagues\/:leagueId\/teams\/:ownerId'/);
  assert.match(routes, /title: 'Team Roster'/);
});

test('spectator roster uses explicit viewed owner and skips owner-only side effects', async () => {
  const [component, template, rules] = await Promise.all([
    read('src/app/features/team/team-settings/team-settings.ts'),
    read('src/app/features/team/team-settings/team-settings.html'),
    read('firestore.rules'),
  ]);

  assert.match(component, /viewedOwnerId = signal\(''\)/);
  assert.match(component, /viewedOwnerId === user\.uid\) \{\s*await getOrCreateFantasyRoster/s);
  assert.match(component, /if \(isOwnTeam\) \{\s*this\.stopTransactionsListener/s);
  assert.match(component, /if \(!this\.isOwnTeam\(\)\) \{\s*this\.rosterMoveError\.set\('This roster is read-only/s);
  assert.match(component, /Read-only roster/);
  assert.match(template, /@if \(isOwnTeam\(\)\) \{[\s\S]*Add \/ Drop/);
  assert.match(template, /\[open\]="isOwnTeam\(\) && rosterManagerOpen\(\)"/);
  assert.match(rules, /match \/roster\/\{rosterId\} \{\s*allow read: if isLeagueMember\(leagueId\);/);
  assert.match(rules, /allow create, update, delete: if false;/);
});

test('team switching cleans listeners and rejects late async loads', async () => {
  const component = await read('src/app/features/team/team-settings/team-settings.ts');

  assert.match(component, /this\.route\.paramMap\.subscribe/);
  assert.match(component, /const loadGeneration = \+\+this\.loadGeneration/);
  assert.match(component, /if \(loadGeneration !== this\.loadGeneration\) \{\s*return;/s);
  assert.match(component, /private stopLiveListeners\(\): void/);
  assert.match(component, /this\.routeSubscription\.unsubscribe\(\)/);
});
