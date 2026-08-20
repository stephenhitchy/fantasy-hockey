import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  OFFLINE_MATCHUP_SNAPSHOT_MAX_AGE_MILLISECONDS,
  OFFLINE_MATCHUP_SNAPSHOT_MAX_BYTES,
  OFFLINE_MATCHUP_SNAPSHOT_MAX_PER_ACCOUNT,
  createOfflineMatchupSnapshotStorageKey,
  getOfflineMatchupSnapshotAgeLabel,
  isOfflineMatchupSnapshotFresh,
  normalizeOfflineMatchupSnapshot,
  offlineMatchupSnapshotContentEquals,
  selectOfflineMatchupSnapshot,
} from '../../src/app/core/pwa/offline-matchup-snapshot.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const ROOT = new URL('../../', import.meta.url);
const NOW = Date.parse('2026-08-19T03:30:00.000Z');

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function player(name = 'Connor McDavid') {
  return {
    playerName: name,
    teamLabel: 'EDM',
    position: 'C',
    currentPoints: 42.5,
    projectedPoints: 51.2,
    availabilityLabel: null,
    markers: [
      { index: 1, status: 'played', label: 'Game 1 · Played' },
      { index: 2, status: 'missed', label: 'Game 2 · no appearance' },
      { index: 3, status: 'live', label: 'Game 3 · Live' },
      { index: 4, status: 'upcoming', label: 'Game 4 · Upcoming' },
      { index: 5, status: 'upcoming', label: 'Game 5 · Upcoming' },
      { index: 6, status: 'unavailable', label: 'Game 6 · Not scheduled' },
    ],
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    accountId: 'manager-a',
    leagueId: 'league-a',
    leagueName: 'Test League',
    cycleNumber: 3,
    cycleLabel: 'Matchup 3',
    matchupId: 'matchup-a',
    matchupLabel: 'Ice Rats vs Rink Raiders',
    matchupStatus: 'active',
    readinessLabel: 'Waiting on 4 roster games',
    finishLabel: 'Ends Aug 23',
    savedAt: '2026-08-19T03:00:00.000Z',
    sourceReleaseLabel: 'Release Candidate 53',
    sourceScoringVersion: 3,
    sourceProjectionVersion: 11,
    teamA: {
      teamName: 'Ice Rats',
      record: '2-0-0',
      currentScore: 42.5,
      projectedScore: 58.2,
      gamesPlayed: 18,
      gamesTotal: 24,
      resultLabel: null,
      viewerTeam: true,
    },
    teamB: {
      teamName: 'Rink Raiders',
      record: '1-1-0',
      currentScore: 39.4,
      projectedScore: 55.8,
      gamesPlayed: 17,
      gamesTotal: 24,
      resultLabel: null,
      viewerTeam: false,
    },
    positionGroups: [{
      position: 'C',
      label: 'Center',
      rows: [{
        slotLabel: 'C 1',
        teamAPlayer: player(),
        teamBPlayer: player('Nathan MacKinnon'),
      }],
    }],
    ...overrides,
  };
}

test('offline matchup snapshots normalize only the bounded rendered contract', () => {
  const normalized = normalizeOfflineMatchupSnapshot(snapshot(), {
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3, matchupId: 'matchup-a',
  });
  assert.ok(normalized);
  assert.equal(normalized?.positionGroups[0]?.rows[0]?.teamAPlayer?.markers.length, 6);
  assert.equal(normalized?.sourceScoringVersion, 3);
  assert.equal(normalized?.sourceProjectionVersion, 11);
  assert.equal(normalizeOfflineMatchupSnapshot({ ...snapshot(), schemaVersion: 2 }), null);
  assert.equal(normalizeOfflineMatchupSnapshot({ ...snapshot(), accountId: 'manager-b' }, {
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3,
  }), null);
  assert.ok(OFFLINE_MATCHUP_SNAPSHOT_MAX_BYTES <= 350_000);
});

