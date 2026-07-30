import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const liveScoringSource = await readFile(
  new URL('../../src/app/core/live-scoring/live-scoring.service.ts', import.meta.url),
  'utf8',
);
const cyclePageSource = await readFile(
  new URL('../../src/app/features/cycles/cycle-one/cycle-one.ts', import.meta.url),
  'utf8',
);
const functionSource = await readFile(
  new URL('../../functions/src/league-automation.ts', import.meta.url),
  'utf8',
);
const functionIndexSource = await readFile(
  new URL('../../functions/src/index.ts', import.meta.url),
  'utf8',
);

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('browser live-scoring service is read-only and delegates mutations to callable functions', () => {
  assert.doesNotMatch(
    liveScoringSource,
    /\b(setDoc|updateDoc|writeBatch|runTransaction|deleteDoc|addDoc)\b/,
  );
  assert.match(liveScoringSource, /requestLeagueLiveScoringRefresh/);
  assert.match(liveScoringSource, /openNextCompetitionPeriod/);
  assert.match(liveScoringSource, /Compatibility no-op/);
});

test('matchup page no longer imports browser competition writers', () => {
  const importArea = cyclePageSource.slice(0, cyclePageSource.indexOf('const CYCLE_PROJECTION_WINDOW_DAYS'));

  for (const forbidden of [
    'completeCycle',
    'startNextCycle',
    'reconcileRegularSeasonCycleMatchupCompletion',
    'advanceCompletedRegularSeasonAssetWindows',
    'syncCycleTeamWindows',
    'syncPlayoffWindowBankScores',
    'ensureNextPlayoffBankWindows',
  ]) {
    assert.doesNotMatch(importArea, new RegExp(`\\b${forbidden}\\b`));
  }

  assert.match(importArea, /openNextCompetitionPeriod/);
  assert.match(importArea, /requestLeagueLiveScoringRefresh/);
});

test('manual cycle controls call server authority rather than Firestore lifecycle methods', () => {
  const completeMethod = section(
    cyclePageSource,
    '  async completeCurrentCycleFromCurrentScores(): Promise<void> {',
    '  async startNextCycleFromCurrentCycle(): Promise<void> {',
  );
  const nextMethod = section(
    cyclePageSource,
    '  private async startOrOpenNextCycleAfterCompletion(',
    '  private getAutoCompleteAttemptKey(',
  );

  assert.match(completeMethod, /requestLeagueLiveScoringRefresh\(this\.leagueId\)/);
  assert.doesNotMatch(completeMethod, /\bcompleteCycle\b|\breconcileRegularSeasonCycleMatchupCompletion\b/);
  assert.match(nextMethod, /openNextCompetitionPeriod\(/);
  assert.doesNotMatch(nextMethod, /\bstartNextCycle\(/);
});

test('open-next callable requires commissioner authority and uses the shared server lifecycle', () => {
  const callable = section(
    functionSource,
    'export const openNextCompetitionPeriod = onCall(',
    '/**\n * Clears a stale browser-era lease',
  );

  assert.match(callable, /requireLeagueCommissioner\(request\.auth\?\.uid, leagueId\)/);
  assert.match(callable, /await startNextCycle\(/);
  assert.match(callable, /alreadyExisted: existingNextCycle\.exists/);
  assert.match(functionIndexSource, /openNextCompetitionPeriod/);
});
