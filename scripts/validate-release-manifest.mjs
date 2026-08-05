import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function extract(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match?.[1], `Unable to read ${label}.`);
  return match[1];
}

const [manifestSource, generatedSource, runtimeSource, productionRuntimeSource, scoringSource, projectionSource, firebaseSource] =
  await Promise.all([
    read('public/release-manifest.json'),
    read('src/environments/generated-release-manifest.ts'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('firebase.json'),
  ]);

const manifest = JSON.parse(manifestSource);
const runtimeLabel = extract(runtimeSource, /releaseLabel:\s*['"]([^'"]+)['"]/, 'development release label');
const productionLabel = extract(productionRuntimeSource, /releaseLabel:\s*['"]([^'"]+)['"]/, 'production release label');
const scoringVersion = Number(extract(scoringSource, /CURRENT_SCORING_RULES_VERSION\s*=\s*(\d+)/, 'scoring version'));
const projectionVersion = Number(extract(projectionSource, /SHARED_PROJECTION_VERSION\s*=\s*(\d+)/, 'projection version'));

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.releaseLabel, runtimeLabel);
assert.equal(manifest.releaseLabel, productionLabel);
assert.equal(manifest.scoringRulesVersion, scoringVersion);
assert.equal(manifest.projectionVersion, projectionVersion);
assert.ok(typeof manifest.buildId === 'string' && manifest.buildId.length >= 12);
assert.ok(Number.isFinite(Date.parse(manifest.builtAt)));
assert.ok(typeof manifest.sourceRevision === 'string' && manifest.sourceRevision.length > 0);
assert.match(generatedSource, new RegExp(`"buildId":\\s*"${manifest.buildId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"`));
assert.match(generatedSource, new RegExp(`"releaseLabel":\\s*"${manifest.releaseLabel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"`));

const firebase = JSON.parse(firebaseSource);
const manifestHeader = firebase.hosting.headers.find((entry) => entry.source === '/release-manifest.json');
assert.ok(manifestHeader, 'Firebase Hosting must define a release-manifest cache header.');
assert.ok(
  manifestHeader.headers.some((header) =>
    header.key.toLowerCase() === 'cache-control' && /no-store/i.test(header.value)),
  'release-manifest.json must use a no-store cache policy.',
);

console.log(
  `Release manifest validated: ${manifest.releaseLabel} · ${manifest.buildId} · ` +
  `Scoring V${manifest.scoringRulesVersion} · Projection V${manifest.projectionVersion}.`,
);
