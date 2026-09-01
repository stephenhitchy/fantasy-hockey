import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildCapacityReport } from '../../scripts/capacity/rinkrat-capacity-model.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Projection V11 listeners are visible to the shared client-health monitor', async () => {
  const source = await read('src/app/core/projection/projection-snapshot.service.ts');
  const monitorCalls = source.match(/monitorFirestore(?:Listener|Unsubscribe)\(\s*'/g) ?? [];
  const snapshotCalls = source.match(/(?<![A-Za-z0-9_])onSnapshot\(/g) ?? [];

  assert.equal(snapshotCalls.length, 2);
  assert.equal(monitorCalls.length, snapshotCalls.length);
  assert.match(source, /monitorFirestoreListener\('projection:snapshot-pointer'/);
  assert.match(source, /monitorFirestoreListener\([\s\S]*'projection:generation-request'/);
  assert.equal((source.match(/listenerObserver\.next\(/g) ?? []).length, 2);
  assert.equal((source.match(/listenerObserver\.error\(/g) ?? []).length, 2);
  assert.match(
    source,
    /setTimeout[\s\S]*unsubscribe\(\)[\s\S]*Projection generation is still running/,
    'the bounded generation wait must still unsubscribe on timeout',
  );
});

test('Available Players source fan-out stays aligned with the capacity model', async () => {
  const [source, draftSource, availabilitySource, availabilitySyncSource] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/core/draft/draft.service.ts'),
    read('src/app/core/player/player-availability.service.ts'),
    read('src/app/core/player/player-availability-sync.service.ts'),
  ]);
  const listenerCalls = source.match(/\blistenTo[A-Z][A-Za-z]+\(/g) ?? [];

  assert.equal(listenerCalls.length, 8);

  for (const listener of [
    'listenToHistoricalReplayControl',
    'listenToSharedProjectionSnapshot',
    'listenToFantasyDraft',
    'listenToLeagueCycles',
    'listenToLeagueWaivers',
    'listenToLeagueTeams',
    'listenToCycleTeamWindows',
    'listenToFantasyRoster',
  ]) {
    assert.match(source, new RegExp(`\\b${listener}\\(`));
  }

  assert.match(source, /cycles\.filter\(\(cycle\) => cycle\.status === 'active'\)/);
  assert.match(source, /teams\.forEach\(\(team\) =>/);
  assert.match(
    source,
    /ngOnDestroy\(\)[\s\S]*clearRosterListeners\(\)[\s\S]*clearTeamWindowListeners\(\)/,
  );
  assert.match(
    draftSource,
    /function listenToLeagueWaivers[\s\S]*'draft:public-waiver-pool'[\s\S]*'draft:private-waiver-claims'/,
    'the one waiver API call opens two protected snapshot streams',
  );
  assert.match(availabilitySource, /'availability:commissioner-overrides'/);
  assert.match(availabilitySyncSource, /'availability:global'/);
});

test('capacity estimates include per-team roster and active-cycle window listeners', async () => {
  const [tenTeamReport, twelveTeamReport] = await Promise.all([
    buildCapacityReport({
      users: 100_000,
      managersPerLeague: 10,
      scenario: 'balanced',
      format: 'json',
    }),
    buildCapacityReport({
      users: 120_000,
      managersPerLeague: 12,
      scenario: 'balanced',
      format: 'json',
    }),
  ]);

  const tenTeamProfile = tenTeamReport.assumptions.routeProfiles.freeAgents;
  const twelveTeamProfile = twelveTeamReport.assumptions.routeProfiles.freeAgents;

  assert.equal(tenTeamProfile.listeners, 20);
  assert.equal(twelveTeamProfile.listeners, 22);
  assert.deepEqual(tenTeamProfile.listenerEvidence, {
    fixedRouteListeners: 9,
    rosterListenersPerTeam: 1,
    assumedActiveCycles: 1,
    teamWindowListenersPerActiveCycle: 1,
    assumedTeamCount: 10,
  });
  assert.equal(
    twelveTeamProfile.listeners - tenTeamProfile.listeners,
    2,
    'two additional teams must add two roster listeners',
  );
  assert.equal(tenTeamReport.estimates.concurrentFirestoreListeners, 790_000);
  assert.match(tenTeamReport.assumptions.documentReads, /not yet measured/i);
  assert.ok(
    tenTeamReport.caveats.some((caveat) => /Cold-start and steady-read profiles/.test(caveat)),
  );
});

test('D1N documents the measurement boundary and does not claim a live load test', async () => {
  const documentation = await read('docs/RINKRAT_SCALE_D1N_CAPACITY_EVIDENCE.md');

  assert.match(documentation, /observability and planning evidence only/i);
  assert.match(documentation, /does not add or remove a Firestore listener/i);
  assert.match(documentation, /not a Firebase billing record/i);
  assert.match(documentation, /Snapshots whose document count cannot be derived are counted separately as unknown/i);
  assert.match(documentation, /authenticated, non-production fixtures/i);
  assert.match(documentation, /separate\s+billed staging Firebase project/i);
  assert.match(documentation, /Scoring V4 and Projection V11 are unchanged/i);
});
