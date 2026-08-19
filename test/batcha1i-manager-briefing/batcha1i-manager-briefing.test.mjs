import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { buildManagerBriefing } from '../../src/app/core/league/manager-briefing.util.ts';
import { buildDashboardLeagueActivity } from '../../src/app/core/league/dashboard-league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function activity(overrides = {}) {
  return {
    stage: 'matchup-active',
    statusLabel: 'Matchup Active',
    tone: 'info',
    headline: 'vs Blue Line Club',
    detail: 'Matchup 2',
    primaryActionLabel: 'Open Game Center',
    primaryActionRoute: ['/leagues', 'league-a', 'cycles', 2],
    injuredStarterCount: 0,
    queuedMoveCount: 0,
    boundarySlotCount: 0,
    recentWaiverOutcome: null,
    matchup: null,
    ...overrides,
  };
}

function league(id, overrides = {}) {
  return {
    leagueId: id,
    leagueName: `League ${id.toUpperCase()}`,
    leagueLogoId: 'rink-badge',
    leagueLogoPaletteId: 'ice-blue',
    inviteCode: 'ABC123',
    myTeamName: 'Rink Rats',
    teamCount: 8,
    maxTeams: 8,
    isCommissioner: false,
    wins: 2,
    losses: 1,
    ties: 0,
    dashboardActivity: activity(),
    ...overrides,
  };
}

function dashboardInput(overrides = {}) {
  return {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    isCommissioner: false,
    teamCount: 8,
    maxTeams: 8,
    teams: [
      { ownerId: 'owner-a', teamName: 'Rink Rats' },
      { ownerId: 'owner-b', teamName: 'Blue Line Club' },
    ],
    draft: { status: 'complete' },
    latestCycle: null,
    matchup: null,
    myWindows: null,
    opponentWindows: null,
    roster: null,
    waiverClaims: [],
    ...overrides,
  };
}

test('Coach briefing prioritizes one actionable item per league and never exceeds three', () => {
  const now = Date.parse('2026-08-18T18:00:00Z');
  const items = buildManagerBriefing([
    league('a', {
      dashboardActivity: activity({
        injuredStarterCount: 2,
        queuedMoveCount: 1,
        boundarySlotCount: 3,
      }),
    }),
    league('b', {
      dashboardActivity: activity({
        stage: 'draft-live',
        headline: 'Pick 12 of 144',
      }),
    }),
    league('c', {
      dashboardActivity: activity({
        recentWaiverOutcome: {
          waiverId: 'skater-10',
          status: 'awarded',
          assetName: 'Test Player',
          effectiveLabel: 'Matchup 3',
          occurredAt: new Date(now - 60_000),
        },
      }),
    }),
    league('d', {
      dashboardActivity: activity({ queuedMoveCount: 1 }),
    }),
  ], { nowMilliseconds: now, maximumItems: 3 });

  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.kind), [
    'waiver-awarded',
    'injury',
    'draft-live',
  ]);
  assert.equal(new Set(items.map((item) => item.leagueId)).size, items.length);
  assert.equal(items.filter((item) => item.leagueId === 'a').length, 1);
});

test('recent private waiver outcomes expire after 72 hours and preserve direct actions', () => {
  const now = Date.parse('2026-08-18T18:00:00Z');
  const recent = buildManagerBriefing([
    league('a', {
      dashboardActivity: activity({
        recentWaiverOutcome: {
          waiverId: 'skater-20',
          status: 'not-awarded',
          assetName: 'Missed Player',
          effectiveLabel: null,
          occurredAt: new Date(now - 71 * 60 * 60 * 1000).toISOString(),
        },
      }),
    }),
  ], { nowMilliseconds: now });
  const stale = buildManagerBriefing([
    league('a', {
      dashboardActivity: activity({
        recentWaiverOutcome: {
          waiverId: 'skater-20',
          status: 'not-awarded',
          assetName: 'Missed Player',
          effectiveLabel: null,
          occurredAt: new Date(now - 73 * 60 * 60 * 1000),
        },
      }),
    }),
  ], { nowMilliseconds: now });

  assert.equal(recent.length, 1);
  assert.equal(recent[0].headline, 'Waiver missed: Missed Player');
  assert.deepEqual(recent[0].actionRoute, ['/leagues', 'a', 'players']);
  assert.deepEqual(stale, []);
});

test('close matchup alert requires a late active matchup within five points', () => {
  const qualifying = league('a', {
    dashboardActivity: activity({
      matchup: {
        cycleNumber: 4,
        opponentTeamName: 'Blue Line Club',
        myScore: 50.2,
        opponentScore: 53.7,
        scoreStatusLabel: 'Trailing',
        gamesPlayed: 102,
        totalGames: 168,
        gamesRemaining: 66,
        progressPercent: 60.7,
      },
    }),
  });
  const early = league('b', {
    dashboardActivity: activity({
      matchup: { ...qualifying.dashboardActivity.matchup, progressPercent: 59.9 },
    }),
  });
  const wide = league('c', {
    dashboardActivity: activity({
      matchup: {
        ...qualifying.dashboardActivity.matchup,
        myScore: 40,
        opponentScore: 50.1,
      },
    }),
  });

  const items = buildManagerBriefing([qualifying, early, wide]);

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'close-matchup');
  assert.match(items[0].headline, /Down 3\.5 late/);
  assert.deepEqual(items[0].actionRoute, ['/leagues', 'a', 'cycles', 4]);
});

