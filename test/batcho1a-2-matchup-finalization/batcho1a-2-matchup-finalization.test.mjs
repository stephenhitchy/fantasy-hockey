import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildDashboardLeagueActivity } from '../../src/app/core/league/dashboard-league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function dashboardInput(overrides = {}) {
  return {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    isCommissioner: true,
    teamCount: 6,
    maxTeams: 6,
    teams: [
      { ownerId: 'owner-a', teamName: 'Bean League' },
      { ownerId: 'owner-b', teamName: 'Bruins' },
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

test('active matchup status label shows the latest expected finalization date', () => {
  const result = buildDashboardLeagueActivity(dashboardInput({
    matchup: {
      cycleNumber: 8,
      phase: 'regular_season',
      teamAOwnerId: 'owner-a',
      teamBOwnerId: 'owner-b',
      teamAScore: 605.3,
      teamBScore: 567.7,
      winnerOwnerId: null,
      status: 'active',
      updatedAt: '2026-08-19T21:00:00Z',
    },
    myWindows: {
      ownerId: 'owner-a',
      cycleNumber: 8,
      windows: [
        {
          status: 'active',
          gamesPlayed: 5,
          gamesLeft: 1,
          lastScheduledGameDate: '2026-08-23T02:00:00Z',
          scheduledGameDates: ['2026-08-23T02:00:00Z'],
        },
      ],
    },
    opponentWindows: {
      ownerId: 'owner-b',
      cycleNumber: 8,
      windows: [
        {
          status: 'active',
          gamesPlayed: 4,
          gamesLeft: 2,
          lastScheduledGameDate: '2026-08-24T02:00:00Z',
          scheduledGameDates: ['2026-08-24T02:00:00Z'],
        },
      ],
    },
  }));

  assert.equal(result.stage, 'matchup-active');
  assert.equal(result.statusLabel, 'Finalizes Aug 24');
  assert.equal(result.headline, 'vs Bruins');
});


test('matchup calendar labels do not shift backward in Pacific time', () => {
  const previousTimeZone = process.env.TZ;

  try {
    process.env.TZ = 'America/Los_Angeles';

    const result = buildDashboardLeagueActivity(dashboardInput({
      matchup: {
        cycleNumber: 8,
        phase: 'regular_season',
        teamAOwnerId: 'owner-a',
        teamBOwnerId: 'owner-b',
        teamAScore: 605.3,
        teamBScore: 567.7,
        winnerOwnerId: null,
        status: 'active',
      },
      myWindows: {
        ownerId: 'owner-a',
        cycleNumber: 8,
        windows: [],
      },
      opponentWindows: {
        ownerId: 'owner-b',
        cycleNumber: 8,
        windows: [
          {
            status: 'active',
            gamesPlayed: 4,
            gamesLeft: 2,
            lastScheduledGameDate: '2026-08-24T02:00:00Z',
            scheduledGameDates: ['2026-08-24T02:00:00Z'],
          },
        ],
      },
    }));

    assert.equal(result.statusLabel, 'Finalizes Aug 24');
  } finally {
    if (previousTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimeZone;
    }
  }
});

test('complete matchup status label shows the completed date when available', () => {
  const result = buildDashboardLeagueActivity(dashboardInput({
    matchup: {
      cycleNumber: 8,
      phase: 'regular_season',
      teamAOwnerId: 'owner-a',
      teamBOwnerId: 'owner-b',
      teamAScore: 605.3,
      teamBScore: 567.7,
      winnerOwnerId: 'owner-a',
      status: 'complete',
      completedAt: '2026-08-24T05:30:00Z',
    },
    myWindows: {
      ownerId: 'owner-a',
      cycleNumber: 8,
      windows: [],
    },
    opponentWindows: {
      ownerId: 'owner-b',
      cycleNumber: 8,
      windows: [],
    },
  }));

  assert.equal(result.stage, 'matchup-complete');
  assert.equal(result.statusLabel, 'Finalized Aug 24');
});

test('O1A.2 documents the league-card timing clarification without changing competitive systems', async () => {
  const [roadmap, docsRoadmap, readme, util, packageSource] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('src/app/core/league/dashboard-league-activity.util.ts'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.46/);
  assert.match(roadmap, /LOG\.63 2026-08-19 — Completed Operations Batch O1A\.2/);
  assert.match(readme, /Operations Batch O1D/);
  assert.match(util, /buildMatchupStatusLabel/);
  assert.match(util, /Finalizes \$\{formatMonthDay\(latestDate\)\}/);
  assert.match(util, /timeZone:\s*'UTC'/);
  assert.equal(packageJson.scripts['verify:batcho1a-2:core'], 'npm run verify:batcho1a:core && npm run test:batcho1a-2:run && npm run validate:release-manifest');
  assert.equal(packageJson.scripts['verify:batcho1a-2'], 'npm run toolchain:verify && npm run verify:batcho1a-2:core && npm run security:dependency-audit');
});
