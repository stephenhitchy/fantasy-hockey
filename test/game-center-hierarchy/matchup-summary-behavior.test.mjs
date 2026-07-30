import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const SOURCE = new URL(
  '../../src/app/features/cycles/cycle-one/cycle-matchup-summary.util.ts',
  import.meta.url,
);

let outputDirectory;
let summary;

function context(overrides = {}) {
  return {
    isComplete: false,
    hasOpponent: true,
    hasCycle: true,
    hasScoring: true,
    scoringLoading: false,
    readyToComplete: false,
    teamAOwnerId: 'owner-a',
    teamBOwnerId: 'owner-b',
    teamAName: 'Ice Rats',
    teamBName: 'Puck Hounds',
    teamAScore: 42.5,
    teamBScore: 36.2,
    teamAProjection: 96.5,
    teamBProjection: 88.1,
    viewerId: 'owner-a',
    playedGames: 48,
    totalGames: 168,
    gamesLeft: 120,
    ...overrides,
  };
}

before(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), 'rinkrat-matchup-summary-'));
  const compiledDirectory = join(outputDirectory, 'compiled');
  const testConfigPath = join(outputDirectory, 'tsconfig.json');

  await writeFile(
    testConfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          rootDir: new URL(
            '../../src/app/features/cycles/cycle-one/',
            import.meta.url,
          ).pathname,
          outDir: compiledDirectory,
          skipLibCheck: true,
        },
        files: [SOURCE.pathname],
      },
      null,
      2,
    ),
  );

  const result = spawnSync('tsc', ['--project', testConfigPath, '--pretty', 'false'], {
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `Unable to compile matchup summary utility for behavior tests.
${result.stdout}
${result.stderr}`,
  );

  summary = require(join(compiledDirectory, 'cycle-matchup-summary.util.js'));
});

after(async () => {
  if (outputDirectory) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

describe('Batch 6B matchup summary behavior', () => {
  test('uses the signed-in manager perspective for live and completed outcomes', () => {
    assert.equal(summary.getMatchupOutcomeHeadline(context()), 'You lead by 6.3');
    assert.equal(
      summary.getMatchupOutcomeHeadline(
        context({ viewerId: 'owner-b', teamAScore: 58.8, teamBScore: 44.1 }),
      ),
      'You trail by 14.7',
    );
    assert.equal(
      summary.getMatchupOutcomeHeadline(context({ isComplete: true })),
      'You won by 6.3',
    );
    assert.equal(
      summary.getMatchupOutcomeHeadline(
        context({ isComplete: true, viewerId: 'owner-b' }),
      ),
      'You lost by 6.3',
    );
  });

  test('handles neutral viewers, ties, and bye matchups without implying ownership', () => {
    assert.equal(
      summary.getMatchupOutcomeHeadline(context({ viewerId: 'league-viewer' })),
      'Ice Rats leads by 6.3',
    );
    assert.equal(
      summary.getMatchupOutcomeHeadline(
        context({ teamAScore: 24.4, teamBScore: 24.4, viewerId: 'owner-b' }),
      ),
      'Your matchup is tied',
    );
    assert.equal(
      summary.getMatchupOutcomeHeadline(
        context({ hasOpponent: false, teamBOwnerId: null, viewerId: 'owner-a' }),
      ),
      'You have a bye',
    );
  });

  test('derives progress stages from counted starter games', () => {
    assert.equal(summary.getMatchupProgressPercent(context()), 28.6);
    assert.equal(summary.getMatchupProgressStageLabel(context()), 'Early in the matchup');
    assert.equal(
      summary.getMatchupProgressStageLabel(context({ playedGames: 90, gamesLeft: 78 })),
      'Midway through the matchup',
    );
    assert.equal(
      summary.getMatchupProgressStageLabel(context({ playedGames: 150, gamesLeft: 18 })),
      'Late in the matchup',
    );
    assert.equal(
      summary.getMatchupProgressStageLabel(context({ playedGames: 164, gamesLeft: 4 })),
      'Nearly complete',
    );
  });

  test('labels projection maturity without presenting a probability or guarantee', () => {
    assert.equal(
      summary.getMatchupProjectionStageLabel(
        context({ playedGames: 0, gamesLeft: 168 }),
      ),
      'Pre-matchup estimate',
    );
    assert.equal(
      summary.getMatchupProjectionStageLabel(context()),
      'Early estimate — many games remain',
    );
    assert.equal(
      summary.getMatchupProjectionStageLabel(
        context({ isComplete: true, playedGames: 168, gamesLeft: 0 }),
      ),
      'Final score — no longer a projection',
    );
  });
});
