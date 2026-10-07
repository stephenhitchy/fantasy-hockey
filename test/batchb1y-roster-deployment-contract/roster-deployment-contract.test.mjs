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
    cycleService,
    injuryReplacementWindow,
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
    read('functions/src/shared/core/cycle/cycle.service.ts'),
    read('functions/src/shared/core/cycle/injury-replacement-window.util.ts'),
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
    cycleService,
    injuryReplacementWindow,
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
