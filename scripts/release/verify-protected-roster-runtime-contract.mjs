import { readFile } from 'node:fs/promises';

import { evaluateProtectedRosterRuntimeContract } from './protected-roster-runtime-contract.util.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

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
  rosterActionIdempotency,
  freeAgents,
  browserRosterService,
  rosterActionTransport,
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
  read('functions/src/shared/core/team/roster-action-idempotency.util.ts'),
  read('src/app/features/free-agents/free-agents.ts'),
  read('src/app/core/team/roster.service.ts'),
  read('src/app/core/transactions/roster-action-transport.util.ts'),
]);

const result = evaluateProtectedRosterRuntimeContract({
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
  rosterActionIdempotency,
  freeAgents,
  browserRosterService,
  rosterActionTransport,
});

if (!result.ready) {
  console.error('RinkRat blocked this deployment because the protected roster runtime contract is incomplete.');
  for (const blocker of result.blockers) {
    console.error(`- ${blocker}`);
  }
  process.exitCode = 1;
} else {
  console.log('RinkRat protected roster runtime contract passed: five bench slots, hardened injury ownership, and idempotent add/drop recovery are intact.');
}
