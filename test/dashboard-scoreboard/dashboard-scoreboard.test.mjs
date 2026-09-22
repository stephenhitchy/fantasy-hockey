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
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.util.ts',
);
const componentPath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.ts',
);
const templatePath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.html',
);
const scoreboardStylesPath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.css',
);
const dashboardTemplatePath = join(
  projectRoot,
  'src/app/features/dashboard/dashboard.html',
);
const dashboardStylesPath = join(
  projectRoot,
  'src/app/features/dashboard/dashboard.css',
);
const nhlServicePath = join(
  projectRoot,
  'src/app/core/nhl/nhl-api.service.ts',
);
const functionsPath = join(projectRoot, 'functions/src/index.ts');
const matchupSourcePath = join(
  projectRoot,
  'src/app/features/cycles/cycle-one/cycle-one.ts',
);
const matchupToolbarPath = join(
  projectRoot,
  'src/app/features/cycles/cycle-one/components/cycle-matchup-toolbar/cycle-matchup-toolbar.html',
);
const matchupCardPath = join(
  projectRoot,
  'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
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
  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-dashboard-scoreboard-'));
  const outputPath = join(directory, 'nhl-scoreboard-util.mjs');
  await writeFile(outputPath, result.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeGame(overrides = {}) {
  return {
    id: 1,
    gameDate: '2026-10-10',
    startTimeUTC: '2026-10-10T23:00:00Z',
    gameState: 'FUT',
    awayTeam: { abbrev: 'BOS', score: undefined },
    homeTeam: { abbrev: 'NYR', score: undefined },
    ...overrides,
  };
}

test('Batch 8A.1 NHL scoreboard behavior', async (suite) => {
  const {
    combineDashboardNhlTeamRosterCounts,
    formatNhlGameDate,
    formatNhlGameStatus,
    formatNhlScoreboardHeading,
    getDashboardNhlRosterGamePointDisplay,
    getDashboardNhlRosterEntryRoute,
    getNhlScoreboardRefreshDelay,
    selectDashboardNhlGames,
  } = await loadUtility();

  await suite.test('combines roster spots across leagues by NHL team', () => {
    assert.deepEqual(
      combineDashboardNhlTeamRosterCounts([
        {
          leagueId: 'league-b',
          leagueName: 'Second League',
          ownerId: 'owner-1',
          rosterCounts: [{
            teamAbbreviation: 'VGK',
            count: 2,
            assets: [
              { assetKey: 'skater-2', assetName: 'Second Wing', position: 'RW', rosterLocation: 'bench', matchupCycleNumber: 2, matchupId: 'matchup-2', scheduledGameIds: [], gameScores: {} },
              { assetKey: 'skater-1', assetName: 'First Wing', position: 'LW', rosterLocation: 'active', matchupCycleNumber: 2, matchupId: 'matchup-2', scheduledGameIds: [22], gameScores: { '22': 4.5 } },
            ],
          }],
        },
        {
          leagueId: 'league-a',
          leagueName: 'First League',
          ownerId: 'owner-1',
          rosterCounts: [
            {
              teamAbbreviation: 'vgk',
              count: 1,
              assets: [{ assetKey: 'goalie-unit-VGK', assetName: 'Vegas Goalie Unit', position: 'G', rosterLocation: 'active', matchupCycleNumber: 1, matchupId: 'matchup-1', scheduledGameIds: [22], gameScores: { '22': 0 } }],
            },
            {
              teamAbbreviation: 'CHI',
              count: 1,
              assets: [{ assetKey: 'skater-3', assetName: 'Chicago Center', position: 'C', rosterLocation: 'ir', matchupCycleNumber: 1, matchupId: 'matchup-1', scheduledGameIds: [], gameScores: {} }],
            },
          ],
        },
      ]),
      [
        {
          teamAbbreviation: 'CHI',
          count: 1,
          entries: [{
            assetKey: 'skater-3',
            assetName: 'Chicago Center',
            position: 'C',
            rosterLocation: 'ir',
            matchupCycleNumber: 1,
            matchupId: 'matchup-1',
            scheduledGameIds: [],
            gameScores: {},
            leagueId: 'league-a',
            leagueName: 'First League',
            ownerId: 'owner-1',
          }],
        },
        {
          teamAbbreviation: 'VGK',
          count: 3,
          entries: [
            {
              assetKey: 'goalie-unit-VGK',
              assetName: 'Vegas Goalie Unit',
              position: 'G',
              rosterLocation: 'active',
              matchupCycleNumber: 1,
              matchupId: 'matchup-1',
              scheduledGameIds: [22],
              gameScores: { '22': 0 },
              leagueId: 'league-a',
              leagueName: 'First League',
              ownerId: 'owner-1',
            },
            {
              assetKey: 'skater-1',
              assetName: 'First Wing',
              position: 'LW',
              rosterLocation: 'active',
              matchupCycleNumber: 2,
              matchupId: 'matchup-2',
              scheduledGameIds: [22],
              gameScores: { '22': 4.5 },
              leagueId: 'league-b',
              leagueName: 'Second League',
              ownerId: 'owner-1',
            },
            {
              assetKey: 'skater-2',
              assetName: 'Second Wing',
              position: 'RW',
              rosterLocation: 'bench',
              matchupCycleNumber: 2,
              matchupId: 'matchup-2',
              scheduledGameIds: [],
              gameScores: {},
              leagueId: 'league-b',
              leagueName: 'Second League',
              ownerId: 'owner-1',
            },
          ],
        },
      ],
    );
  });

  await suite.test('keeps the same NHL player separate in each league and routes each row independently', () => {
    const sharedPlayer = {
      assetKey: 'skater-99',
      assetName: 'Shared Player',
      position: 'C',
      rosterLocation: 'active',
      scheduledGameIds: [22],
      gameScores: { '22': 3.5 },
    };
    const [team] = combineDashboardNhlTeamRosterCounts([
      {
        leagueId: 'league-a',
        leagueName: 'Alpha League',
        ownerId: 'owner-1',
        rosterCounts: [{
          teamAbbreviation: 'VGK',
          count: 1,
          assets: [{ ...sharedPlayer, matchupCycleNumber: 2, matchupId: 'matchup-1' }],
        }],
      },
      {
        leagueId: 'league-b',
        leagueName: 'Beta League',
        ownerId: 'owner-1',
        rosterCounts: [{
          teamAbbreviation: 'VGK',
          count: 1,
          assets: [{ ...sharedPlayer, matchupCycleNumber: 4, matchupId: 'matchup-3' }],
        }],
      },
    ]);

    assert.equal(team.count, 2);
    assert.deepEqual(team.entries.map((entry) => entry.leagueId), ['league-a', 'league-b']);
    assert.deepEqual(
      getDashboardNhlRosterEntryRoute(team.entries[0]),
      ['/leagues', 'league-a', 'cycles', 2, 'matchups', 'matchup-1'],
    );
    assert.deepEqual(
      getDashboardNhlRosterEntryRoute(team.entries[1]),
      ['/leagues', 'league-b', 'cycles', 4, 'matchups', 'matchup-3'],
    );
  });

  await suite.test('orders live games first and then prioritizes the favorite team', () => {
    const games = [
      makeGame({ id: 1, awayTeam: { abbrev: 'ANA' }, homeTeam: { abbrev: 'LAK' } }),
      makeGame({ id: 2, awayTeam: { abbrev: 'VGK' }, homeTeam: { abbrev: 'COL' } }),
      makeGame({ id: 3, gameState: 'LIVE', awayTeam: { abbrev: 'EDM' }, homeTeam: { abbrev: 'CGY' } }),
    ];

    assert.deepEqual(
      selectDashboardNhlGames(games, 'VGK').map((game) => game.id),
      [3, 2, 1],
    );
  });

  await suite.test('formats live, intermission, final overtime, and scheduled game states', () => {
    assert.equal(
      formatNhlGameStatus(makeGame({
        gameState: 'LIVE',
        periodDescriptor: { number: 2, periodType: 'REG' },
        clock: { timeRemaining: '08:43', inIntermission: false },
      })),
      '2nd · 08:43',
    );
    assert.equal(
      formatNhlGameStatus(makeGame({
        gameState: 'CRIT',
        periodDescriptor: { number: 3, periodType: 'REG' },
        clock: { inIntermission: true },
      })),
      '3rd intermission',
    );
    assert.equal(
      formatNhlGameStatus(makeGame({
        gameState: 'OFF',
        gameOutcome: { lastPeriodType: 'OT' },
      })),
      'Final/OT',
    );
    assert.match(
      formatNhlGameStatus(
        makeGame({ startTimeUTC: '2026-10-10T23:00:00Z' }),
        new Date('2026-10-10T12:00:00-07:00'),
      ),
      /PM|AM/i,
    );
  });

  await suite.test('labels today, adjacent dates, and other NHL slates clearly', () => {
    const now = new Date(2026, 9, 10, 12, 0, 0);
    assert.equal(formatNhlScoreboardHeading('2026-10-10', now), "Today's NHL Games");
    assert.equal(formatNhlScoreboardHeading('2026-10-09', now), "Yesterday's NHL Games");
    assert.equal(formatNhlScoreboardHeading('2026-10-11', now), "Tomorrow's NHL Games");
    assert.match(formatNhlScoreboardHeading('2026-10-12', now), /^NHL Games · /);
    assert.match(formatNhlGameDate(makeGame()), /Oct 10/);
    assert.equal(formatNhlGameDate(makeGame({ gameDate: 'not-a-date' })), 'Date unavailable');
  });

  await suite.test('distinguishes saved zero points from pending and non-counting roster spots', () => {
    assert.deepEqual(getDashboardNhlRosterGamePointDisplay({
      rosterLocation: 'active',
      gameId: 22,
      gameState: 'LIVE',
      scheduledGameIds: [22],
      gameScores: { '22': 0 },
    }), { label: '0.0 fantasy points', tone: 'scored' });

    assert.deepEqual(getDashboardNhlRosterGamePointDisplay({
      rosterLocation: 'active',
      gameId: 22,
      gameState: 'LIVE',
      scheduledGameIds: [22],
      gameScores: {},
    }), { label: 'Fantasy points syncing', tone: 'pending' });

    assert.deepEqual(getDashboardNhlRosterGamePointDisplay({
      rosterLocation: 'bench',
      gameId: 22,
      gameState: 'LIVE',
      scheduledGameIds: [],
      gameScores: {},
    }), { label: 'Not scoring in this matchup', tone: 'not-counting' });
  });

  await suite.test('uses a faster refresh only while at least one game is live', () => {
    assert.equal(getNhlScoreboardRefreshDelay([makeGame({ gameState: 'LIVE' })]), 30_000);
    assert.equal(getNhlScoreboardRefreshDelay([makeGame({ gameState: 'FUT' })]), 300_000);
  });
});

test('Batch 8A.1 NHL scoreboard source contracts', async (suite) => {
  const [
    component,
    template,
    scoreboardStyles,
    dashboardTemplate,
    dashboardStyles,
    nhlService,
    functions,
    nhlProxySecurity,
    matchupSource,
    matchupToolbar,
    matchupCard,
  ] = await Promise.all([
    readFile(componentPath, 'utf8'),
    readFile(templatePath, 'utf8'),
    readFile(scoreboardStylesPath, 'utf8'),
    readFile(dashboardTemplatePath, 'utf8'),
    readFile(dashboardStylesPath, 'utf8'),
    readFile(nhlServicePath, 'utf8'),
    readFile(functionsPath, 'utf8'),
    readFile(new URL('../../functions/src/shared/security/nhl-proxy-security.util.ts', import.meta.url), 'utf8'),
    readFile(matchupSourcePath, 'utf8'),
    readFile(matchupToolbarPath, 'utf8'),
    readFile(matchupCardPath, 'utf8'),
  ]);

  await suite.test('loads the NHL feed independently from fantasy league data', () => {
    assert.match(dashboardTemplate, /<app-nhl-scoreboard/);
    assert.match(component, /getNhlScoreNow/);
    assert.doesNotMatch(component, /onSnapshot|LeagueSummary/);
  });

  await suite.test('uses the existing protected NHL proxy with a short live-score cache', () => {
    assert.match(nhlService, /`\$\{NHL_API_BASE_URL\}\/score\/now`/);
    assert.match(nhlService, /`\$\{NHL_API_BASE_URL\}\/score\/\$\{date\}`/);
    assert.match(nhlProxySecurity, /isValidScoreboardPath/);
    assert.match(functions, /max-age=15, s-maxage=20/);
  });

  await suite.test('provides bounded previous, today, and next date navigation', () => {
    assert.match(template, /aria-label="NHL scoreboard dates"/);
    assert.match(template, /openPreviousScoreDate/);
    assert.match(template, /openTodayScoreDate/);
    assert.match(template, /openNextScoreDate/);
    assert.match(component, /getNhlScoreForDate/);
    assert.match(component, /!this\.viewingToday\(\)/);
    assert.match(component, /strip\.scrollLeft = 0/);
    assert.match(template, /This NHL date could not update/);
    assert.match(template, /<time \[attr\.datetime\]="game\.gameDate"/);
    assert.match(template, /getGameDateLabel\(game\)/);
  });

  await suite.test('keeps date arrows on the outer edges and relies on automatic score refreshes', () => {
    assert.match(template, /class="rr-button rr-button--quiet nhl-date-previous"/);
    assert.match(template, /class="rr-button rr-button--quiet nhl-date-next"/);
    assert.match(scoreboardStyles, /\.nhl-date-previous\s*\{[^}]*grid-column:\s*1[^}]*justify-self:\s*start/s);
    assert.match(scoreboardStyles, /\.nhl-date-next\s*\{[^}]*grid-column:\s*3[^}]*justify-self:\s*end/s);
    assert.doesNotMatch(template, /\(click\)="refreshScores\(\)"/);
    assert.doesNotMatch(template, />\s*Update points\s*</);
    assert.doesNotMatch(component, /refreshScores\(\)/);
    assert.match(component, /void this\.refreshRosterGamePoints\(\)/);
    assert.match(component, /this\.scheduleRefresh\(\)/);
    assert.match(component, /retryingError \? 60_000 : getNhlScoreboardRefreshDelay/);
    assert.match(component, /this\.loadScores\(true, this\.requestedDate\(\)\)/);
  });

  await suite.test('keeps live and favorite-team games prominent without showing every game card', () => {
    assert.match(template, /Around the NHL/);
    assert.match(template, /visibleGames\(\)/);
    assert.match(template, /favorite-team games first/);
    assert.match(component, /selectDashboardNhlGames/);
  });

  await suite.test('shows compact per-team roster badges without loading fantasy data in the panel', () => {
    assert.match(component, /rosteredTeamCounts = input/);
    assert.match(component, /getRosteredTeamCountLabel/);
    assert.match(template, /class="nhl-roster-presence"/);
    assert.match(template, /icon-players/);
    assert.match(template, /players\/units/);
  });

  await suite.test('opens an accessible roster breakdown with exact-game points and matchup links', () => {
    assert.match(component, /selectedRosterPresence/);
    assert.match(component, /showModal\(\)/);
    assert.match(component, /rosterTrigger\?\.focus\(\)/);
    assert.match(template, /<dialog/);
    assert.match(template, /autofocus/);
    assert.match(template, /entry\.leagueName/);
    assert.match(template, /nhl-roster-dialog-league/);
    assert.match(template, /entry\.rosterLocation/);
    assert.match(template, /getRosterEntryPointLabel/);
    assert.match(template, /getRosterEntryRoute/);
    assert.match(template, /getRosterEntryLinkLabel/);
    assert.match(component, /refreshDashboardNhlRosterGameContexts/);
    assert.match(component, /getDashboardNhlRosterEntryRoute/);
    assert.match(component, /entry\.assetName.*entry\.leagueName.*destination/s);
    assert.doesNotMatch(template, /'players', entry\.assetKey/);
  });

  await suite.test('calls individual league contests head-to-heads instead of repeating matchup', () => {
    assert.match(matchupSource, /Head-to-Head/);
    assert.match(matchupSource, /getDetailedMatchupHeading/);
    assert.match(matchupToolbar, /getHeadToHeadLabel/);
    assert.match(matchupToolbar, /Head-to-head navigation/);
    assert.match(matchupCard, /getHeadToHeadLabel/);
    assert.doesNotMatch(matchupCard, /\{\{ matchup\.id \}\}/);
  });

  await suite.test('gives league names the full card width and up to two readable lines', () => {
    assert.match(dashboardStyles, /\.league-card-top\s*\{[^}]*flex-direction:\s*column/s);
    assert.match(dashboardStyles, /-webkit-line-clamp:\s*2/);
    assert.match(dashboardStyles, /\.league-card-badges\s*\{[^}]*width:\s*100%/s);
    assert.match(dashboardTemplate, /class="league-title-anchor"/);
    assert.doesNotMatch(dashboardTemplate, /class="league-title-link"/);
    assert.doesNotMatch(
      dashboardStyles,
      /\.league-identity h3,\s*\.league-identity p\s*\{[^}]*white-space:\s*nowrap/s,
    );
  });

  await suite.test('keeps NHL panel children out of the global scoreboard-panel selector', () => {
    assert.match(template, /class="nhl-scoreboard rr-card"/);
    assert.doesNotMatch(template, /class="[^"]*nhl-scoreboard-(?!title)[^"]*"/);
    assert.match(template, /class="nhl-panel-heading"/);
    assert.match(template, /class="nhl-panel-status"/);
  });

  await suite.test('collapses decorative manager-profile artwork on narrow screens', () => {
    assert.match(
      dashboardStyles,
      /@media \(max-width: 640px\)[\s\S]*?\.mascot-rink,[\s\S]*?\.mascot-team-copy\s*\{[^}]*display:\s*none/s,
    );
    assert.match(
      dashboardStyles,
      /@media \(max-width: 640px\)[\s\S]*?\.favorite-team-logo-panel\s*\{[^}]*min-height:\s*0[^}]*height:\s*104px/s,
    );
  });
});
