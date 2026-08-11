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

test('the football guide uses four honest position archetypes without inventing an LW/RW split', () => {
  assert.equal(TRAINING_CAMP_FOOTBALL_COMPARISONS.length, 4);

  const [wings, centers, defense, goalies] = TRAINING_CAMP_FOOTBALL_COMPARISONS;

  assert.deepEqual(wings.hockeyPositions, ['LW', 'RW']);
  assert.equal(wings.footballRole, 'Outside wide receivers');
  assert.equal(wings.footballBadge, 'WR');

  assert.deepEqual(centers.hockeyPositions, ['C']);
  assert.match(centers.footballRole, /slot receivers/i);
  assert.equal(centers.footballBadge, 'WR');

  assert.deepEqual(defense.hockeyPositions, ['D']);
  assert.match(defense.footballRole, /workhorse running backs/i);
  assert.equal(defense.footballBadge, 'RB');

  assert.deepEqual(goalies.hockeyPositions, ['G']);
  assert.equal(goalies.footballRole, 'Quarterbacks');
  assert.equal(goalies.footballBadge, 'QB');
});

test('the center-versus-wing teaching split matches Projection V11 position priors', async () => {
  const projection = await read('src/app/core/projection/projection-v11.util.ts');

  const lw = projection.match(/LW:\s*\{([\s\S]*?)\n\s*\},\n\s*C:/)?.[1] ?? '';
  const center = projection.match(/C:\s*\{([\s\S]*?)\n\s*\},\n\s*RW:/)?.[1] ?? '';
  const rw = projection.match(/RW:\s*\{([\s\S]*?)\n\s*\},\n\s*D:/)?.[1] ?? '';

  assert.ok(lw && center && rw, 'Projection V11 position priors should remain readable');
  assert.equal(lw.trim(), rw.trim(), 'LW and RW priors should remain identical');
  assert.match(lw, /assists:\s*0\.31/);
  assert.match(center, /assists:\s*0\.36/);
  assert.match(lw, /powerPlayPoints:\s*0\.13/);
  assert.match(center, /powerPlayPoints:\s*0\.15/);
  assert.match(lw, /averageTimeOnIceMinutes:\s*15\.8/);
  assert.match(center, /averageTimeOnIceMinutes:\s*16\.2/);
});

test('the comparison appears at the bottom of Build Your Club and remains progressively collapsible', async () => {
  const template = await read('src/app/features/onboarding/training-camp/training-camp.html');
  const positionGuideIndex = template.indexOf('class="position-value-guide"');
  const footballGuideIndex = template.indexOf('class="football-comparison-guide"');
  const movesCaseIndex = template.indexOf("@case ('moves')");

  assert.ok(positionGuideIndex >= 0);
  assert.ok(footballGuideIndex > positionGuideIndex);
  assert.ok(movesCaseIndex > footballGuideIndex);
  assert.match(template, /<details class="football-comparison-guide" open>/);
  assert.match(template, /Know fantasy football\?/);
  assert.match(template, /Positional value reminder/);
  assert.match(template, /not an exact point-for-point comparison/i);
  assert.doesNotMatch(template, /football-comparison-guide[^>]*(role="dialog"|aria-modal)/);
});

test('the guide explains raw points, replacement value, and the center nuance clearly', async () => {
  const template = await read('src/app/features/onboarding/training-camp/training-camp.html');
  const data = await read('src/app/features/onboarding/training-camp/training-camp-football-comparison.data.ts');

  assert.match(template, /quarterbacks often outscore running backs and wide receivers/i);
  assert.match(template, /alternatives at the same position/i);
  assert.match(template, /left and right wings the same way/i);
  assert.match(template, /slightly more playmaking-oriented baseline/i);
  assert.match(data, /Goals · shots · assists · hits/);
  assert.match(data, /Ice time · blocks · hits · shots/);
  assert.match(data, /Saves · save percentage · wins · shutouts/);
});

test('the guide is readable on phones without a horizontal comparison rail', async () => {
  const css = await read('src/app/features/onboarding/training-camp/training-camp.css');

  assert.match(css, /\.football-comparison-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(
    css,
    /@media \(max-width: 680px\)[\s\S]*?\.football-comparison-grid\s*\{\s*grid-template-columns:\s*1fr;/,
  );
  assert.match(css, /\.football-comparison-guide > summary:focus-visible|\.football-comparison-guide > summary/);
  assert.doesNotMatch(css, /\.football-comparison-grid[\s\S]{0,180}overflow-x:\s*auto/);
});

test('the onboarding addition does not change Production Scoring V3 or Projection V11', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});

test('B1A release, verification, documentation, and permanent roadmap stay synchronized', async () => {
  const [packageSource, readme, docs, rootRoadmap, docsRoadmap, runtime, productionRuntime] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchb1a:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchb1a-football-position-guide/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchb1a'], /verify:batchs3b-1/);
  assert.match(packageJson.scripts['verify:batchb1a'], /test:batchb1a:run/);
  assert.match(packageJson.scripts['verify:batchb1a'], /validate:release-manifest/);
  assert.match(readme, /Release Candidate 19 \/ Onboarding Batch B1A/);
  assert.match(readme, /verify:batchb1a/);
  assert.match(docs, /Onboarding Batch B1A — Fantasy-Football Position Translation/);
  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(rootRoadmap, /Version 1\.7\.2/);
  assert.match(rootRoadmap, /# \[x\] B1\.22/);
  assert.match(rootRoadmap, /# \[x\] LOG\.14/);
  assert.match(runtime, /Release Candidate 19/);
  assert.match(productionRuntime, /Release Candidate 19/);
});
