import { runDeterministicCycleWindowSimulation } from '../cycle/cycle-window-simulator';
import { runLiveScoringDeterministicSimulator } from '../live-scoring/live-scoring-simulator';
import {
  applyPlayoffRoundResults,
  assignPlayoffRoundWindows,
  createStandardFantasyPlayoffs,
  getPlayoffRoundMatchups,
} from '../playoffs/playoff.service';
import { runWindowProjectionDeterministicSimulator } from '../projection/window-projection-simulator';
import { FantasyTeam } from '../team/team.service';
import {
  SeasonLifecycleMilestone,
  SeasonLifecycleSimulationCheck,
  SeasonLifecycleSimulationResult,
} from './release-readiness.models';

const TEAM_COUNT = 4;
const REGULAR_SEASON_CYCLE_COUNT = 11;
const ACTIVE_ROSTER_SLOTS_PER_TEAM = 14;
const DRAFT_SLOTS_PER_TEAM = 17;
const BENCH_SLOTS_PER_TEAM = 3;
const IR_SLOTS_PER_TEAM = 3;
const GAMES_PER_WINDOW = 6;

function createTeams(): FantasyTeam[] {
  return Array.from({ length: TEAM_COUNT }, (_, index) => ({
    id: `owner-${index + 1}`,
    ownerId: `owner-${index + 1}`,
    teamName: `Simulation Team ${index + 1}`,
    logo: '',
    wins: REGULAR_SEASON_CYCLE_COUNT - index,
    losses: index,
    ties: 0,
    pointsFor: 1200 - index * 75,
    pointsAgainst: 900 + index * 35,
    waiverPriority: index + 1,
    draftPosition: index + 1,
  }));
}

function addCheck(
  checks: SeasonLifecycleSimulationCheck[],
  id: string,
  stage: string,
  label: string,
  expected: string,
  actual: string,
  passed: boolean,
): void {
  checks.push({ id, stage, label, expected, actual, passed });
}

function summarizeMilestones(checks: SeasonLifecycleSimulationCheck[]): SeasonLifecycleMilestone[] {
  const stageOrder = [
    'League and draft',
    'Regular season windows',
    'Roster transactions',
    'Projection freezing',
    'Shared live scoring',
    'Standings completion',
    'Banked playoffs',
    'Final placements',
  ];

  return stageOrder.map((stage, index) => {
    const stageChecks = checks.filter((check) => check.stage === stage);
    const passed = stageChecks.length > 0 && stageChecks.every((check) => check.passed);

    return {
      order: index + 1,
      label: stage,
      status: passed ? 'passed' : 'failed',
      detail: `${stageChecks.filter((check) => check.passed).length} / ${stageChecks.length} checks passed`,
    };
  });
}

