import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TRAINING_CAMP_FOOTBALL_COMPARISONS } from '../../src/app/features/onboarding/training-camp/training-camp-football-comparison.data.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const content = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(content).digest('hex');
}

test('wingers use a beginner-friendly big-play receiver label', () => {
  const wings = TRAINING_CAMP_FOOTBALL_COMPARISONS.find((comparison) => comparison.cssClass === 'wings');
  assert.ok(wings);
  assert.deepEqual(wings.hockeyPositions, ['LW', 'RW']);
  assert.equal(wings.footballRole, 'Big-play wide receivers');
  assert.equal(wings.headline, 'Fewer chances, bigger scoring swings');
  assert.match(wings.summary, /only a few chances/i);
  assert.match(wings.summary, /long catch or touchdown/i);
  assert.match(wings.summary, /matchup much quieter/i);
  assert.match(wings.draftLesson, /draft for upside/i);
  assert.match(wings.draftLesson, /next can be much quieter/i);
});

test('the current Training Camp and documentation no longer rely on outside-receiver jargon', async () => {
  const [data, docs, rootRoadmap, docsRoadmap] = await Promise.all([
    read('src/app/features/onboarding/training-camp/training-camp-football-comparison.data.ts'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);

  assert.doesNotMatch(data, /outside wide receivers?/i);
  assert.doesNotMatch(docs, /Wings \(LW\/RW\) → outside wide receivers/i);
  assert.match(docs, /Wings \(LW\/RW\) → big-play wide receivers/i);
  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(rootRoadmap, /# \[x\] LOG\.20/);
});

test('the wording refinement preserves the existing four-role teaching model', () => {
  assert.equal(TRAINING_CAMP_FOOTBALL_COMPARISONS.length, 4);
  const [wings, centers, defense, goalies] = TRAINING_CAMP_FOOTBALL_COMPARISONS;
  assert.deepEqual(wings.hockeyPositions, ['LW', 'RW']);
  assert.deepEqual(centers.hockeyPositions, ['C']);
  assert.deepEqual(defense.hockeyPositions, ['D']);
  assert.deepEqual(goalies.hockeyPositions, ['G']);
  assert.equal(wings.footballBadge, 'WR');
  assert.equal(centers.footballBadge, 'WR');
  assert.equal(defense.footballBadge, 'RB');
  assert.equal(goalies.footballBadge, 'QB');
});

test('B1D remains a copy-only change to the competitive model', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    '6f36cf76c72f8199c6a3891692844c9c830103ed618be50497b5270e259da3d3',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});

test('B1D verification and documentation stay synchronized', async () => {
  const [packageSource, readme, docs] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchb1d:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchb1d-training-camp-wing-clarity/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchb1d:core'], /verify:batchs4a:core/);
  assert.match(packageJson.scripts['verify:batchb1d:core'], /test:batchb1d:run/);
  assert.match(packageJson.scripts['verify:batchb1d'], /toolchain:verify/);
  assert.match(readme, /Onboarding Batch B1D/);
  assert.match(readme, /verify:batchb1d/);
  assert.match(docs, /Onboarding Batch B1D — Big-Play Winger Comparison Clarity/);
});
