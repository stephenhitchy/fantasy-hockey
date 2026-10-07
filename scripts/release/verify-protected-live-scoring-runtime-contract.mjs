import { readFile } from 'node:fs/promises';

import { evaluateProtectedLiveScoringRuntimeContract } from './protected-live-scoring-runtime-contract.util.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

const [nhlApi, nhlThrottle, leagueAutomation] = await Promise.all([
  read('functions/src/shared/core/nhl/nhl-api.service.ts'),
  read('functions/src/shared/core/nhl/nhl-upstream-throttle.util.ts'),
  read('functions/src/league-automation.ts'),
]);

const result = evaluateProtectedLiveScoringRuntimeContract({
  nhlApi,
  nhlThrottle,
  leagueAutomation,
});

if (!result.ready) {
  console.error('RinkRat blocked this deployment because the protected live-scoring recovery contract is incomplete.');
  for (const blocker of result.blockers) {
    console.error(`- ${blocker}`);
  }
  process.exitCode = 1;
} else {
  console.log('RinkRat protected live-scoring runtime contract passed: D1L-F NHL recovery and measured concurrency are intact.');
}
