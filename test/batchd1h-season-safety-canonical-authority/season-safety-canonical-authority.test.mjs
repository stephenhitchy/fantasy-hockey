import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  decideCanonicalScoringAuthority,
  summarizeCanonicalScoringAuthorityTask,
} from '../../functions/src/shared/core/nhl/nhl-canonical-scoring-authority.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

function observation(overrides = {}) {
  return {
    gameId: 2026020001,
    assetKey: 'skater:101',
    assetType: 'skater',
    sourceVersion: 'a'.repeat(64),
    status: 'matched',
    directPoints: 14.5,
    canonicalPoints: 14.5,
    pointDelta: 0,
    directAppeared: true,
    canonicalAppeared: true,
    reason: 'canonical-live-boxscore',
    ...overrides,
  };
}

test('verified canonical authority selects only an exact same-task match', () => {
  const decision = decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: true,
    observation: observation(),
  });

  assert.equal(decision.selection, 'canonical-verified');
  assert.equal(decision.selectedPoints, 14.5);
  assert.equal(decision.selectedAppeared, true);
  assert.equal(decision.tripCircuitBreaker, false);
});

test('a mismatch uses direct scoring and opens the circuit breaker', () => {
  const decision = decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: true,
    observation: observation({
      status: 'mismatch',
      canonicalPoints: 15.5,
      pointDelta: 1,
      reason: 'score-or-appearance-mismatch',
    }),
  });

  assert.equal(decision.selection, 'direct-fallback');
  assert.equal(decision.selectedPoints, 14.5);
  assert.equal(decision.fallbackReason, 'canonical-score-mismatch');
  assert.equal(decision.tripCircuitBreaker, true);
});

test('missing, incomplete, and misaligned canonical data never replace direct scoring', () => {
  const incomplete = decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: true,
    observation: observation({
      status: 'incomplete',
      canonicalPoints: null,
      canonicalAppeared: true,
      pointDelta: null,
      reason: 'final-settlement-missing',
    }),
  });
  const missing = decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: true,
    observation: observation({
      status: 'canonical-missing',
      sourceVersion: '',
      canonicalPoints: null,
      canonicalAppeared: null,
      pointDelta: null,
      reason: 'canonical-game-missing',
    }),
  });
  const misaligned = decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: false,
    observation: observation(),
  });

  for (const decision of [incomplete, missing, misaligned]) {
    assert.equal(decision.selection, 'direct-fallback');
    assert.equal(decision.selectedPoints, 14.5);
    assert.equal(decision.tripCircuitBreaker, true);
  }
});

test('task summary opens only for a real authority failure, not a no-op task', () => {
  const passDecision = decideCanonicalScoringAuthority({
    configured: true,
    taskVersionAligned: true,
    observation: observation(),
  });
  const pass = summarizeCanonicalScoringAuthorityTask({
    configured: true,
    taskVersionAligned: true,
    decisions: [passDecision],
  });
  const noRelevantComparison = summarizeCanonicalScoringAuthorityTask({
    configured: true,
    taskVersionAligned: true,
    decisions: [],
  });
  const misaligned = summarizeCanonicalScoringAuthorityTask({
    configured: true,
    taskVersionAligned: false,
    decisions: [],
  });

  assert.equal(pass.canonicalUsedCount, 1);
  assert.equal(pass.tripCircuitBreaker, false);
  assert.equal(noRelevantComparison.tripCircuitBreaker, false);
  assert.equal(misaligned.tripCircuitBreaker, true);
  assert.equal(
    misaligned.circuitBreakerReason,
    'canonical-task-version-misaligned',
  );
});

test('cycle scoring publishes canonical points only after direct verification', async () => {
  const source = await read(
    'functions/src/shared/core/cycle/cycle-scoring.service.ts',
  );

  assert.match(source, /decideCanonicalScoringAuthority/);
  assert.match(source, /selectedPoints/);
  assert.match(source, /selectedAppeared/);
  assert.match(source, /canonicalAuthorityTaskVersionAligned/);
  assert.match(source, /directPoints:\s*directScoreResult\.points/);
  assert.match(source, /gameScores\[gameIdKey\] = effectiveScoreResult\.points/);
});

