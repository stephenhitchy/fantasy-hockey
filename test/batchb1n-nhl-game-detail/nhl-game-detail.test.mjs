import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const detailDirectory = join(
  projectRoot,
  'src/app/features/dashboard/nhl-game-detail',
);
const utilPath = join(detailDirectory, 'nhl-game-detail.util.ts');
const componentPath = join(detailDirectory, 'nhl-game-detail.ts');
const templatePath = join(detailDirectory, 'nhl-game-detail.html');
const stylesPath = join(detailDirectory, 'nhl-game-detail.css');
const routesPath = join(projectRoot, 'src/app/app.routes.ts');
const scoreboardComponentPath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.ts',
);
const scoreboardTemplatePath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.html',
);
const scoreboardStylesPath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-scoreboard/nhl-scoreboard.css',
);
const nhlServicePath = join(projectRoot, 'src/app/core/nhl/nhl-api.service.ts');
const playerDetailComponentPath = join(
  projectRoot,
  'src/app/features/players/player-detail/player-detail.ts',
);
const playerDetailTemplatePath = join(
  projectRoot,
  'src/app/features/players/player-detail/player-detail.html',
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
  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-nhl-game-detail-'));
  const outputPath = join(directory, 'nhl-game-detail-util.mjs');
  await writeFile(outputPath, result.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeTeams() {
  return {
    awayTeam: {
      id: 1,
      abbrev: 'AAA',
      score: 3,
      sog: 28,
      commonName: { default: 'Visitors' },
      placeName: { default: 'Away City' },
    },
    homeTeam: {
      id: 2,
      abbrev: 'BBB',
      score: 4,
      sog: 31,
      commonName: { default: 'Hosts' },
      placeName: { default: 'Home City' },
    },
  };
}

function makeRoster() {
  return [
    {
      teamId: 1,
      playerId: 10,
      firstName: { default: 'Away' },
      lastName: { default: 'Scorer' },
      headshot: 'https://assets.nhle.com/away.png',
    },
    {
      teamId: 1,
      playerId: 11,
      firstName: { default: 'First' },
      lastName: { default: 'Assist' },
    },
    {
      teamId: 2,
      playerId: 20,
      firstName: { default: 'Home' },
      lastName: { default: 'Scorer' },
      headshot: 'https://assets.nhle.com/home.png',
    },
  ];
}

function skater(overrides) {
  return {
    playerId: 10,
    name: { default: 'A. Scorer' },
    position: 'C',
    goals: 1,
    assists: 1,
    points: 2,
    plusMinus: 1,
    pim: 0,
    hits: 2,
    powerPlayGoals: 0,
    sog: 4,
    faceoffWinningPctg: 0.55,
    toi: '18:20',
    blockedShots: 1,
    ...overrides,
  };
}

function goalie(overrides = {}) {
  return {
    playerId: 30,
    name: { default: 'G. Goalie' },
    position: 'G',
    goalsAgainst: 3,
    toi: '60:00',
    starter: true,
    shotsAgainst: 28,
    saves: 25,
    savePctg: 0.892857,
    pim: 0,
    ...overrides,
  };
}

test('Batch B1N NHL game detail behavior', async (suite) => {
  const utility = await loadUtility();

  await suite.test('accepts only a stable ten-digit NHL game id', () => {
    assert.equal(utility.parseNhlGameId('2024030416'), 2024030416);
    assert.equal(utility.parseNhlGameId('22'), null);
    assert.equal(utility.parseNhlGameId('../2024030416'), null);
    assert.equal(utility.parseNhlGameId(null), null);
  });

  await suite.test('formats scheduled, live, intermission, overtime, and shootout states', () => {
    assert.equal(
      utility.formatNhlGameDetailStatus({
        startTimeUTC: '2026-10-10T23:00:00Z',
        gameState: 'FUT',
      }, new Date('2026-10-10T12:00:00-07:00')),
      '4:00 PM',
    );
    assert.equal(
      utility.formatNhlGameDetailStatus({
        gameState: 'LIVE',
        periodDescriptor: { number: 2, periodType: 'REG' },
        clock: { timeRemaining: '08:43' },
      }),
      '2nd · 08:43',
    );
    assert.equal(
      utility.formatNhlGameDetailStatus({
        gameState: 'CRIT',
        periodDescriptor: { number: 3, periodType: 'REG' },
        clock: { inIntermission: true },
      }),
      '3rd intermission',
    );
    assert.equal(
      utility.formatNhlGameDetailStatus({
        gameState: 'OFF',
        gameOutcome: { lastPeriodType: 'OT' },
      }),
      'Final/OT',
    );
    assert.equal(
      utility.formatNhlGameDetailStatus({
        gameState: 'OFF',
        gameOutcome: { lastPeriodType: 'SO' },
      }),
      'Final/SO',
    );
  });

  await suite.test('orders exact-game goals and resolves scorers, assists, score, and supported labels', () => {
    const teams = makeTeams();
    const playByPlay = {
      ...teams,
      rosterSpots: makeRoster(),
      plays: [
        {
          eventId: 2,
          typeDescKey: 'goal',
          sortOrder: 30,
          timeInPeriod: '04:00',
          situationCode: '0651',
          periodDescriptor: { number: 3, periodType: 'REG' },
          details: {
            scoringPlayerId: 20,
            eventOwnerTeamId: 2,
            awayScore: 3,
            homeScore: 4,
          },
        },
        {
          eventId: 1,
          typeDescKey: 'goal',
          sortOrder: 10,
          timeInPeriod: '01:15',
          situationCode: '1451',
          periodDescriptor: { number: 1, periodType: 'REG' },
          details: {
            scoringPlayerId: 10,
            assist1PlayerId: 11,
            eventOwnerTeamId: 1,
            awayScore: 1,
            homeScore: 0,
          },
        },
      ],
    };
    const events = utility.buildNhlGameScoringEvents(playByPlay, teams);

    assert.deepEqual(events.map((event) => event.id), ['1', '2']);
    assert.equal(events[0].scorerName, 'Away Scorer');
    assert.deepEqual(events[0].assists, [{ id: 11, name: 'First Assist' }]);
    assert.equal(events[0].scoreLabel, '1–0');
    assert.deepEqual(events[0].tags, ['Shorthanded']);
    assert.deepEqual(events[1].tags, ['Empty net']);
  });

  await suite.test('treats a shootout as one deciding team score instead of counting every attempt', () => {
    const teams = makeTeams();
    const rows = utility.buildNhlGamePeriodScores({
      ...teams,
      plays: [
        { typeDescKey: 'period-start', sortOrder: 1, periodDescriptor: { number: 1, periodType: 'REG' } },
        { typeDescKey: 'goal', sortOrder: 2, periodDescriptor: { number: 1, periodType: 'REG' }, details: { eventOwnerTeamId: 1 } },
        { typeDescKey: 'period-start', sortOrder: 3, periodDescriptor: { number: 4, periodType: 'OT' } },
        { typeDescKey: 'goal', sortOrder: 4, periodDescriptor: { number: 5, periodType: 'SO' }, details: { eventOwnerTeamId: 2 } },
      ],
    }, {
      ...teams,
      gameOutcome: { lastPeriodType: 'SO' },
    });

    assert.deepEqual(rows, [
      { key: '1:REG', label: '1st', away: 1, home: 0 },
      { key: '4:OT', label: 'OT', away: 0, home: 0 },
      { key: 'shootout', label: 'SO', away: 0, home: 1 },
    ]);
  });

  await suite.test('keeps missing team totals unavailable while preserving actual zeroes', () => {
    const teams = makeTeams();
    const rows = utility.buildNhlGameTeamComparison({
      ...teams,
      playerByGameStats: {
        awayTeam: { forwards: [skater({ powerPlayGoals: 0, pim: 0 })], defense: [], goalies: [] },
      },
    });
    const powerPlay = rows.find((row) => row.label === 'Power-play goals');

    assert.deepEqual(powerPlay, { label: 'Power-play goals', away: '0', home: '—' });
  });

  await suite.test('uses exact play-by-play penalty durations when they are available', () => {
    const teams = makeTeams();
    const rows = utility.buildNhlGameTeamComparison({
      ...teams,
      playerByGameStats: {
        awayTeam: { forwards: [skater({ pim: 10 })], defense: [], goalies: [] },
        homeTeam: { forwards: [skater({ pim: 8 })], defense: [], goalies: [] },
      },
    }, {
      plays: [
        { typeDescKey: 'penalty', details: { eventOwnerTeamId: 1, duration: 2 } },
        { typeDescKey: 'penalty', details: { eventOwnerTeamId: 1, duration: 4 } },
        { typeDescKey: 'penalty', details: { eventOwnerTeamId: 2, duration: 2 } },
      ],
    });

    assert.deepEqual(
      rows.find((row) => row.label === 'Penalty minutes'),
      { label: 'Penalty minutes', away: '6', home: '2' },
    );
  });

  await suite.test('selects deterministic statistical leaders without calling them official stars', () => {
    const teams = makeTeams();
    const performers = utility.buildNhlGameTopPerformers({
      ...teams,
      playerByGameStats: {
        awayTeam: {
          forwards: [skater({ playerId: 10, points: 3, goals: 2 })],
          defense: [skater({ playerId: 11, name: { default: 'D. Helper' }, points: 2, goals: 0 })],
          goalies: [],
        },
        homeTeam: {
          forwards: [skater({ playerId: 20, name: { default: 'H. Scorer' }, points: 1 })],
          defense: [],
          goalies: [goalie()],
        },
      },
    }, { rosterSpots: makeRoster() });

    assert.deepEqual(performers.map((performer) => performer.playerId), [10, 11, 30]);
    assert.equal(performers[0].name, 'Away Scorer');
    assert.equal(performers[2].headline, '25/28 saves');
    assert.equal(utility.formatNhlSavePercentage(0), '.000');
    assert.equal(utility.formatNhlSavePercentage(undefined), '—');
  });

  await suite.test('keeps live leaders available while the NHL feed is still missing time on ice', () => {
    const teams = makeTeams();
    const performers = utility.buildNhlGameTopPerformers({
      ...teams,
      gameState: 'LIVE',
      playerByGameStats: {
        awayTeam: {
          forwards: [
            skater({ playerId: 10, toi: undefined }),
            skater({ playerId: 11, name: { default: 'D. Ready' }, toi: '02:10' }),
          ],
          defense: [],
          goalies: [],
        },
        homeTeam: {
          forwards: [],
          defense: [],
          goalies: [goalie({ toi: undefined, shotsAgainst: 0, saves: 0 })],
        },
      },
    }, { rosterSpots: makeRoster() });

    assert.deepEqual(performers.map((performer) => performer.playerId), [11, 10]);
    assert.equal(performers[1].basis, '4 shots · — TOI');
  });
});

test('Batch B1N NHL game detail source contracts', async (suite) => {
  const [
    component,
    template,
    styles,
    routes,
    scoreboardComponent,
    scoreboardTemplate,
    scoreboardStyles,
    nhlService,
    playerDetailComponent,
    playerDetailTemplate,
  ] = await Promise.all([
    readFile(componentPath, 'utf8'),
    readFile(templatePath, 'utf8'),
    readFile(stylesPath, 'utf8'),
    readFile(routesPath, 'utf8'),
    readFile(scoreboardComponentPath, 'utf8'),
    readFile(scoreboardTemplatePath, 'utf8'),
    readFile(scoreboardStylesPath, 'utf8'),
    readFile(nhlServicePath, 'utf8'),
    readFile(playerDetailComponentPath, 'utf8'),
    readFile(playerDetailTemplatePath, 'utf8'),
  ]);

  await suite.test('routes the exact stable game id through the authenticated app shell', () => {
    assert.match(routes, /path: 'nhl\/games\/:gameId'/);
    assert.match(scoreboardComponent, /\['\/nhl', 'games', game\.id\]/);
    assert.match(scoreboardTemplate, /getGameDetailsLabel\(game\)/);
  });

  await suite.test('keeps card details and roster badges as separate valid controls', () => {
    assert.match(scoreboardTemplate, /class="nhl-game-card-open"/);
    assert.match(scoreboardTemplate, /class="nhl-roster-presence"/);
    const gameControlStart = scoreboardTemplate.indexOf('class="nhl-game-card-open"');
    const gameControlEnd = scoreboardTemplate.indexOf('</button>', gameControlStart);
    const rosterControlStart = scoreboardTemplate.indexOf('class="nhl-roster-presence"');
    assert.ok(gameControlStart >= 0 && gameControlEnd > gameControlStart);
    assert.ok(rosterControlStart > gameControlEnd);
    assert.match(scoreboardStyles, /\.nhl-game-card-open\s*\{[^}]*position:\s*absolute[^}]*touch-action:\s*pan-x pan-y/s);
    assert.match(scoreboardStyles, /\.nhl-roster-presence\s*\{[^}]*z-index:\s*2/s);
  });

  await suite.test('suppresses drag activation and restores the scoreboard date and rail position', () => {
    assert.match(scoreboardComponent, /horizontalDistance > 10 \|\| verticalDistance > 10/);
    assert.match(scoreboardComponent, /followedDrag/);
    assert.match(scoreboardComponent, /event\.detail === 0/);
    assert.match(scoreboardComponent, /sessionStorage\.setItem\('rinkrat:nhl-scoreboard-view:v1'/);
    assert.match(scoreboardComponent, /strip\.scrollLeft = Math\.max\(0, scrollLeft\)/);
    assert.match(scoreboardComponent, /Date\.now\(\) - value\.savedAt > 30 \* 60 \* 1000/);
  });

  await suite.test('loads game details on demand, deduplicates through the shared cache, and stops live polling', () => {
    assert.match(component, /Promise\.allSettled/);
    assert.match(component, /getGameBoxscore\(gameId, forceRefresh\)/);
    assert.match(component, /getGamePlayByPlay\(gameId, forceRefresh\)/);
    assert.match(component, /this\.requestGeneration \+= 1/);
    assert.match(component, /this\.clearRefreshTimer\(\)/);
    assert.match(component, /isNhlGameLiveState\(gameState\)/);
    assert.match(component, /}, 30_000\)/);
    assert.match(nhlService, /const existingRequest = apiRequestInFlight\.get\(url\)/);
    assert.match(nhlService, /getGameBoxscore\([\s\S]*forceRefresh:\s*boolean = false/);
    assert.match(nhlService, /getGamePlayByPlay\([\s\S]*forceRefresh:\s*boolean = false/);
  });

  await suite.test('shows honest single-game content without fantasy-window calculations', () => {
    assert.match(template, /Single NHL game/);
    assert.match(template, /Scoring summary/);
    assert.match(template, /Statistical leaders/);
    assert.match(template, /Not official NHL stars/);
    assert.match(template, /Team comparison/);
    assert.match(template, /Individual NHL goalies, not RinkRat team-goalie units/);
    assert.match(template, /NHL single-game statistics only/);
    assert.match(template, /\['\/players', player\.playerId\]/);
    assert.match(template, /\[queryParams\]="\{ nhlGameId: gameId\(\) \}"/);
    assert.match(component, /calculateSkaterGameBreakdown/);
    assert.doesNotMatch(component, /six-game|projection/i);
  });

  await suite.test('resolves real NHL player links to an exact-game detail instead of the demo dead end', () => {
    assert.match(playerDetailComponent, /getGameBoxscore\(gameId\)/);
    assert.match(playerDetailComponent, /getGamePlayByPlay\(gameId\)/);
    assert.match(playerDetailComponent, /findSkaterBoxscoreLine\(boxscore, playerId\)/);
    assert.match(playerDetailComponent, /findGoalieBoxscoreLine\(boxscore, playerId\)/);
    assert.match(playerDetailTemplate, /NHL single-game player detail/);
    assert.match(playerDetailTemplate, /RinkRat FP is a single-game Scoring V4 calculation/);
    assert.match(playerDetailTemplate, /Return to game details/);
  });

  await suite.test('provides narrow mobile, safe-area, focus, and contained scrolling styles', () => {
    assert.match(styles, /env\(safe-area-inset-bottom\)/);
    assert.match(styles, /@media \(max-width: 620px\)/);
    assert.match(styles, /@media \(max-width: 360px\)/);
    assert.match(styles, /\.nhl-period-score-wrap\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(styles, /:focus-visible/);
    assert.match(styles, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
    assert.doesNotMatch(styles, /font-size:\s*[0-7]px/);
  });
});
