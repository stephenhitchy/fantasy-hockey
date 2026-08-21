import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { matchInjuryEntriesToCurrentPlayers } from '../../functions/src/shared/core/player/injury-match-quality.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function entry(overrides = {}) {
  return {
    playerName: 'Exact Player',
    position: 'C',
    teamName: 'Boston Bruins',
    rawStatus: 'Out',
    fantasyStatus: '',
    injuryType: 'Upper Body',
    normalizedStatus: 'out',
    ...overrides,
  };
}

const teamAbbreviation = (teamName) => ({
  'Boston Bruins': 'BOS',
  'New York Rangers': 'NYR',
  'Dallas Stars': 'DAL',
}[teamName] ?? '');

const chooseStronger = (first, second) =>
  second.normalizedStatus === 'injured-reserve' ? second : first;

test('injury matching keeps exact skaters, categorizes unresolved names, and ignores individual goalies', () => {
  const players = [
    { id: 1, fullName: 'Exact Player', position: 'C', nhlTeamAbbreviation: 'BOS' },
    { id: 2, fullName: 'Jordan Example', position: 'C', nhlTeamAbbreviation: 'BOS' },
  ];
  const result = matchInjuryEntriesToCurrentPlayers(
    [
      entry(),
      entry({ playerName: 'Jordon Example' }),
      entry({ playerName: 'Goalie Person', position: 'G' }),
    ],
    players,
    {
      generatedAt: '2026-08-12T23:00:00.000Z',
      resolveTeamAbbreviation: teamAbbreviation,
      chooseStrongerEntry: chooseStronger,
    },
  );

  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.unmatchedNames, ['Jordon Example']);
  assert.equal(result.skippedGoalieCount, 1);
  assert.equal(result.matchQuality.sourceEntryCount, 3);
  assert.equal(result.matchQuality.matchedSkaterCount, 1);
  assert.equal(result.matchQuality.unresolvedSkaterCount, 1);
  assert.equal(result.matchQuality.counts.nameNotFound, 1);
  assert.equal(result.matchQuality.skippedGoalieCount, 1);
  assert.equal(result.matchQuality.issues[0].category, 'name-not-found');
  assert.equal(result.matchQuality.issues[0].resolution, 'unresolved');
  assert.equal(result.matchQuality.issues[0].candidateSuggestions[0].playerName, 'Jordan Example');
});

test('team and position context safely resolve an otherwise ambiguous normalized identity', () => {
  const players = [
    { id: 1, fullName: 'Alex Sample', position: 'C', nhlTeamAbbreviation: 'BOS' },
    { id: 2, fullName: 'Alex Sample', position: 'LW', nhlTeamAbbreviation: 'NYR' },
  ];
  const result = matchInjuryEntriesToCurrentPlayers(
    [entry({ playerName: 'Alex Sample', position: 'LW', teamName: 'New York Rangers' })],
    players,
    {
      generatedAt: '2026-08-12T23:00:00.000Z',
      resolveTeamAbbreviation: teamAbbreviation,
      chooseStrongerEntry: chooseStronger,
    },
  );

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].player.id, 2);
  assert.equal(result.matchQuality.unresolvedSkaterCount, 0);
  assert.equal(result.matchQuality.counts.ambiguousName, 0);
});

test('exact team context resolves a duplicate name while preserving a position advisory', () => {
  const players = [
    { id: 1, fullName: 'Alex Sample', position: 'C', nhlTeamAbbreviation: 'BOS' },
    { id: 2, fullName: 'Alex Sample', position: 'LW', nhlTeamAbbreviation: 'NYR' },
  ];
  const result = matchInjuryEntriesToCurrentPlayers(
    [entry({ playerName: 'Alex Sample', position: 'C', teamName: 'New York Rangers' })],
    players,
    {
      generatedAt: '2026-08-12T23:00:00.000Z',
      resolveTeamAbbreviation: teamAbbreviation,
      chooseStrongerEntry: chooseStronger,
    },
  );

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].player.id, 2);
  assert.equal(result.matchQuality.counts.positionDiscrepancy, 1);
  assert.equal(result.matchQuality.unresolvedSkaterCount, 0);
});

test('verified aliases resolve only canonical roster IDs and missing targets remain blocked', () => {
  const players = [
    { id: 77, fullName: 'Canonical Player', position: 'D', nhlTeamAbbreviation: 'DAL' },
  ];
  const resolved = matchInjuryEntriesToCurrentPlayers(
    [entry({ playerName: 'Public Alias', position: 'D', teamName: 'Dallas Stars' })],
    players,
    {
      generatedAt: '2026-08-12T23:00:00.000Z',
      resolveTeamAbbreviation: teamAbbreviation,
      chooseStrongerEntry: chooseStronger,
      aliases: [
        {
          sourceName: 'Public Alias',
          sourceTeamAbbreviation: 'DAL',
          playerId: 77,
        },
      ],
    },
  );

  assert.equal(resolved.matches[0].player.id, 77);
  assert.equal(resolved.matchQuality.aliasResolvedCount, 1);
  assert.equal(resolved.matchQuality.unresolvedSkaterCount, 0);

  const missing = matchInjuryEntriesToCurrentPlayers(
    [entry({ playerName: 'Broken Alias', position: 'D', teamName: 'Dallas Stars' })],
    players,
    {
      generatedAt: '2026-08-12T23:00:00.000Z',
      resolveTeamAbbreviation: teamAbbreviation,
      chooseStrongerEntry: chooseStronger,
      aliases: [{ sourceName: 'Broken Alias', playerId: 999 }],
    },
  );

  assert.equal(missing.matches.length, 0);
  assert.equal(missing.matchQuality.counts.aliasTargetMissing, 1);
  assert.equal(missing.matchQuality.issues[0].category, 'alias-target-missing');
});