test('server configuration permits one pre-proven Internal Test authority league only', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(
    source,
    /LEAGUE_AUTOMATION_CANONICAL_AUTHORITY_MAX_LEAGUE_COUNT\s*=\s*1/,
  );
  assert.match(source, /ENABLE CANONICAL READ CANARY/);
  assert.match(source, /canonicalAuthorityLeagueIds/);
  assert.match(source, /First save and prove the exact Canary cohort/);
  assert.match(source, /Current version-aligned shadow parity must pass/);
  assert.match(source, /CANONICAL_AUTHORITY_MIN_PARITY_STREAK\s*=\s*3/);
  assert.match(source, /consecutivePassingRunCount/);
  assert.match(source, /successfulTasksSinceCanary < 3/);
  assert.match(source, /queueActivePendingTaskCount/);
  assert.match(source, /mode !== 'canary' && canonicalAuthorityLeagueIds\.length > 0/);
});

test('runtime fallback automatically removes canonical authority but keeps Canary scoring', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /recordCanonicalScoringAuthorityOutcome/);
  assert.match(source, /canonical-authority-circuit-opened/);
  assert.match(source, /server:canonical-circuit-breaker/);
  assert.match(source, /Automatic direct-source fallback/);
  assert.match(source, /canonicalAuthorityLeagueIds\.filter/);
  assert.match(source, /lastDecision:\s*'direct-fallback'/);
  assert.match(source, /canonicalAuthorityContext\.enabled/);
  assert.match(source, /canonicalAuthorityUsedCount/);
  assert.match(source, /canonicalAuthorityFallbackCount/);
});

test('global Primary remains locked while the single-league authority experiment is active', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /canonical-authority-canary-complete/);
  assert.match(source, /canonicalAuthorityLeagueIds\.length === 0/);
  assert.match(source, /Disable the canonical-read Canary/);
});

test('the control center exposes authority status, eligibility, fallback, and circuit state', async () => {
  const [service, component, template] = await Promise.all([
    read('src/app/core/admin/scoring-queue-control.service.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
  ]);

  assert.match(service, /canonicalAuthorityLeagueIds/);
  assert.match(service, /canonicalAuthorityCircuitState/);
  assert.match(component, /toggleCanonicalAuthority/);
  assert.match(component, /ENABLE CANONICAL READ CANARY/);
  assert.match(template, /Verified canonical-read Canary/);
  assert.match(template, /Direct fallback active/);
  assert.match(template, /automatic direct fallback/i);
  assert.match(template, /Preseason launch signal/);
  assert.match(template, /Perfect parity streak/);
  assert.match(service, /seasonSafetyAlerts/);
  assert.match(component, /getSeasonSafetyLabel/);
});

test('D1H preserves scoring, Projection V11, Rules, and indexes', async () => {
  const protectedPaths = [
    ['src/app/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['functions/src/shared/core/scoring/scoring-rules.ts', 'scoringRules'],
    ['src/app/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['functions/src/shared/core/scoring/scoring-engine.ts', 'scoringEngine'],
    ['src/app/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['functions/src/shared/core/projection/projection-v11.util.ts', 'projectionV11'],
    ['firestore.rules', 'firestoreRules'],
    ['firestore.indexes.json', 'firestoreIndexes'],
  ];

  for (const [relativePath, hashKey] of protectedPaths) {
    assert.equal(await sha256(relativePath), PROTECTED_SOURCE_HASHES[hashKey]);
  }
});

test('D1H scripts, documentation, and synchronized roadmaps are present', async () => {
  const [packageJson, readme, docs, rootRoadmap, docsRoadmap] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_DATA_D1H_SEASON_SAFETY_CANONICAL_AUTHORITY.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.match(
    scripts['test:batchd1h:run'],
    /batchd1h-season-safety-canonical-authority/,
  );
  assert.match(scripts['verify:batchd1h:core'], /verify:batchd1g:core/);
  assert.match(readme, /RINKRAT_DATA_D1H_SEASON_SAFETY_CANONICAL_AUTHORITY/);
  assert.match(docs, /automatic direct-source fallback/i);
  assert.match(rootRoadmap, /Version 1\.54\.7/);
  assert.equal(rootRoadmap, docsRoadmap);
});