test('selection is exact to account, league, cycle, and explicit matchup', () => {
  const values = [
    snapshot(),
    snapshot({ matchupId: 'matchup-b', savedAt: '2026-08-19T03:10:00.000Z' }),
    snapshot({ leagueId: 'league-b', matchupId: 'matchup-c' }),
    snapshot({ cycleNumber: 4, matchupId: 'matchup-d' }),
    snapshot({ accountId: 'manager-b', matchupId: 'matchup-e' }),
  ];
  assert.equal(selectOfflineMatchupSnapshot(values, {
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3, matchupId: 'matchup-a',
  }, NOW)?.matchupId, 'matchup-a');
  assert.equal(selectOfflineMatchupSnapshot(values, {
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3, matchupId: 'missing',
  }, NOW), null);
});

test('generic cycle routes choose only the viewer matchup in the exact cycle', () => {
  const values = [
    snapshot({ matchupId: 'other', savedAt: '2026-08-19T03:20:00.000Z', teamA: {
      ...snapshot().teamA, viewerTeam: false,
    } }),
    snapshot({ matchupId: 'mine', savedAt: '2026-08-19T03:00:00.000Z' }),
    snapshot({ matchupId: 'future', cycleNumber: 4, savedAt: '2026-08-19T03:25:00.000Z' }),
  ];
  assert.equal(selectOfflineMatchupSnapshot(values, {
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3,
  }, NOW)?.matchupId, 'mine');
  assert.equal(selectOfflineMatchupSnapshot([
    snapshot({
      matchupId: 'other-only',
      teamA: { ...snapshot().teamA, viewerTeam: false },
      teamB: { ...snapshot().teamB, viewerTeam: false },
    }),
  ], {
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3,
  }, NOW), null);
});

