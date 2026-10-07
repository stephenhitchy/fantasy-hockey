import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { evaluateProtectedLiveScoringRuntimeContract } from '../../scripts/release/protected-live-scoring-runtime-contract.util.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function currentContractSources() {
  const [nhlApi, nhlThrottle, leagueAutomation] = await Promise.all([
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
    read('functions/src/shared/core/nhl/nhl-upstream-throttle.util.ts'),
    read('functions/src/league-automation.ts'),
  ]);

  return { nhlApi, nhlThrottle, leagueAutomation };
}

describe('protected live-scoring deployment contract', () => {
  test('the current Functions source preserves D1L-F NHL recovery', async () => {
    const result = evaluateProtectedLiveScoringRuntimeContract(
      await currentContractSources(),
    );

    assert.equal(result.ready, true, result.blockers.join('\n'));
    assert.deepEqual(result.blockers, []);
  });

  test('the stale three-attempt, no-jitter runtime fails closed before deployment', async () => {
    const sources = await currentContractSources();
    const result = evaluateProtectedLiveScoringRuntimeContract({
      ...sources,
      nhlApi: sources.nhlApi
        .replace(
          'const NHL_SCHEDULE_REQUEST_MAX_ATTEMPTS = 5;',
          'const NHL_SCHEDULE_REQUEST_MAX_ATTEMPTS = 3;',
        )
        .replace(
          'addNhlRateLimitRetryJitter(baseRetryDelayMilliseconds)',
          'baseRetryDelayMilliseconds',
        ),
    });

    assert.equal(result.ready, false);
    assert.ok(
      result.blockers.some((blocker) =>
        blocker.includes('five bounded attempts')
      ),
    );
    assert.ok(result.blockers.some((blocker) => blocker.includes('jitter')));
  });

  test('unreviewed worker pressure or unattributed failures fail closed', async () => {
    const sources = await currentContractSources();
    const result = evaluateProtectedLiveScoringRuntimeContract({
      ...sources,
      leagueAutomation: sources.leagueAutomation
        .replace(
          'const MAX_PARALLEL_LEAGUES = 2;',
          'const MAX_PARALLEL_LEAGUES = 4;',
        )
        .replace('leagueId: leagueIds[index],', 'leagueId: "unknown",'),
    });

    assert.equal(result.ready, false);
    assert.ok(result.blockers.some((blocker) => blocker.includes('two-league')));
    assert.ok(result.blockers.some((blocker) => blocker.includes('exact affected league')));
  });

  test('the inherited gate and Firebase predeploy run the live-scoring guard', async () => {
    const [packageSource, firebaseSource] = await Promise.all([
      read('package.json'),
      read('firebase.json'),
    ]);
    const packageJson = JSON.parse(packageSource);
    const firebaseJson = JSON.parse(firebaseSource);

    assert.match(
      packageJson.scripts['release:verify-clean-deploy-source'],
      /verify-protected-live-scoring-runtime-contract\.mjs/,
    );
    assert.match(
      packageJson.scripts['test:batchd1lg:run'],
      /batchd1lg-live-scoring-deployment-contract/,
    );
    assert.match(
      packageJson.scripts['verify:batchd1lg:core'],
      /verify:batchb1y:core/,
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
