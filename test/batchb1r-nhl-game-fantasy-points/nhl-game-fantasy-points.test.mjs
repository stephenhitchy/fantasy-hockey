import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const scoringFactsPath = join(
  projectRoot,
  'src/app/core/scoring/nhl-game-fantasy-points.util.ts',
);
const scoringEnginePath = join(projectRoot, 'src/app/core/scoring/scoring-engine.ts');
const scoringRulesPath = join(projectRoot, 'src/app/core/scoring/scoring-rules.ts');
const gameDetailComponentPath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-game-detail/nhl-game-detail.ts',
);
const gameDetailTemplatePath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-game-detail/nhl-game-detail.html',
);
const gameDetailStylesPath = join(
  projectRoot,
  'src/app/features/dashboard/nhl-game-detail/nhl-game-detail.css',
);
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

async function loadTypescriptModule(sourcePath, outputName) {
  const typescript = await loadTypescript();
  const source = await readFile(sourcePath, 'utf8');
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-game-fantasy-points-'));
  const outputPath = join(directory, outputName);
  await writeFile(outputPath, result.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makePlayer(overrides = {}) {
  return {
    playerId: 10,
    name: { default: 'R. RinkRat' },
    position: 'C',
    goals: 1,
    assists: 2,
    points: 3,
    plusMinus: 1,
    hits: 2,
    powerPlayGoals: 1,
    sog: 4,
    toi: '20:30',
    blockedShots: 1,
    ...overrides,
  };
}

function makeBoxscore(overrides = {}) {
  return {
    gameState: 'OFF',
    awayTeam: { id: 1, abbrev: 'AAA', score: 3 },
    homeTeam: { id: 2, abbrev: 'BBB', score: 2 },
    ...overrides,
  };
}

function goal({
  sortOrder,
  teamId,
  scorerId,
  assist1PlayerId,
  assist2PlayerId,
  situationCode = '1551',
  periodType = 'REG',
}) {
  return {
    typeDescKey: 'goal',
    sortOrder,
    situationCode,
    periodDescriptor: { number: periodType === 'OT' ? 4 : 3, periodType },
    details: {
      eventOwnerTeamId: teamId,
      scoringPlayerId: scorerId,
      assist1PlayerId,
      assist2PlayerId,
    },
  };
}

function makePlayByPlay() {
  return {
    gameState: 'OFF',
    plays: [
      goal({ sortOrder: 1, teamId: 1, scorerId: 100, assist1PlayerId: 10, situationCode: '1451' }),
      goal({ sortOrder: 2, teamId: 2, scorerId: 200 }),
      goal({ sortOrder: 3, teamId: 1, scorerId: 101, assist2PlayerId: 10 }),
      goal({ sortOrder: 4, teamId: 2, scorerId: 201 }),
      goal({ sortOrder: 5, teamId: 1, scorerId: 10, situationCode: '1541' }),
    ],
  };
}

test('exact final NHL evidence maps into the unchanged Scoring V4 engine', async () => {
  const [factsUtility, scoringEngine, scoringRules] = await Promise.all([
    loadTypescriptModule(scoringFactsPath, 'facts.mjs'),
    loadTypescriptModule(scoringEnginePath, 'engine.mjs'),
    loadTypescriptModule(scoringRulesPath, 'rules.mjs'),
  ]);
  const facts = factsUtility.buildNhlSkaterGameScoringFacts(
    makePlayer(),
    makeBoxscore(),
    makePlayByPlay(),
  );

  assert.ok(facts);
  assert.equal(facts.phase, 'final');
  assert.deepEqual(facts.stats, {
    position: 'F',
    goals: 1,
    primaryAssists: 1,
    secondaryAssists: 1,
    shotsOnGoal: 4,
    hits: 2,
    blockedShots: 1,
    plusMinus: 1,
    powerPlayPoints: 1,
    shortHandedPoints: 1,
    gameWinningGoal: true,
    overtimeGoal: false,
    timeOnIceMinutes: 20.5,
  });
  assert.equal(
    scoringEngine.calculateSkaterGameBreakdown(
      facts.stats,
      scoringRules.defaultScoringRules,
    ).total,
    28.5,
  );
});

test('live calculations preserve the existing provisional special-teams boundary', async () => {
  const factsUtility = await loadTypescriptModule(scoringFactsPath, 'facts.mjs');
  const facts = factsUtility.buildNhlSkaterGameScoringFacts(
    makePlayer(),
    makeBoxscore({ gameState: 'LIVE' }),
    { ...makePlayByPlay(), gameState: 'LIVE' },
  );

  assert.ok(facts);
  assert.equal(facts.phase, 'live');
  assert.equal(facts.stats.powerPlayPoints, 1);
  assert.equal(facts.stats.shortHandedPoints, 0);
  assert.equal(facts.stats.gameWinningGoal, false);
  assert.equal(facts.stats.overtimeGoal, false);
});

test('each team box score ranks skaters by exact-game fantasy points', async () => {
  const factsUtility = await loadTypescriptModule(scoringFactsPath, 'facts.mjs');
  const players = [
    makePlayer({ playerId: 1 }),
    makePlayer({ playerId: 2 }),
    makePlayer({ playerId: 3 }),
    makePlayer({ playerId: 4 }),
    makePlayer({ playerId: 5 }),
  ];
  const sorted = factsUtility.sortNhlSkatersByFantasyPoints(
    players,
    new Map([
      [1, 4.5],
      [2, 12.25],
      [3, 12.25],
      [5, -1.5],
    ]),
  );

  assert.deepEqual(
    sorted.map((player) => player.playerId),
    [2, 3, 1, 5, 4],
  );
});

test('overtime and game-winning bonuses apply only to a proven final scorer', async () => {
  const factsUtility = await loadTypescriptModule(scoringFactsPath, 'facts.mjs');
  const player = makePlayer({
    position: 'D',
    goals: 1,
    assists: 0,
    points: 1,
    powerPlayGoals: 0,
    toi: '25:00',
  });
  const facts = factsUtility.buildNhlSkaterGameScoringFacts(
    player,
    makeBoxscore({
      awayTeam: { id: 1, abbrev: 'AAA', score: 1 },
      homeTeam: { id: 2, abbrev: 'BBB', score: 0 },
    }),
    {
      gameState: 'OFF',
      plays: [goal({ sortOrder: 1, teamId: 1, scorerId: 10, periodType: 'OT' })],
    },
  );

  assert.ok(facts);
  assert.equal(facts.stats.position, 'D');
  assert.equal(facts.stats.gameWinningGoal, true);
  assert.equal(facts.stats.overtimeGoal, true);
});

test('missing or inconsistent provider evidence stays unavailable instead of becoming zero', async () => {
  const factsUtility = await loadTypescriptModule(scoringFactsPath, 'facts.mjs');

  assert.equal(
    factsUtility.buildNhlSkaterGameScoringFacts(makePlayer(), makeBoxscore(), null),
    null,
  );
  assert.equal(
    factsUtility.buildNhlSkaterGameScoringFacts(
      makePlayer({ assists: 3 }),
      makeBoxscore(),
      makePlayByPlay(),
    ),
    null,
  );
  assert.equal(
    factsUtility.buildNhlSkaterGameScoringFacts(
      makePlayer(),
      makeBoxscore({ gameState: 'FUT' }),
      makePlayByPlay(),
    ),
    null,
  );
  assert.equal(
    factsUtility.buildNhlSkaterGameScoringFacts(
      makePlayer({ toi: undefined }),
      makeBoxscore(),
      makePlayByPlay(),
    ),
    null,
  );
});

test('box score and player detail expose the calculation without creating new NHL requests', async () => {
  const [component, template, styles, playerComponent, playerTemplate] = await Promise.all([
    readFile(gameDetailComponentPath, 'utf8'),
    readFile(gameDetailTemplatePath, 'utf8'),
    readFile(gameDetailStylesPath, 'utf8'),
    readFile(playerDetailComponentPath, 'utf8'),
    readFile(playerDetailTemplatePath, 'utf8'),
  ]);

  assert.match(component, /calculateSkaterGameBreakdown/);
  assert.match(component, /buildNhlSkaterGameScoringFacts/);
  assert.match(component, /sortNhlSkatersByFantasyPoints/);
  assert.match(component, /defaultScoringRules/);
  assert.doesNotMatch(component, /getRegularSeasonGameLog/);
  assert.match(template, /RinkRat FP/);
  assert.match(template, /Highest RinkRat FP first/);
  assert.match(template, /Live estimate/);
  assert.match(template, /Awaiting data/);
  assert.match(template, /It does not confirm that the game counted in a fantasy lineup/);
  assert.match(styles, /\.nhl-player-fantasy-score/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) 92px/);

  assert.match(playerComponent, /buildNhlSkaterGameScoringFacts/);
  assert.doesNotMatch(playerComponent, /getRegularSeasonGameLog/);
  assert.match(playerTemplate, /RinkRat game fantasy points/);
  assert.match(playerTemplate, /View scoring breakdown/);
  assert.match(playerTemplate, /combined team-goalie unit, not an individual goalie/);
  assert.match(playerTemplate, /does not indicate whether this performance counted/);
});

test('Batch B1R inherits the prior release gate and leaves competitive authority untouched', async () => {
  const [packageSource, documentation] = await Promise.all([
    readFile(join(projectRoot, 'package.json'), 'utf8'),
    readFile(join(projectRoot, 'docs/RINKRAT_PRODUCT_B1R_NHL_GAME_FANTASY_POINTS.md'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts?.['verify:batchb1r:core'] ?? '', /verify:batchb1q:core/);
  assert.match(packageJson.scripts?.['verify:batchb1r:core'] ?? '', /test:batchb1r:run/);
  assert.match(documentation, /read-only/i);
  assert.match(documentation, /Production Scoring V4 is unchanged/);
  assert.match(documentation, /No Functions, Firestore Rules,\s+indexes, or TTLs/);
});