test('saved matchup age, count, and content comparison remain bounded', () => {
  assert.equal(OFFLINE_MATCHUP_SNAPSHOT_MAX_PER_ACCOUNT, 12);
  assert.equal(OFFLINE_MATCHUP_SNAPSHOT_MAX_AGE_MILLISECONDS, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(isOfflineMatchupSnapshotFresh(snapshot(), NOW), true);
  assert.equal(isOfflineMatchupSnapshotFresh(snapshot({ savedAt: '2026-08-10T03:00:00.000Z' }), NOW), false);
  assert.equal(getOfflineMatchupSnapshotAgeLabel('2026-08-19T03:00:00.000Z', NOW), 'Saved 30 min ago');
  assert.equal(createOfflineMatchupSnapshotStorageKey({
    accountId: 'manager-a', leagueId: 'league-a', cycleNumber: 3, matchupId: 'matchup-a',
  }), 'manager-a::league-a::3::matchup-a');
  assert.equal(offlineMatchupSnapshotContentEquals(
    snapshot(), snapshot({ savedAt: '2026-08-19T03:20:00.000Z' }),
  ), true);
});

test('Game Center saves only after live presentation and loads saved data before offline listeners', async () => {
  const source = await read('src/app/features/cycles/cycle-one/cycle-one.ts');
  assert.match(source, /effect\(\(onCleanup\) =>/);
  assert.match(source, /this\.buildOfflineMatchupSnapshot\(\)/);
  assert.match(source, /this\.offlineMatchupSnapshots\.save\(snapshot\)/);
  assert.match(source, /if \(!this\.clientHealth\.online\(\)\) \{[\s\S]*?await this\.loadSavedOfflineMatchup\('offline'\)[\s\S]*?return;/);
  assert.match(source, /await this\.loadSavedOfflineMatchup\('live-unavailable'\)/);
  assert.ok(source.indexOf("loadSavedOfflineMatchup('offline')") < source.indexOf('startPlayerAvailabilityListenerForLeague(leagueId)'));
});

test('the stored snapshot is presentation-only and excludes private or competitive payloads', async () => {
  const [models, builder, service] = await Promise.all([
    read('src/app/core/pwa/offline-matchup-snapshot.models.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/core/pwa/offline-matchup-snapshot.service.ts'),
  ]);
  const combined = `${models}\n${service}`;
  assert.match(service, /indexedDB\.open/);
  assert.match(service, /OFFLINE_MATCHUP_SNAPSHOT_MAX_PER_ACCOUNT/);
  assert.match(builder, /sourceScoringVersion: BUNDLED_RELEASE_MANIFEST\.scoringRulesVersion/);
  assert.doesNotMatch(combined, /waiverClaim|transactionId|inviteCode|emailAddress|playerNote|draftQueue|pendingMove|requestId/);
  assert.doesNotMatch(service, /firebase|httpsCallable|setDoc|updateDoc|addDoc|fetch\(/i);
});

test('logout clears the signed-in account saved matchups on a shared device', async () => {
  const auth = await read('src/app/core/auth/auth.service.ts');
  assert.match(auth, /const accountId = auth\.currentUser\?\.uid/);
  assert.match(auth, /await signOut\(auth\)/);
  assert.match(auth, /clearOfflineMatchupSnapshotsForAccount\(accountId\)/);
});

test('the saved matchup component narrows the nullable opponent before building its team list', async () => {
  const component = await read(
    'src/app/features/cycles/cycle-one/components/offline-matchup-snapshot/offline-matchup-snapshot.ts',
  );
  assert.match(component, /const snapshot = this\.snapshot\(\);/);
  assert.match(component, /\[snapshot\.teamA, \.\.\.\(snapshot\.teamB \? \[snapshot\.teamB\] : \[\]\)\]/);
  assert.doesNotMatch(component, /this\.snapshot\(\)\.teamB \? \[this\.snapshot\(\)\.teamB\]/);
});

test('the saved matchup interface is visibly stale, read-only, mobile-safe, and action-free', async () => {
  const [template, styles] = await Promise.all([
    read('src/app/features/cycles/cycle-one/components/offline-matchup-snapshot/offline-matchup-snapshot.html'),
    read('src/app/features/cycles/cycle-one/components/offline-matchup-snapshot/offline-matchup-snapshot.css'),
  ]);
  assert.match(template, /Saved matchup/);
  assert.match(template, /Read only/);
  assert.match(template, /No Draft, roster, waiver, commissioner, or testing action was queued/);
  assert.match(template, /sourceScoringVersion/);
  assert.match(template, /offline-marker-live/);
  assert.match(template, /Reload live matchup/);
  assert.doesNotMatch(template, /Draft pick|Submit claim|Add player|Drop player|Finalize|Advance One NHL Day/i);
  assert.doesNotMatch(template, /role="dialog"|backdrop|bottom-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
  assert.match(styles, /grid-template-columns:\s*repeat\(3/);
  assert.match(styles, /@media \(max-width: 480px\)[\s\S]*?width:\s*100%/);
});

test('the service worker remains GET-only under the current RC51 shell version', async () => {
  const worker = await read('public/rinkrat-sw.js');
  assert.match(worker, /RINKRAT_CACHE_VERSION = 'rc51-v1'/);
  assert.match(worker, /request\.method !== 'GET'/);
  assert.doesNotMatch(worker, /addEventListener\(['"]sync['"]/);
  assert.doesNotMatch(worker, /indexedDB|competitive.*queue/i);
});

test('N1B remains Hosting-only and preserves protected systems', async () => {
  const [scoringRules, scoringEngine, projectionV11, rules, indexes, runtime, productionRuntime, freezeSource, appCheckSource, canarySource, cacheSource, packageSource] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cache = JSON.parse(cacheSource);
  const packageJson = JSON.parse(packageSource);
  assert.equal(sha256(scoringRules), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(sha256(scoringEngine), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(sha256(projectionV11), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(sha256(rules), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(sha256(indexes), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 53/);
  assert.match(productionRuntime, /Release Candidate 53/);
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1c');
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchn1b:core'], /verify:batchn1a:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1c:core/);
});

test('documentation and roadmap record exact-route stale access and site-first proof', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_MOBILE_N1B_OFFLINE_MATCHUPS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.44/);
  assert.match(roadmap, /# \[x\] N1\.3/);
  assert.match(roadmap, /# \[x\] LOG\.58/);
  assert.match(runbook, /Maximum snapshots per account: 12/);
  assert.match(runbook, /Maximum age: 7 days/);
  assert.match(runbook, /exact account\/league\/cycle\/matchup/i);
  assert.match(runbook, /Hosting only/i);
  assert.doesNotMatch(runbook, /--only functions|--only firestore:rules/);
  assert.match(readme, /Mobile Batch N1B — Saved Read-Only Matchups/);
  assert.match(releaseRunbook, /Release Candidate 53 \/ Operations Batch O1C/);
  assert.match(releaseRunbook, /npm run verify:batcho1c/);
  assert.match(releaseRunbook, /rinkrat-rc53-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc53-invite-beta/);
});
