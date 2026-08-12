import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { liveScoringTimestampMilliseconds } from '../../src/app/core/live-scoring/live-scoring-freshness.util.ts';

const ROOT = new URL('../../', import.meta.url);
async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function loadTypescript() {
  const projectRequire = createRequire(new URL('../../package.json', import.meta.url));

  try {
    return projectRequire('typescript');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
    }).trim();
    return createRequire(join(globalRoot, 'package.json'))('typescript');
  }
}

function timestampHelperSource(source) {
  const match = source.match(
    /function isUnknownRecord[\s\S]*?export function liveScoringTimestampMilliseconds[\s\S]*?\n}\n\nexport function formatLiveScoringRelativeAge/,
  );

  assert.ok(match, 'Expected to extract the live-scoring timestamp helper.');
  return match[0].replace(
    /\n\nexport function formatLiveScoringRelativeAge$/,
    '\n',
  );
}

test('score-freshness timestamp parsing reads Firestore-like records without overlapping property assertions', () => {
  assert.equal(
    liveScoringTimestampMilliseconds({
      seconds: 10,
      nanoseconds: 500_000_000,
    }),
    10_500,
  );
  assert.equal(liveScoringTimestampMilliseconds({ seconds: 10 }), 10_000);
  assert.equal(
    liveScoringTimestampMilliseconds({
      seconds: 10,
      nanoseconds: 'not-a-number',
    }),
    10_000,
  );
  assert.equal(
    liveScoringTimestampMilliseconds({
      toMillis() {
        return 12_345;
      },
    }),
    12_345,
  );
  assert.equal(
    liveScoringTimestampMilliseconds({
      seconds: '10',
      nanoseconds: 500_000_000,
    }),
    null,
  );
  assert.equal(
    liveScoringTimestampMilliseconds({
      seconds: Number.POSITIVE_INFINITY,
      nanoseconds: 0,
    }),
    null,
  );
});

test('the Angular timestamp utility narrows one unknown record before reading seconds and nanoseconds', async () => {
  const source = await read(
    'src/app/core/live-scoring/live-scoring-freshness.util.ts',
  );

  assert.match(
    source,
    /function isUnknownRecord\(value: unknown\): value is Record<string, unknown>/,
  );
  assert.match(source, /if \(isUnknownRecord\(value\)\)/);
  assert.match(source, /const seconds = value\['seconds'\]/);
  assert.match(source, /const rawNanoseconds = value\['nanoseconds'\]/);
  assert.match(source, /typeof rawNanoseconds === 'number'/);
  assert.doesNotMatch(source, /as \{ nanoseconds: number \}/);
  assert.doesNotMatch(source, /as \{ seconds: number \}/);
  assert.doesNotMatch(source, /as \{ nanoseconds\?: unknown \}/);
});

test('the exact timestamp helper passes strict semantic TypeScript checking', async () => {
  const typescript = await loadTypescript();
  const source = timestampHelperSource(
    await read('src/app/core/live-scoring/live-scoring-freshness.util.ts'),
  );
  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-d1a-1-timestamp-'));
  const sourcePath = join(directory, 'timestamp-helper.ts');

  try {
    await writeFile(sourcePath, source, 'utf8');
    const compilerOptions = {
      strict: true,
      noEmit: true,
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    };
    const program = typescript.createProgram([sourcePath], compilerOptions);
    const diagnostics = typescript
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) =>
          diagnostic.category === typescript.DiagnosticCategory.Error,
      );

    assert.deepEqual(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: typescript.flattenDiagnosticMessageText(
          diagnostic.messageText,
          ' ',
        ),
      })),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('D1A.1 verification inherits D1A and keeps RC25, Scoring V3, and Projection V11 unchanged', async () => {
  const [
    packageSource,
    runtime,
    productionRuntime,
    scoringRules,
    projectionSnapshot,
    freezePolicySource,
  ] = await Promise.all([
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const freezePolicy = JSON.parse(freezePolicySource);

  assert.match(
    packageJson.scripts['verify:batchd1a-1:core'],
    /verify:batchd1a:core/,
  );
  assert.match(packageJson.scripts['security:ci'], /verify:batchd1a-1:core/);
  assert.equal(freezePolicy.verificationCommand, 'npm run verify:batchd1a-1');
  assert.match(runtime, /Release Candidate 25/);
  assert.match(productionRuntime, /Release Candidate 25/);
  assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*3/);
  assert.match(projectionSnapshot, /SHARED_PROJECTION_VERSION\s*=\s*11/);
});

test('D1A.1 documentation and permanent roadmap record the strict timestamp type hotfix', async () => {
  const [roadmap, docsRoadmap, runbook, readme] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_DATA_D1A_1_TIMESTAMP_TYPE_HOTFIX.md'),
    read('README.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.15\.1/);
  assert.match(roadmap, /# \[x\] D1\.17/);
  assert.match(roadmap, /# \[x\] LOG\.27/);
  assert.match(runbook, /TS2352/);
  assert.match(runbook, /Record<string, unknown>/);
  assert.match(runbook, /runtime behavior is unchanged/i);
  assert.match(readme, /Data Quality Batch D1A\.1/);
  assert.match(readme, /verify:batchd1a-1/);
});