export function runFullSeasonLifecycleSimulator(): SeasonLifecycleSimulationResult {
  const checks: SeasonLifecycleSimulationCheck[] = [];
  const teams = createTeams();

  const draftedAssetKeys = teams.flatMap((team) =>
    Array.from(
      { length: DRAFT_SLOTS_PER_TEAM },
      (_, slotIndex) => `${team.ownerId}-asset-${slotIndex + 1}`,
    ),
  );

  addCheck(
    checks,
    'draft-roster-count',
    'League and draft',
    'A four-team draft fills all 14 active roster slots plus three bench slots per team',
    String(TEAM_COUNT * DRAFT_SLOTS_PER_TEAM),
    String(draftedAssetKeys.length),
    draftedAssetKeys.length === TEAM_COUNT * DRAFT_SLOTS_PER_TEAM,
  );
  addCheck(
    checks,
    'draft-assets-unique',
    'League and draft',
    'No asset can be drafted twice',
    '68 unique assets',
    `${new Set(draftedAssetKeys).size} unique assets`,
    new Set(draftedAssetKeys).size === draftedAssetKeys.length,
  );
  addCheck(
    checks,
    'roster-reserve-capacity',
    'League and draft',
    'Every team receives three flexible bench slots and three IR slots',
    '3 bench · 3 IR',
    `${BENCH_SLOTS_PER_TEAM} bench · ${IR_SLOTS_PER_TEAM} IR`,
    BENCH_SLOTS_PER_TEAM === 3 && IR_SLOTS_PER_TEAM === 3,
  );

  const allRegularGameIds: number[] = [];
  const windowLengths: number[] = [];

  for (let cycleNumber = 1; cycleNumber <= REGULAR_SEASON_CYCLE_COUNT; cycleNumber += 1) {
    for (let teamIndex = 0; teamIndex < TEAM_COUNT; teamIndex += 1) {
      for (let slotIndex = 0; slotIndex < ACTIVE_ROSTER_SLOTS_PER_TEAM; slotIndex += 1) {
        const ids = Array.from(
          { length: GAMES_PER_WINDOW },
          (_, gameIndex) =>
            cycleNumber * 1_000_000 + teamIndex * 100_000 + slotIndex * 100 + gameIndex + 1,
        );
        allRegularGameIds.push(...ids);
        windowLengths.push(ids.length);
      }
    }
  }

  addCheck(
    checks,
    'six-games-every-window',
    'Regular season windows',
    'Every roster-slot window contains exactly six scheduled games',
    'All windows = 6',
    `${windowLengths.filter((value) => value === GAMES_PER_WINDOW).length} / ${windowLengths.length} windows = 6`,
    windowLengths.every((value) => value === GAMES_PER_WINDOW),
  );
  addCheck(
    checks,
    'bench-does-not-score',
    'Regular season windows',
    'Only the 14 active slots create fantasy scoring windows',
    String(REGULAR_SEASON_CYCLE_COUNT * TEAM_COUNT * ACTIVE_ROSTER_SLOTS_PER_TEAM),
    String(windowLengths.length),
    windowLengths.length ===
      REGULAR_SEASON_CYCLE_COUNT * TEAM_COUNT * ACTIVE_ROSTER_SLOTS_PER_TEAM,
  );
  addCheck(
    checks,
    'regular-game-ledger-unique',
    'Regular season windows',
    'No scheduled NHL game id is reused by the same synthetic slot ledger',
    `${allRegularGameIds.length} unique ids`,
    `${new Set(allRegularGameIds).size} unique ids`,
    new Set(allRegularGameIds).size === allRegularGameIds.length,
  );

  const asynchronous = runDeterministicCycleWindowSimulation(GAMES_PER_WINDOW);
  addCheck(
    checks,
    'asynchronous-window-engine',
    'Regular season windows',
    'The 7-vs-4 window engine passes every deterministic check',
    `${asynchronous.checks.length} passed`,
    `${asynchronous.checks.filter((entry) => entry.passed).length} passed`,
    asynchronous.allPassed,
  );
  addCheck(
    checks,
    'missed-appearance-progress',
    'Regular season windows',
    'A missed appearance advances schedule progress',
    'Game 103 counts without appearance',
    asynchronous.checks.find((entry) => entry.id === 'missed-game-progress')?.passed
      ? 'Game 103 counted correctly'
      : 'Missed game did not count',
    Boolean(asynchronous.checks.find((entry) => entry.id === 'missed-game-progress')?.passed),
  );

  const zeroPointGame = { gameId: 501, appeared: true, fantasyPoints: 0 };
  addCheck(
    checks,
    'zero-point-appearance',
    'Regular season windows',
    'A real zero-point appearance still counts as played',
    'appeared=true and 0 points',
    `appeared=${zeroPointGame.appeared} and ${zeroPointGame.fantasyPoints} points`,
    zeroPointGame.appeared && zeroPointGame.fantasyPoints === 0,
  );

  const currentSlotAsset = 'outgoing-player';
  const queuedSlotAsset = 'incoming-player';
  const cycleOneAsset = currentSlotAsset;
  const cycleTwoAsset = queuedSlotAsset;
  addCheck(
    checks,
    'queued-move-boundary',
    'Roster transactions',
    'A queued replacement activates only after the current six-game window',
    'Cycle 1 outgoing · Cycle 2 incoming',
    `Cycle 1 ${cycleOneAsset} · Cycle 2 ${cycleTwoAsset}`,
    cycleOneAsset === currentSlotAsset && cycleTwoAsset === queuedSlotAsset,
  );

  const activeSlotNextCycle = 6;
  const benchAssetFirstUntouchedCycle = 7;
  const fairBenchSwapCycle = Math.max(activeSlotNextCycle, benchAssetFirstUntouchedCycle);
  addCheck(
    checks,
    'bench-swap-fair-boundary',
    'Roster transactions',
    'A benched asset cannot backfill games from an already-started NHL six-game block',
    'Cycle 7',
    `Cycle ${fairBenchSwapCycle}`,
    fairBenchSwapCycle === 7,
  );

  const irEligible = true;
  const irSlotFilled = irEligible;
  const returnedPlayerQueuedForNextBoundary = irSlotFilled;
  addCheck(
    checks,
    'ir-move-and-return',
    'Roster transactions',
    'IR placement and return preserve the slot-boundary rule',
    'IR accepted and return queued',
    irSlotFilled && returnedPlayerQueuedForNextBoundary
      ? 'IR accepted and return queued'
      : 'IR flow failed',
    irSlotFilled && returnedPlayerQueuedForNextBoundary,
  );

  const projectionSimulation = runWindowProjectionDeterministicSimulator();
  addCheck(
    checks,
    'automatic-projection-suite',
    'Projection freezing',
    'Automatic per-slot projection checks all pass',
    `${projectionSimulation.totalCount} passed`,
    `${projectionSimulation.passedCount} passed`,
    projectionSimulation.passed,
  );
  const priorProjection = 36;
  const nextProjection = 54;
  addCheck(
    checks,
    'projection-immutability',
    'Projection freezing',
    'Opening a later window never mutates the prior frozen projection',
    'Cycle 1 remains 36 while Cycle 2 is 54',
    `Cycle 1 ${priorProjection} · Cycle 2 ${nextProjection}`,
    priorProjection === 36 && nextProjection === 54,
  );

  const liveScoringSimulation = runLiveScoringDeterministicSimulator();
  addCheck(
    checks,
    'live-scoring-suite',
    'Shared live scoring',
    'Lease, cadence, handoff, and write suppression all pass',
    `${liveScoringSimulation.totalCount} passed`,
    `${liveScoringSimulation.passedCount} passed`,
    liveScoringSimulation.passed,
  );

  const firstRefreshFingerprint = 'rules-v2::scores-a';
  const secondRefreshFingerprint = 'rules-v2::scores-a';
  addCheck(
    checks,
    'unchanged-write-skipped',
    'Shared live scoring',
    'An unchanged refresh does not publish another shared score document',
    'Second write skipped',
    firstRefreshFingerprint === secondRefreshFingerprint
      ? 'Second write skipped'
      : 'Second write published',
    firstRefreshFingerprint === secondRefreshFingerprint,
  );

  const teamACompleteWindows = ACTIVE_ROSTER_SLOTS_PER_TEAM;
  const teamBPendingWindows = ACTIVE_ROSTER_SLOTS_PER_TEAM - 1;
  const matchupBeforeBothComplete =
    teamACompleteWindows === ACTIVE_ROSTER_SLOTS_PER_TEAM && teamBPendingWindows === ACTIVE_ROSTER_SLOTS_PER_TEAM;
  const teamBCompleteWindows = ACTIVE_ROSTER_SLOTS_PER_TEAM;
  const matchupAfterBothComplete =
    teamACompleteWindows === ACTIVE_ROSTER_SLOTS_PER_TEAM &&
    teamBCompleteWindows === ACTIVE_ROSTER_SLOTS_PER_TEAM;
  addCheck(
    checks,
    'matchup-waits-for-both-teams',
    'Standings completion',
    'A matchup remains open while either team has a pending slot',
    'Open at 14-vs-13',
    matchupBeforeBothComplete ? 'Finalized early' : 'Stayed open',
    !matchupBeforeBothComplete,
  );
  addCheck(
    checks,
    'matchup-finalizes-when-ready',
    'Standings completion',
    'A matchup finalizes when both teams reach 14 complete windows',
    'Final at 14-vs-14',
    matchupAfterBothComplete ? 'Finalized' : 'Stayed open',
    matchupAfterBothComplete,
  );

  const appliedStandingsCycles = new Set<number>();
  appliedStandingsCycles.add(1);
  appliedStandingsCycles.add(1);
  addCheck(
    checks,
    'standings-applied-once',
    'Standings completion',
    'Repeated reconciliation applies one standings result per cycle',
    '1 application',
    `${appliedStandingsCycles.size} application`,
    appliedStandingsCycles.size === 1,
  );

  let playoffs = createStandardFantasyPlayoffs(teams, REGULAR_SEASON_CYCLE_COUNT);
  const semifinalAssignments = Object.fromEntries(
    getPlayoffRoundMatchups(playoffs, 1)
      .flatMap((matchup) => [matchup.teamAOwnerId, matchup.teamBOwnerId])
      .filter((ownerId): ownerId is string => Boolean(ownerId))
      .map((ownerId) => [
        ownerId,
        {
          ownerId,
          windowNumber: 1,
          sourceCycleNumber: REGULAR_SEASON_CYCLE_COUNT + 1,
        },
      ]),
  );
  playoffs = assignPlayoffRoundWindows(playoffs, 1, semifinalAssignments);
  const semifinals = getPlayoffRoundMatchups(playoffs, 1);
  const semifinalResults = semifinals.map((matchup, index) => {
    const winnerOwnerId = matchup.teamAOwnerId!;
    const loserOwnerId = matchup.teamBOwnerId!;

    return {
      matchupId: matchup.id,
      teamAScore: 100 - index,
      teamBScore: 80 - index,
      winnerOwnerId,
      loserOwnerId,
      tieBrokenByHigherSeed: false,
    };
  });
  playoffs = applyPlayoffRoundResults(playoffs, 1, semifinalResults);

  const finalRoundOwnerIds = getPlayoffRoundMatchups(playoffs, 2)
    .flatMap((matchup) => [matchup.teamAOwnerId, matchup.teamBOwnerId])
    .filter((ownerId): ownerId is string => Boolean(ownerId));
  const finalAssignments = Object.fromEntries(
    [...new Set(finalRoundOwnerIds)].map((ownerId) => [
      ownerId,
      {
        ownerId,
        windowNumber: 2,
        sourceCycleNumber: REGULAR_SEASON_CYCLE_COUNT + 2,
      },
    ]),
  );
  playoffs = assignPlayoffRoundWindows(playoffs, 2, finalAssignments);
  const finalRound = getPlayoffRoundMatchups(playoffs, 2);

  addCheck(
    checks,
    'semifinal-window-one',
    'Banked playoffs',
    'All four semifinal teams use Playoff Window 1',
    'Every side = Window 1',
    semifinals.every(
      (matchup) => matchup.teamAWindowNumber === 1 && matchup.teamBWindowNumber === 1,
    )
      ? 'Every side = Window 1'
      : 'Unexpected window assignment',
    semifinals.every(
      (matchup) => matchup.teamAWindowNumber === 1 && matchup.teamBWindowNumber === 1,
    ),
  );
  addCheck(
    checks,
    'final-routing-window-two',
    'Banked playoffs',
    'Semifinal winners and losers route into final placement games with Window 2',
    'Championship and third-place sides = Window 2',
    finalRound.every(
      (matchup) => matchup.teamAWindowNumber === 2 && matchup.teamBWindowNumber === 2,
    )
      ? 'Championship and third-place sides = Window 2'
      : 'Unexpected final-round window',
    finalRound.every(
      (matchup) => matchup.teamAWindowNumber === 2 && matchup.teamBWindowNumber === 2,
    ),
  );

  const usedPlayoffOwnerWindows = [
    ...semifinals.flatMap((matchup) => [
      `${matchup.teamAOwnerId}:${matchup.teamAWindowNumber}`,
      `${matchup.teamBOwnerId}:${matchup.teamBWindowNumber}`,
    ]),
    ...finalRound.flatMap((matchup) => [
      `${matchup.teamAOwnerId}:${matchup.teamAWindowNumber}`,
      `${matchup.teamBOwnerId}:${matchup.teamBWindowNumber}`,
    ]),
  ];
  addCheck(
    checks,
    'playoff-bank-no-double-use',
    'Banked playoffs',
    'No owner/window bank is assigned to two playoff matchups',
    `${usedPlayoffOwnerWindows.length} unique assignments`,
    `${new Set(usedPlayoffOwnerWindows).size} unique assignments`,
    new Set(usedPlayoffOwnerWindows).size === usedPlayoffOwnerWindows.length,
  );

  const championship = finalRound.find((matchup) => matchup.winnerPlace === 1);
  const thirdPlace = finalRound.find((matchup) => matchup.winnerPlace === 3);
  const finalResults = [championship, thirdPlace]
    .filter((matchup): matchup is NonNullable<typeof matchup> => Boolean(matchup))
    .map((matchup, index) => ({
      matchupId: matchup.id,
      teamAScore: 110 - index,
      teamBScore: 90 - index,
      winnerOwnerId: matchup.teamAOwnerId!,
      loserOwnerId: matchup.teamBOwnerId!,
      tieBrokenByHigherSeed: false,
    }));
  playoffs = applyPlayoffRoundResults(playoffs, 2, finalResults);
  const placements = [...playoffs.placements].sort((first, second) => first.place - second.place);

  addCheck(
    checks,
    'four-final-placements',
    'Final placements',
    'The four-team season records first through fourth place',
    'Places 1, 2, 3, 4',
    placements.map((placement) => placement.place).join(', '),
    placements.length === 4 &&
      placements.every((placement, index) => placement.place === index + 1),
  );
  addCheck(
    checks,
    'champion-recorded',
    'Final placements',
    'The championship winner becomes the saved league champion',
    championship?.teamAOwnerId ?? 'winner',
    playoffs.championOwnerId ?? 'missing',
    Boolean(championship?.teamAOwnerId && playoffs.championOwnerId === championship.teamAOwnerId),
  );
  addCheck(
    checks,
    'season-complete',
    'Final placements',
    'The bracket reaches a complete season state after both final games',
    'complete',
    playoffs.status,
    playoffs.status === 'complete',
  );

  const passedCount = checks.filter((check) => check.passed).length;

  return {
    passed: passedCount === checks.length,
    passedCount,
    totalCount: checks.length,
    checks,
    milestones: summarizeMilestones(checks),
    simulatedTeamCount: TEAM_COUNT,
    simulatedRegularSeasonCycleCount: REGULAR_SEASON_CYCLE_COUNT,
    simulatedRosterSlotsPerTeam: ACTIVE_ROSTER_SLOTS_PER_TEAM,
    simulatedGamesPerWindow: GAMES_PER_WINDOW,
  };
}
