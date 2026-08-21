import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [
  betaOperationsSource,
  packageSource,
  documentationSource,
  readmeSource,
  roadmapRootSource,
  roadmapDocsSource,
] = await Promise.all([
  read('functions/src/beta-operations.ts'),
  read('package.json'),
  read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  read('README.md'),
  read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
  read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
]);

test('server scoring trigger summaries retain a concrete total field under strict TypeScript', () => {
  assert.match(
    betaOperationsSource,
    /interface BetaDurationOverview \{[\s\S]*?total: number;[\s\S]*?maximumDurationMilliseconds: number;[\s\S]*?\}/,
  );
  assert.match(
    betaOperationsSource,
    /interface BetaTriggerDurationOverview extends BetaDurationOverview \{[\s\S]*?trigger: string;[\s\S]*?\}/,
  );
  assert.match(
    betaOperationsSource,
    /function durationOverview\(accumulator: BetaDurationAccumulator\): BetaDurationOverview \{/,
  );
  assert.doesNotMatch(
    betaOperationsSource,
    /function durationOverview\(accumulator: BetaDurationAccumulator\): Record<string, number>/,
    'a generic index-signature return type drops the named total property after object spread',
  );
  assert.match(
    betaOperationsSource,
    /const serverScoringByTriggerOverview: BetaTriggerDurationOverview\[\] = \[[\s\S]*?\.sort\(\(left, right\) => right\.total - left\.total/,
  );
  assert.match(betaOperationsSource, /byTrigger: serverScoringByTriggerOverview/);
});

test('B1B.1 verification, CI, documentation, and permanent roadmap remain synchronized', () => {
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchb1b-1:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchb1b-1-functions-duration-type-hotfix/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchb1b-1:core'], /verify:batchb1b:core/);
  assert.match(packageJson.scripts['verify:batchb1b-1:core'], /test:batchb1b-1:run/);
  assert.match(packageJson.scripts['verify:batchb1b-1:core'], /validate:release-manifest/);
  assert.match(packageJson.scripts['verify:batchb1b-1'], /security:dependency-audit/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1b-1|b1c|s4a|b1d|s3d|s3e|s3e-1|s3e-1-1|s3f|d1a|d1a-1|d1b|d1c|c1a|c1b|c1c|c1d|c1e|c1f|c1g|c1h|c1i|c1j|c1k|c1l|c1m|a1a|a1b|a1c|a1d|a1e|a1f|a1g|a1h|a1i|n1a|n1b|v4a|o1a|o1b|o1c|o1d|o1e|o1f|o1g|o1h):core/);
  assert.match(documentationSource, /Beta Operations Batch B1B\.1 — Server Scoring Trigger Type Hotfix/);
  assert.match(readmeSource, /verify:batchb1b-1/);
  assert.equal(roadmapRootSource, roadmapDocsSource);
  assert.match(roadmapRootSource, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmapRootSource, /LOG\.17 .*B1B\.1.*TypeScript/i);
});
