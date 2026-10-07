import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { evaluateProtectedRosterRuntimeContract } from '../../scripts/release/protected-roster-runtime-contract.util.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function currentContractSources() {
  const [
    browserRosterConfig,
    serverRosterConfig,
    rosterAuthority,
    draftAuthority,
    draftAutomation,
    draftPickEngine,
    projectionRanking,
    rosterMoves,
    cycleScoring,
    browserCycleScoring,
    assetCycleWindow,
    browserAssetCycleWindow,
    cycleService,
    injuryReplacementWindow,
    playoffWindowBank,
    leagueAutomation,
    canonicalImpactFeed,
    finalScoreReconciliation,
  ] = await Promise.all([
    read('src/app/core/team/roster-config.ts'),
    read('functions/src/shared/core/team/roster-config.ts'),
    read('functions/src/roster-authority.ts'),
    read('functions/src/draft-authority.ts'),
    read('functions/src/draft-automation.ts'),
    read('functions/src/draft-pick-engine.ts'),
    read('functions/src/shared/core/projection/projection-ranking.util.ts'),
    read('functions/src/roster-moves.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('src/app/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/cycle/asset-cycle-window.service.ts'),
    read('src/app/core/cycle/asset-cycle-window.service.ts'),
    read('functions/src/shared/core/cycle/cycle.service.ts'),
    read('functions/src/shared/core/cycle/injury-replacement-window.util.ts'),
    read('functions/src/shared/core/playoffs/playoff-window-bank.service.ts'),
    read('functions/src/league-automation.ts'),
    read('functions/src/nhl-canonical-impact-feed.ts'),
    read('functions/src/shared/core/nhl/final-score-reconciliation.util.ts'),
  ]);

  return {
    browserRosterConfig,
    serverRosterConfig,
    rosterAuthority,
    draftAuthority,
    draftAutomation,
    draftPickEngine,
    projectionRanking,
    rosterMoves,
    cycleScoring,
    browserCycleScoring,
    assetCycleWindow,
    browserAssetCycleWindow,
    cycleService,
    injuryReplacementWindow,
    playoffWindowBank,
    leagueAutomation,
    canonicalImpactFeed,
    finalScoreReconciliation,
  };
}

describe('protected roster deployment contract', () => {
  test('the current browser and Functions source preserves five-bench injury ownership', async () => {
    const result = evaluateProtectedRosterRuntimeContract(
      await currentContractSources(),
    );

    assert.equal(result.ready, true, result.blockers.join('\n'));
    assert.deepEqual(result.blockers, []);
  });

  test('a three-bench Functions rollback fails closed before deployment', async () => {
    const sources = await currentContractSources();
    const result = evaluateProtectedRosterRuntimeContract({
      ...sources,
      serverRosterConfig: sources.serverRosterConfig.replace(
        'BENCH_SLOT_COUNT = 5',
        'BENCH_SLOT_COUNT = 3',
      ),
      rosterAuthority: sources.rosterAuthority.replace(
        'benchSlots.length !== 5',
        'benchSlots.length !== 3',
      ),
    });

    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes('Functions roster')));
    assert.ok(result.blockers.some((blocker) => blocker.includes('migration')));
  });

  test('removing mixed-player scoring ownership fails closed before deployment', async () => {
    const sources = await currentContractSources();
    const result = evaluateProtectedRosterRuntimeContract({
      ...sources,
      cycleScoring: sources.cycleScoring.replaceAll(
        'getInjuryReplacementAssetKeyByGameId(injuryReplacementPlan)',
        'new Map()',
      ),
    });

    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes('exact game id')));
  });

  test('removing zero-start audit evidence fails closed before deployment', async () => {
    const sources = await currentContractSources();
    const result = evaluateProtectedRosterRuntimeContract({
      ...sources,
      injuryReplacementWindow: sources.injuryReplacementWindow.replace(
        'const retainedSegments = [...priorSegments, currentSegment];',
        'const retainedSegments = [...priorSegments, currentSegment].filter(Boolean);',
      ),
    });

    assert.equal(result.ready, false);
    assert.ok(
      result.blockers.some((blocker) => blocker.includes('Zero-game outgoing')),
    );
  });

  test('removing strict injury evidence and downstream ownership guards fails closed', async () => {
    const sources = await currentContractSources();
    const result = evaluateProtectedRosterRuntimeContract({
      ...sources,
      injuryReplacementWindow: sources.injuryReplacementWindow.replaceAll(
        'hasConsistentInjuryReplacementWindowEvidence',
        'removedWindowEvidenceGuard',
      ),
      cycleScoring: sources.cycleScoring.replaceAll(
        'hasPreservedInjuryReplacementProtectedGameOwnership',
        'removedProtectedScoringGuard',
      ),
      rosterMoves: sources.rosterMoves.replaceAll(
        'assertWindowPreservesSelectedInjuryReplacementPlan',
        'removedMoveEvidenceGuard',
      ),
      playoffWindowBank: sources.playoffWindowBank.replaceAll(
        'hasPreservedInjuryReplacementProtectedGameOwnership',
        'removedProtectedPlayoffGuard',
      ),
      canonicalImpactFeed: '',
      finalScoreReconciliation: '',
    });

    assert.equal(result.ready, false);
    for (const phrase of [
      'exact plan, schedule, owner-map',
      'preserve started injury-game ownership',
      'Repeated injury moves',
      'Playoff bank updates',
      'Canonical impact routing',
      'Final reconciliation',
    ]) {
      assert.ok(
        result.blockers.some((blocker) => blocker.includes(phrase)),
        phrase,
      );
    }
  });

  test('removing asynchronous or playoff current-segment rollover fails closed', async () => {
    const sources = await currentContractSources();
    const regularResult = evaluateProtectedRosterRuntimeContract({
      ...sources,
      cycleService: sources.cycleService.replace(
        'previousCurrentInjurySegment?.scheduledGameIds',
        'previousSummary?.scheduledGameIds',
      ),
    });
    const playoffResult = evaluateProtectedRosterRuntimeContract({
      ...sources,
      playoffWindowBank: '',
    });

    assert.equal(regularResult.ready, false);
    assert.ok(
      regularResult.blockers.some((blocker) =>
        blocker.includes('Regular asynchronous rollover'),
      ),
    );
    assert.equal(playoffResult.ready, false);
    assert.ok(
      playoffResult.blockers.some((blocker) => blocker.includes('Playoff')),
    );
  });

  test('the current inherited gate and Firebase predeploy run the contract guard', async () => {
    const [packageSource, firebaseSource] = await Promise.all([
      read('package.json'),
      read('firebase.json'),
    ]);
    const packageJson = JSON.parse(packageSource);
    const firebaseJson = JSON.parse(firebaseSource);

    assert.match(
      packageJson.scripts['release:verify-clean-deploy-source'],
      /verify-protected-roster-runtime-contract\.mjs/,
    );
    assert.match(
      packageJson.scripts['test:batchb1y:run'],
      /batchb1v-injury-replacement/,
    );
    assert.match(
      packageJson.scripts['verify:batchb1y:core'],
      /verify:batchb1x:core/,
    );
    assert.ok(
      firebaseJson.functions[0].predeploy.some((command) =>
        command.includes('release:verify-clean-deploy-source'),
      ),
    );
    assert.ok(
      firebaseJson.hosting.predeploy.some((command) =>
        command.includes('release:verify-clean-deploy-source'),
      ),
    );
  });
});
