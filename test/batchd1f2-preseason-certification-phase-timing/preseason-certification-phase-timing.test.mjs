import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import { runPreseasonScoringCertification } from '../../scripts/certification/run-preseason-scoring-certification.mjs';
import {
  SCORING_PHASE_NAMES,
  ScoringPhaseTimer,
  scoringPhaseTimingForFirestore,
} from '../../functions/src/shared/core/observability/scoring-phase-timing.util.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');

test('preseason certification passes all sixteen deterministic scenarios', () => {
  const report = runPreseasonScoringCertification();

  assert.equal(report.scenarioCount, 16);
  assert.equal(report.passedScenarioCount, 16);
  assert.equal(report.failedScenarioCount, 0);
  assert.equal(report.ready, true);
  assert.equal(report.scenarios.every((scenario) => scenario.passed), true);
});

test('certification covers suppression, TOI, routing, final corrections, and version follow-up', () => {
  const ids = new Set(
    runPreseasonScoringCertification().scenarios.map((scenario) => scenario.id),
  );

  for (const id of [
    'identical-snapshot',
    'clock-only-suppressed',
    'toi-only-deferred',
    'toi-heartbeat-settlement',
    'assist-order-change',
    'final-settlement',
    'post-final-correction',
    'affected-league-routing',
    'incomplete-index-fails-open',
    'duplicate-source-version',
    'newer-version-follow-up-required',
  ]) {
    assert.equal(ids.has(id), true, `Missing certification scenario: ${id}`);
  }
});

test('phase timer accumulates bounded phases and identifies the slowest phase', async () => {
  const timer = new ScoringPhaseTimer();

  timer.add('nhl-schedule-load', 7);
  timer.add('nhl-player-log-load', 70);
  await timer.measure('score-calculation', async () => undefined);

  const snapshot = timer.snapshot(100);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.phases['nhl-schedule-load'], 7);
  assert.equal(snapshot.phases['nhl-player-log-load'], 70);
  assert.equal(snapshot.longestPhase, 'nhl-player-log-load');
  assert.equal(snapshot.longestPhaseDurationMilliseconds, 70);
  assert.equal(snapshot.totalDurationMilliseconds, 100);
  assert.equal(snapshot.unmeasuredDurationMilliseconds >= 0, true);
  assert.deepEqual(Object.keys(snapshot.phases), [...SCORING_PHASE_NAMES]);
});

test('phase timing is converted to a bounded Firestore-safe document', () => {
  const timer = new ScoringPhaseTimer();
  timer.add('nhl-game-data-load', 12.6);
  const saved = scoringPhaseTimingForFirestore(timer.snapshot(20));

  assert.ok(saved);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.longestPhase, 'nhl-game-data-load');
  assert.equal(saved.longestPhaseDurationMilliseconds, 13);
  assert.equal(typeof saved.phases, 'object');
});

test('cycle scoring reports schedule, game-data, player-log, and calculation phases', async () => {
  const source = await read('functions/src/shared/core/cycle/cycle-scoring.service.ts');

  assert.match(source, /export type CycleScoringPhaseName/);
  assert.match(source, /'nhl-schedule-load'/);
  assert.match(source, /'nhl-game-data-load'/);
  assert.match(source, /'nhl-player-log-load'/);
  assert.match(source, /'score-calculation'/);
  assert.match(source, /onPhaseDuration/);
  assert.match(source, /finally \{[\s\S]*onPhaseDuration/s);
});

test('league automation measures the major server phases without changing authority', async () => {
  const source = await read('functions/src/league-automation.ts');

  for (const phase of [
    'lease-and-prerequisites',
    'league-and-team-load',
    'historical-replay-data',
    'roster-move-reconciliation',
    'snapshot-publication',
    'window-and-competition-persistence',
    'control-publication',
    'queue-and-observability',
  ]) {
    assert.match(source, new RegExp(`phaseTimer\\.measure\\(\\s*'${phase}'`));
  }

  assert.match(source, /runLeagueAutomation\(/);
  assert.match(source, /calculateCycleScoring\(/);
  assert.match(source, /persistServerScoring\(/);
});

test('phase evidence is saved on queue schedules, tasks, controls, and replay requests', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /lastPhaseTiming/);
  assert.match(source, /lastLongestPhase/);
  assert.match(source, /phaseTiming: scoringPhaseTimingForFirestore\(result\.phaseTiming\)/);
  assert.match(source, /lastScoringPhaseTiming/);
  assert.match(source, /scoringPhaseTiming: scoringPhaseTimingForFirestore/);
  assert.match(source, /scoringDurationMilliseconds/);
});

test('beta operations aggregate phase histograms in privacy-limited daily shards', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /serverScoringPhases/);
  assert.match(source, /for \(const phase of SCORING_PHASE_NAMES\)/);
  assert.match(source, /addBetaDurationSample/);
  assert.match(source, /betaOperationsDaily/);
});

test('D1F.2 preserves scoring, Projection V11, Firestore Rules, and indexes', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    PROTECTED_SOURCE_HASHES.scoringRules,
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    PROTECTED_SOURCE_HASHES.scoringEngine,
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    PROTECTED_SOURCE_HASHES.projectionV11,
  );
  assert.equal(
    await sha256('firestore.rules'),
    PROTECTED_SOURCE_HASHES.firestoreRules,
  );
});

test('D1F.2 release scripts and documentation remain synchronized', async () => {
  const [packageSource, readme, releaseNotes, rootRoadmap, docsRoadmap] =
    await Promise.all([
      read('package.json'),
      read('README.md'),
      read('docs/RINKRAT_DATA_D1F2_PRESEASON_CERTIFICATION_PHASE_TIMING.md'),
      read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
      read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(packageJson.scripts['test:batchd1f2:run'], /batchd1f2-preseason-certification-phase-timing/);
  assert.match(packageJson.scripts['verify:batchd1f2:core'], /verify:batchd1f:core/);
  assert.match(packageJson.scripts['certify:preseason-scoring'], /run-preseason-scoring-certification/);
  assert.match(readme, /Data Infrastructure Batch D1F\.2/);
  assert.match(releaseNotes, /preseason scoring certification/i);
  assert.match(rootRoadmap, /D1F\.2/);
});

test('D1F.2 does not deploy Rules, indexes, TTL, or automatic Primary changes', async () => {
  const [releaseNotes, deployGuide] = await Promise.all([
    read('docs/RINKRAT_DATA_D1F2_PRESEASON_CERTIFICATION_PHASE_TIMING.md'),
    read('docs/RINKRAT_DATA_D1F_CANONICAL_FACTS_AFFECTED_LEAGUE_INDEX.md'),
  ]);

  assert.match(releaseNotes, /No Firestore Rule, index, TTL, or data migration/);
  assert.match(releaseNotes, /Shadow/);
  assert.match(releaseNotes, /Canary/);
  assert.doesNotMatch(releaseNotes, /automatically enable Primary/i);
  assert.match(deployGuide, /Direct NHL scoring remains authoritative/);
});