test('current team and position discrepancies remain advisory while a safe identity still matches', () => {
  const players = [
    { id: 5, fullName: 'Moved Player', position: 'RW', nhlTeamAbbreviation: 'NYR' },
  ];
  const result = matchInjuryEntriesToCurrentPlayers(
    [entry({ playerName: 'Moved Player', position: 'C', teamName: 'Boston Bruins' })],
    players,
    {
      generatedAt: '2026-08-12T23:00:00.000Z',
      resolveTeamAbbreviation: teamAbbreviation,
      chooseStrongerEntry: chooseStronger,
    },
  );

  assert.equal(result.matches.length, 1);
  assert.equal(result.matchQuality.unresolvedSkaterCount, 0);
  assert.equal(result.matchQuality.matchedWithAdvisoryCount, 2);
  assert.equal(result.matchQuality.counts.teamDiscrepancy, 1);
  assert.equal(result.matchQuality.counts.positionDiscrepancy, 1);
  assert.ok(
    result.matchQuality.issues.every(
      (issue) => issue.resolution === 'matched-with-advisory',
    ),
  );
});

test('server, browser model, commissioner UI, and Release Readiness share the categorized match-quality contract', async () => {
  const [server, syncService, models, managerTs, managerHtml, managerCss, readiness] = await Promise.all([
    read('functions/src/index.ts'),
    read('src/app/core/player/player-availability-sync.service.ts'),
    read('src/app/core/player/player-availability.models.ts'),
    read('src/app/features/player-availability/player-availability-manager/player-availability-manager.ts'),
    read('src/app/features/player-availability/player-availability-manager/player-availability-manager.html'),
    read('src/app/features/player-availability/player-availability-manager/player-availability-manager.css'),
    read('src/app/core/release/release-readiness.service.ts'),
  ]);

  assert.match(server, /matchInjuryEntriesToCurrentPlayers/);
  assert.match(server, /matchQuality: matchResult\.matchQuality/);
  assert.match(server, /individual goalie entries were intentionally ignored/);
  assert.match(syncService, /function normalizeMatchQuality/);
  assert.match(syncService, /candidateSuggestions/);
  assert.match(models, /interface PlayerAvailabilityMatchQuality/);
  assert.match(managerTs, /unresolvedMatchIssues/);
  assert.match(managerHtml, /Injury Match Quality/);
  assert.match(managerHtml, /Candidate suggestions[\s\S]*never applied automatically/i);
  assert.match(managerCss, /@media \(max-width: 430px\)/);
  assert.match(readiness, /injury-match-quality/);
  assert.match(readiness, /Shared injury identity coverage/);
});

test('D1B remains intact under RC34 while preserving Scoring V3, Projection V11, monitor mode, and Shadow', async () => {
  const [
    runtime,
    productionRuntime,
    scoringRules,
    projectionSnapshot,
    appCheckConfig,
    queueConfig,
    packageSource,
    freezePolicySource,
  ] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('config/app-check-callable-canary.json'),
    read('functions/src/league-automation.ts'),
    read('package.json'),
    read('config/release-freeze/beta-freeze-policy.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const freezePolicy = JSON.parse(freezePolicySource);

  assert.match(runtime, /Release Candidate 59/);
  assert.match(productionRuntime, /Release Candidate 59/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projectionSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.match(appCheckConfig, /"defaultMode": "monitor"/);
  assert.match(queueConfig, /LEAGUE_AUTOMATION_QUEUE_DEFAULT_MODE\s*=\s*'shadow'/);
  assert.match(packageJson.scripts['verify:batchd1b:core'], /verify:batchd1a-1:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:d1b|d1c|c1a|c1b|c1c|c1d|c1e|c1f|c1g|c1h|c1i|c1j|c1k|c1l|c1m|a1a|a1b|a1c|a1d|a1e|a1f|a1g|a1h|a1i|n1a|n1b|v4a|o1a|o1b|o1c|o1d|o1e|o1f|o1g|o1h|o1i):core/);
  assert.equal(freezePolicy.releaseLabel, 'Release Candidate 59');
  assert.equal(freezePolicy.verificationCommand, 'npm run verify:batcho1i');
  assert.equal(freezePolicy.defaultTag, 'rinkrat-rc59-invite-beta');
});

test('D1B documentation and permanent roadmap record categorized injury identity review', async () => {
  const [roadmap, docsRoadmap, runbook, readme, aliases] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_DATA_D1B_INJURY_MATCH_QUALITY.md'),
    read('README.md'),
    read('functions/src/shared/core/player/injury-player-aliases.ts'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.50/);
  assert.match(roadmap, /# \[x\] D1\.11/);
  assert.match(roadmap, /# \[x\] D1\.18/);
  assert.match(roadmap, /# \[x\] LOG\.28/);
  assert.match(runbook, /never guesses/i);
  assert.match(runbook, /Team Goalie Unit/);
  assert.match(runbook, /verify:batchd1b/);
  assert.match(readme, /Release Candidate 59 \/ Operations Batch O1I/);
  assert.match(readme, /## Data Quality Batch D1B/);
  assert.match(aliases, /ESPN_INJURY_PLAYER_ALIASES/);
  assert.match(aliases, /do not add an unverified placeholder/i);
});
