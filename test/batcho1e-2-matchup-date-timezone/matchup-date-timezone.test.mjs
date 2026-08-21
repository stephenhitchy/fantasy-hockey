import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildDashboardLeagueActivity } from '../../src/app/core/league/dashboard-league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function activityInput() {
  return {
    leagueId: 'league-a',
    ownerId: 'owner-a',
    isCommissioner: false,
    teamCount: 6,
    maxTeams: 6,
    teams: [
      { ownerId: 'owner-a', teamName: 'Rink Rats' },
      { ownerId: 'owner-b', teamName: 'Bruins' },
    ],
    draft: { status: 'complete' },
    latestCycle: null,
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
    roster: null,
    waiverClaims: [],
  };
}

test('matchup finalization calendar date is stable in Pacific time', () => {
  const previousTimeZone = process.env.TZ;

  try {
    process.env.TZ = 'America/Los_Angeles';
    const result = buildDashboardLeagueActivity(activityInput());
    assert.equal(result.statusLabel, 'Finalizes Aug 24');
  } finally {
    if (previousTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimeZone;
    }
  }
});

test('dashboard calendar-date formatter explicitly uses UTC', async () => {
  const source = await read('src/app/core/league/dashboard-league-activity.util.ts');

  assert.match(source, /function formatMonthDay\(value: Date\): string/);
  assert.match(source, /timeZone:\s*'UTC'/);
});

test('O1E.2 is included in RC55 verification and the permanent roadmap', async () => {
  const [packageSource, roadmap, docsRoadmap, readme, runbook] = await Promise.all([
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1E_2_MATCHUP_DATE_TIMEZONE.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.50/);
  assert.match(roadmap, /LOG\.69 2026-08-20 — Completed Operations Batch O1E\.2/);
  assert.match(readme, /Release Candidate 59 \/ Operations Batch O1I/);
  assert.match(runbook, /America\/Los_Angeles/);
  assert.match(packageJson.scripts['verify:batcho1i:core'], /verify:batcho1h:core/);
  assert.match(packageJson.scripts['verify:batcho1f:core'], /verify:batcho1e:core/);
  assert.match(packageJson.scripts['verify:batcho1e:core'], /test:batcho1e-2:run/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1i:core/);
});
