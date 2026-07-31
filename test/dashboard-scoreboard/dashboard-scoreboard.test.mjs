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
    formatNhlGameStatus,
    formatNhlScoreboardHeading,
    getNhlScoreboardRefreshDelay,
    selectDashboardNhlGames,
  } = await loadUtility();

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

  await suite.test('labels today separately from the next available NHL slate', () => {
    const now = new Date(2026, 9, 10, 12, 0, 0);
    assert.equal(formatNhlScoreboardHeading('2026-10-10', now), "Today's NHL Games");
    assert.match(formatNhlScoreboardHeading('2026-10-12', now), /^Next NHL Games · /);
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
    dashboardTemplate,
    dashboardStyles,
    nhlService,
    functions,
  ] = await Promise.all([
    readFile(componentPath, 'utf8'),
    readFile(templatePath, 'utf8'),
    readFile(dashboardTemplatePath, 'utf8'),
    readFile(dashboardStylesPath, 'utf8'),
    readFile(nhlServicePath, 'utf8'),
    readFile(functionsPath, 'utf8'),
  ]);

  await suite.test('loads the NHL feed independently from fantasy league data', () => {
    assert.match(dashboardTemplate, /<app-nhl-scoreboard/);
    assert.match(component, /getNhlScoreNow/);
    assert.doesNotMatch(component, /Firestore|LeagueSummary|matchup/i);
  });

  await suite.test('uses the existing protected NHL proxy with a short live-score cache', () => {
    assert.match(nhlService, /`\$\{NHL_API_BASE_URL\}\/score\/now`/);
    assert.match(functions, /\/\^\\\/v1\\\/score\\\/now\$\//);
    assert.match(functions, /max-age=15, s-maxage=20/);
  });

  await suite.test('keeps live and favorite-team games prominent without showing every game card', () => {
    assert.match(template, /Around the NHL/);
    assert.match(template, /visibleGames\(\)/);
    assert.match(template, /favorite-team games first/);
    assert.match(component, /selectDashboardNhlGames/);
  });

  await suite.test('gives league names the full card width and up to two readable lines', () => {
    assert.match(dashboardStyles, /\.league-card-top\s*\{[^}]*flex-direction:\s*column/s);
    assert.match(dashboardStyles, /-webkit-line-clamp:\s*2/);
    assert.match(dashboardStyles, /\.league-card-badges\s*\{[^}]*width:\s*100%/s);
    assert.doesNotMatch(
      dashboardStyles,
      /\.league-identity h3,\s*\.league-identity p\s*\{[^}]*white-space:\s*nowrap/s,
    );
  });
});
