import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const utilPath = join(
  projectRoot,
  'src/app/core/league/dashboard-league-activity.util.ts',
);
const servicePath = join(
  projectRoot,
  'src/app/core/league/dashboard-league-activity.service.ts',
);
const dashboardTemplatePath = join(
  projectRoot,
  'src/app/features/dashboard/dashboard.html',
);
const dashboardSourcePath = join(
  projectRoot,
  'src/app/features/dashboard/dashboard.ts',
);

async function loadTypescript() {
  const localRequire = createRequire(join(projectRoot, 'package.json'));

  try {
    return localRequire('typescript');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, 'package.json'))('typescript');
  }
}

async function loadUtility() {
  const typescript = await loadTypescript();
  const source = await readFile(utilPath, 'utf8');
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-dashboard-command-'));
  const outputPath = join(directory, 'dashboard-command.mjs');
  await writeFile(outputPath, result.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeBaseInput(overrides = {}) {
  return {
    leagueId: 'league-1',
    ownerId: 'owner-a',
    isCommissioner: false,
    teamCount: 4,
    maxTeams: 8,
    teams: [
      { ownerId: 'owner-a', teamName: 'Rink Rats' },
      { ownerId: 'owner-b', teamName: 'Blue Line Club' },
    ],
    draft: null,
    latestCycle: null,
    matchup: null,
    myWindows: null,
    opponentWindows: null,
    roster: null,
    waiverClaims: [],
    ...overrides,
  };
}

function makeDraft(status, overrides = {}) {
  return {
    status,
    totalRounds: 18,
    roundOneOrder: ['owner-a', 'owner-b', 'owner-c', 'owner-d'],
    nextOverallPick: 1,
    scheduledStartAt: null,
    ...overrides,
  };
}

function makeTeamWindows(ownerId, gamesPlayed, gamesLeft) {
  return {
    ownerId,
    windows: [
      { gamesPlayed, gamesLeft },
    ],
  };
}

test('Batch 8A dashboard command center behavior', async (suite) => {
  const { buildDashboardLeagueActivity } = await loadUtility();

  await suite.test('gives commissioners a draft setup action without exposing it to members', () => {
    const commissioner = buildDashboardLeagueActivity(
      makeBaseInput({ isCommissioner: true, draft: makeDraft('setup') }),
    );
    const member = buildDashboardLeagueActivity(
      makeBaseInput({ draft: makeDraft('setup') }),
    );

    assert.equal(commissioner.primaryActionLabel, 'Set Up Draft');
    assert.deepEqual(commissioner.primaryActionRoute, ['/leagues', 'league-1', 'draft', 'setup']);
    assert.equal(member.primaryActionLabel, 'View League');
    assert.deepEqual(member.primaryActionRoute, ['/leagues', 'league-1']);
  });

  await suite.test('uses a state-specific draft room action for scheduled and live drafts', () => {
    const scheduled = buildDashboardLeagueActivity(
      makeBaseInput({
        draft: makeDraft('scheduled', { scheduledStartAt: '2026-08-10T19:00:00-07:00' }),
      }),
    );
    const live = buildDashboardLeagueActivity(
      makeBaseInput({ draft: makeDraft('live', { nextOverallPick: 9 }) }),
    );

    assert.equal(scheduled.statusLabel, 'Draft Scheduled');
    assert.equal(scheduled.primaryActionLabel, 'Open Draft Room');
    assert.match(scheduled.detail, /Scheduled for/);
    assert.equal(live.headline, 'Pick 9 of 72');
    assert.equal(live.primaryActionLabel, 'Enter Draft Room');
  });

  await suite.test('summarizes the user matchup without assuming one league-wide window', () => {
    const activity = buildDashboardLeagueActivity(
      makeBaseInput({
        draft: makeDraft('complete'),
        matchup: {
          id: 'matchup-1',
          cycleNumber: 3,
          teamAOwnerId: 'owner-a',
          teamBOwnerId: 'owner-b',
          teamAScore: 312.4,
          teamBScore: 287.1,
          status: 'active',
        },
        myWindows: makeTeamWindows('owner-a', 32, 52),
        opponentWindows: makeTeamWindows('owner-b', 29, 55),
      }),
    );

    assert.equal(activity.headline, 'vs Blue Line Club');
    assert.equal(activity.matchup.scoreStatusLabel, 'Leading');
    assert.equal(activity.matchup.gamesPlayed, 61);
    assert.equal(activity.matchup.gamesRemaining, 107);
    assert.equal(activity.matchup.totalGames, 168);
    assert.deepEqual(activity.primaryActionRoute, ['/leagues', 'league-1', 'cycles', 3]);
  });

  await suite.test('surfaces only compact roster attention counts', () => {
    const activity = buildDashboardLeagueActivity(
      makeBaseInput({
        draft: makeDraft('complete'),
        roster: {
          activeSlots: [
            { asset: { availabilityStatus: 'out' }, pendingMove: null },
            { asset: { availabilityStatus: 'active' }, pendingMove: { id: 'move-1' } },
            { asset: { rosterStatus: 'injured' }, pendingMove: null },
          ],
        },
      }),
    );

    assert.equal(activity.injuredStarterCount, 2);
    assert.equal(activity.queuedMoveCount, 1);
  });

  await suite.test('uses the latest completed period as a useful fallback', () => {
    const activity = buildDashboardLeagueActivity(
      makeBaseInput({
        draft: makeDraft('complete'),
        latestCycle: {
          cycleNumber: 4,
          status: 'complete',
          phase: 'regular_season',
        },
      }),
    );

    assert.equal(activity.statusLabel, 'Period Complete');
    assert.equal(activity.headline, 'Cycle 4 is complete');
    assert.deepEqual(activity.primaryActionRoute, ['/leagues', 'league-1', 'cycles', 4]);
  });
});

test('Batch 8A source contracts', async (suite) => {
  const [service, template, dashboard] = await Promise.all([
    readFile(servicePath, 'utf8'),
    readFile(dashboardTemplatePath, 'utf8'),
    readFile(dashboardSourcePath, 'utf8'),
  ]);

  await suite.test('loads all active cycles before selecting the owner matchup', () => {
    assert.match(service, /getActiveLeagueCycles/);
    assert.match(service, /getOwnerMatchupAcrossActiveCycles/);
    assert.match(service, /matchup\.status !== 'complete'/);
  });

  await suite.test('keeps dashboard activity opt-in so Account Settings does not pay extra reads', async () => {
    assert.match(dashboard, /includeDashboardActivity:\s*true/);
    const leagueService = await readFile(
      join(projectRoot, 'src/app/core/league/league.service.ts'),
      'utf8',
    );
    assert.match(leagueService, /options:\s*\{ includeDashboardActivity\?: boolean \}/);
    assert.match(leagueService, /options\.includeDashboardActivity/);
  });

  await suite.test('replaces the duplicate club stat with record and one next-action panel', () => {
    assert.doesNotMatch(template, /<span>Your Club<\/span>/);
    assert.match(template, /<span>Record<\/span>/);
    assert.match(template, /<span>Next Up<\/span>/);
    assert.match(template, /activity\.primaryActionRoute/);
  });

  await suite.test('exposes semantic matchup progress and compact attention chips', () => {
    assert.match(template, /role="progressbar"/);
    assert.match(template, /starter games counted/);
    assert.match(template, /starter.*unavailable/s);
    assert.match(template, /scheduled move/);
  });
});