test('dashboard activity derives active one-game boundaries and the latest completed claim', () => {
  const result = buildDashboardLeagueActivity(dashboardInput({
    myWindows: {
      ownerId: 'owner-a',
      cycleNumber: 3,
      windows: [
        { status: 'active', gamesPlayed: 5, gamesLeft: 1 },
        { status: 'active', gamesPlayed: 4, gamesLeft: 2 },
        { status: 'complete', gamesPlayed: 6, gamesLeft: 0 },
      ],
    },
    roster: {
      activeSlots: [
        { asset: { availabilityStatus: 'out' }, pendingMove: null },
        { asset: { availabilityStatus: 'active' }, pendingMove: { id: 'move-1' } },
      ],
    },
    waiverClaims: [
      {
        ownerId: 'owner-a',
        waiverId: 'skater-old',
        waiverAsset: {
          assetType: 'skater',
          position: 'C',
          player: { id: 10, fullName: 'Older Player' },
        },
        moveType: 'drop',
        status: 'not-awarded',
        updatedAt: '2026-08-17T10:00:00Z',
      },
      {
        ownerId: 'owner-a',
        waiverId: 'skater-new',
        waiverAsset: {
          assetType: 'skater',
          position: 'LW',
          player: { id: 11, fullName: 'Newest Player' },
        },
        moveType: 'drop',
        status: 'awarded',
        effectiveLabel: 'Matchup 4',
        processedAt: '2026-08-18T10:00:00Z',
      },
    ],
  }));

  assert.equal(result.injuredStarterCount, 1);
  assert.equal(result.queuedMoveCount, 1);
  assert.equal(result.boundarySlotCount, 1);
  assert.deepEqual(result.recentWaiverOutcome, {
    waiverId: 'skater-new',
    status: 'awarded',
    assetName: 'Newest Player',
    effectiveLabel: 'Matchup 4',
    occurredAt: new Date('2026-08-18T10:00:00Z'),
  });
});

test('boundary and scheduled-move alerts remain concise and route to My Team', () => {
  const items = buildManagerBriefing([
    league('a', { dashboardActivity: activity({ boundarySlotCount: 2 }) }),
    league('b', { dashboardActivity: activity({ queuedMoveCount: 1 }) }),
  ]);

  assert.deepEqual(items.map((item) => item.kind), ['boundary', 'scheduled-move']);
  assert.equal(items[0].headline, '2 slots near rollover');
  assert.deepEqual(items[0].actionRoute, ['/leagues', 'a', 'team']);
  assert.deepEqual(items[1].actionRoute, ['/leagues', 'b', 'team']);
});

test('Dashboard reads waiver outcomes once with a twelve-record bound and no new listener', async () => {
  const [draftService, dashboardService] = await Promise.all([
    read('src/app/core/draft/draft.service.ts'),
    read('src/app/core/league/dashboard-league-activity.service.ts'),
  ]);

  assert.match(draftService, /export async function getOwnerWaiverClaimsOnce/);
  assert.match(draftService, /orderBy\('updatedAt', 'desc'\)/);
  assert.match(draftService, /Math\.min\(25, Math\.max\(1/);
  assert.match(dashboardService, /getOwnerWaiverClaimsOnce\(request\.leagueId, request\.ownerId, 12\)/);
  assert.match(dashboardService, /\.catch\(\(\) => \[\]\)/);
  assert.doesNotMatch(dashboardService, /onSnapshot\(|listenToLeagueWaivers/);
});

test('Dashboard presentation is conditional, capped, inline, and free of explanatory copy', async () => {
  const [template, styles, component] = await Promise.all([
    read('src/app/features/dashboard/dashboard.html'),
    read('src/app/features/dashboard/dashboard.css'),
    read('src/app/features/dashboard/dashboard.ts'),
  ]);

  assert.match(component, /buildManagerBriefing/);
  assert.match(component, /maximumItems:\s*3/);
  assert.match(template, /@if \(managerBriefing\(\)\.length > 0\)/);
  assert.match(template, /Coach's Briefing/);
  assert.match(template, /Your next decisions/);
  assert.match(template, /\[routerLink\]="item\.actionRoute"/);
  assert.doesNotMatch(template, /Nothing needs attention|No briefing|Here is what this section means/i);
  assert.match(styles, /manager-briefing-action[\s\S]*?min-height:\s*44px/);
  assert.doesNotMatch(styles, /manager-briefing[\s\S]*?position:\s*(?:fixed|sticky)/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet/i);
});

test('A1I remains browser-only and preserves competitive, security, and data boundaries', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    runtime,
    productionRuntime,
    freezeSource,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 47/);
  assert.match(productionRuntime, /Release Candidate 47/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcha1i');
  assert.equal(freeze.defaultTag, 'rinkrat-rc47-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1i:core'], /verify:batcha1h:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcha1i:core/);
});

test('A1I documentation completes the home feed while retaining replay latency as work in progress', async () => {
  const [roadmap, docsRoadmap, readme, runbook, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_PRODUCT_A1I_MANAGER_BRIEFING.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.38/);
  assert.match(roadmap, /# \[x\] A1\.1 Add a personalized manager home feed/);
  assert.match(roadmap, /\[~\] A1\.16 Reduce historical-replay player-data catch-up latency/);
  assert.match(roadmap, /# \[x\] LOG\.56/);
  assert.match(readme, /Release Candidate 47 \/ Product Batch A1I/);
  assert.match(readme, /npm run verify:batcha1i/);
  assert.match(runbook, /Maximum items: 3/);
  assert.match(runbook, /Maximum items from one league: 1/i);
  assert.match(runbook, /Maximum documents: 12/i);
  assert.match(runbook, /Hosting only/i);
  assert.match(releaseRunbook, /rinkrat-rc47-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc47-invite-beta/);
});
