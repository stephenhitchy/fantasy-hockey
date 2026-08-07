import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

const [projectionSource, packageSource, documentationSource, roadmapRoot, roadmapDocs] =
  await Promise.all([
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);

test('projection progress listener uses Firebase Unsubscribe instead of an undefined-return initializer', () => {
  assert.match(
    projectionSource,
    /type Unsubscribe,[\s\S]*?from 'firebase\/firestore';/,
    'the Firebase listener cleanup type must be imported explicitly',
  );
  assert.match(
    projectionSource,
    /let unsubscribe:\s*Unsubscribe\s*=\s*\(\)\s*=>\s*\{\};/,
    'the placeholder cleanup callback must be typed as Firebase Unsubscribe',
  );
  assert.doesNotMatch(
    projectionSource,
    /let unsubscribe\s*=\s*\(\)\s*=>\s*undefined;/,
    'the inferred () => undefined initializer recreates Angular TS2322 when onSnapshot returns () => void',
  );
  assert.match(projectionSource, /unsubscribe\s*=\s*onSnapshot\(/);
});

test('S2A.1 verification and permanent roadmap documentation are synchronized', () => {
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts['test:batchs2a-1:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchs2a-1-angular-unsubscribe-hotfix/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchs2a-1'], /verify:batchs2a/);
  assert.match(packageJson.scripts['verify:batchs2a-1'], /test:batchs2a-1:run/);
  assert.match(packageJson.scripts['verify:batchs2a-1'], /validate:release-manifest/);
  assert.match(documentationSource, /Batch S2A\.1 — Angular Firestore Unsubscribe Type Hotfix/);
  assert.equal(roadmapRoot, roadmapDocs);
  assert.match(roadmapRoot, /Version 1\.(?:4\.1|5)/);
  assert.match(roadmapRoot, /LOG\.6 .*S2A\.1.*Unsubscribe type hotfix/);
});
