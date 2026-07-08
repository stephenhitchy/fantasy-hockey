import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import {
  calculateCycleScoring,
  CycleAssetScoreSummary,
  CycleScoringResult
} from '../../../core/cycle/cycle-scoring.service';

import {
  defaultScoringRules
} from '../../../core/scoring/scoring-rules';

import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  FantasyCycle,
  FantasyMatchup
} from '../../../core/cycle/cycle.models';

import {
  completeCycle,
  listenToCycle,
  listenToCycleMatchups,
  startNextCycle,
  updateCycleMatchupScores
} from '../../../core/cycle/cycle.service';

import {
  loadDraftPlayerPool
} from '../../../core/draft/draft-player-pool.service';

import {
  DraftableAsset,
  DraftPick,
  DraftPosition
} from '../../../core/draft/draft.models';

import {
  listenToDraftPicks
} from '../../../core/draft/draft.service';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  getNhlTeamSeasonSchedule,
  NHL_DRAFT_CLUBS
} from '../../../core/nhl/nhl-api.service';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

const CYCLE_PROJECTION_WINDOW_DAYS = 14;
const NHL_SCHEDULE_BATCH_SIZE = 4;

const TEST_CYCLE_START_DATE: Date | null =
  new Date('2026-01-10T12:00:00');

type MatchupViewMode = 'teamA' | 'both' | 'teamB';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-cycle-one',
  imports: [RouterLink],
  templateUrl: './cycle-one.html',
  styleUrl: './cycle-one.css'
})
export class CycleOne implements OnDestroy {
  leagueId = '';
  userId = '';
  cycleNumber = 1;

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  cycle = signal<FantasyCycle | null>(null);
  matchups = signal<FantasyMatchup[]>([]);
  picks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);

  teamGameCounts = signal<Record<string, number>>({});

  cycleScoring = signal<CycleScoringResult | null>(null);
  matchupView = signal<MatchupViewMode>('both');

  scoringLoading = signal(false);
  scoringError = signal('');

  loading = signal(true);
  errorMessage = signal('');
  scheduleProjectionLoading = signal(false);
  scheduleProjectionError = signal('');
  syncingScores = signal(false);
  syncScoreMessage = signal('');
  syncScoreError = signal('');

  completingCycle = signal(false);
  completeCycleMessage = signal('');
  completeCycleError = signal('');
  startingNextCycle = signal(false);
  startNextCycleMessage = signal('');
  startNextCycleError = signal('');

  autoFlowMessage = signal('');
  autoFlowError = signal('');

  setMatchupView(viewMode: MatchupViewMode): void {
  this.matchupView.set(viewMode);
}

  shouldShowTeamA(): boolean {
  return (
    this.matchupView() === 'teamA' ||
    this.matchupView() === 'both'
  );
}

  shouldShowTeamB(): boolean {
  return (
    this.matchupView() === 'teamB' ||
    this.matchupView() === 'both'
  );
}

  shouldShowMatchupDivider(): boolean {
  return this.matchupView() === 'both';
}

  getTeamsComparisonClass(): string {
  return this.matchupView() === 'both'
    ? 'teams-comparison'
    : 'teams-comparison single-team-view';
}

  async completeCurrentCycleFromCurrentScores(): Promise<void> {
  this.completeCycleMessage.set('');
  this.completeCycleError.set('');

  const cycle = this.cycle();
  const scoring = this.cycleScoring();
  const matchups = this.matchups();

  if (!cycle) {
    this.completeCycleError.set(
      `${this.getCycleLabel()} has not been started yet.`
    );
    return;
  }

  if (cycle.status === 'complete') {
    this.completeCycleError.set(
      `${this.getCycleLabel()} has already been completed.`
    );
    return;
  }

  if (!scoring) {
    this.completeCycleError.set(
      'Current scores are not ready yet. Wait for scoring to finish loading.'
    );
    return;
  }

  if (matchups.length === 0) {
    this.completeCycleError.set(
      'No matchups were found to complete.'
    );
    return;
  }

  if (!this.areAllMatchupsReadyToComplete()) {
    this.completeCycleError.set(
      `${this.getCycleLabel()} is not ready to complete yet. Some roster games are still unfinished.`
    );
    return;
  }

  this.completingCycle.set(true);

  try {
    await completeCycle(
      this.leagueId,
      this.cycleNumber,
      matchups,
      scoring.teamScores
    );

    this.completeCycleMessage.set(
      `${this.getCycleLabel()} was completed and team records were updated.`
    );

    this.teams.set(
      await getLeagueTeams(this.leagueId)
    );
  } catch (error: unknown) {
    this.completeCycleError.set(
      error instanceof Error
        ? error.message
        : `Unable to complete ${this.getCycleLabel()}.`
    );
  } finally {
    this.completingCycle.set(false);
  }
}


  async startNextCycleFromCurrentCycle(): Promise<void> {
  this.startNextCycleMessage.set('');
  this.startNextCycleError.set('');

  const cycle = this.cycle();

  if (!cycle) {
    this.startNextCycleError.set(
      `${this.getCycleLabel()} has not been started yet.`
    );
    return;
  }

  if (cycle.status !== 'complete') {
    this.startNextCycleError.set(
      `${this.getCycleLabel()} must be complete before starting ${this.getNextCycleLabel()}.`
    );
    return;
  }

  if (this.teams().length < 2) {
    this.startNextCycleError.set(
      'At least two teams are required to start the next cycle.'
    );
    return;
  }

  this.startingNextCycle.set(true);

  try {
    await startNextCycle(
      this.leagueId,
      this.teams(),
      this.cycleNumber
    );

    this.startNextCycleMessage.set(
      `${this.getNextCycleLabel()} was started.`
    );

    await this.router.navigate([
      '/leagues',
      this.leagueId,
      'cycles',
      this.cycleNumber + 1
    ]);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : `Unable to start ${this.getNextCycleLabel()}.`;

    if (
      errorMessage.includes(
        `${this.getNextCycleLabel()} has already been started`
      )
    ) {
      this.startNextCycleMessage.set(
        `${this.getNextCycleLabel()} already exists. Opening it now.`
      );

      await this.router.navigate([
        '/leagues',
        this.leagueId,
        'cycles',
        this.cycleNumber + 1
      ]);

      return;
    }

    this.startNextCycleError.set(errorMessage);
  } finally {
    this.startingNextCycle.set(false);
  }
}

  isMatchupComplete(matchup: FantasyMatchup): boolean {
  return (
    matchup.status === 'complete' ||
    this.cycle()?.status === 'complete'
  );
}

  getTeamRosterGamesLeft(ownerId: string | null): number {
  if (!ownerId) {
    return 0;
  }

  return this.getTeamPicks(ownerId).reduce(
    (total, pick) => total + this.getAssetGamesLeft(pick.asset),
    0
  );
}

  getTeamRosterGamesPlayed(ownerId: string | null): number {
  if (!ownerId) {
    return 0;
  }

  return this.getTeamPicks(ownerId).reduce(
    (total, pick) => total + this.getAssetGamesPlayed(pick.asset),
    0
  );
}

  isTeamReadyToComplete(ownerId: string | null): boolean {
  if (!ownerId) {
    return true;
  }

  const scoring = this.cycleScoring();

  if (typeof scoring?.teamCycleComplete?.[ownerId] === 'boolean') {
    return scoring.teamCycleComplete[ownerId];
  }

  const picks = this.getTeamPicks(ownerId);

  return (
    picks.length > 0 &&
    picks.every((pick) => this.getAssetGamesLeft(pick.asset) === 0)
  );
}

  getMatchupRosterGamesLeft(matchup: FantasyMatchup): number {
  return (
    this.getTeamRosterGamesLeft(matchup.teamAOwnerId) +
    this.getTeamRosterGamesLeft(matchup.teamBOwnerId)
  );
}

  isMatchupReadyToComplete(matchup: FantasyMatchup): boolean {
  if (this.isMatchupComplete(matchup)) {
    return true;
  }

  if (!this.cycleScoring()) {
    return false;
  }

  return (
    this.isTeamReadyToComplete(matchup.teamAOwnerId) &&
    this.isTeamReadyToComplete(matchup.teamBOwnerId)
  );
}

  areAllMatchupsReadyToComplete(): boolean {
  const matchups = this.matchups();

  return (
    Boolean(this.cycleScoring()) &&
    matchups.length > 0 &&
    matchups.every((matchup) => this.isMatchupReadyToComplete(matchup))
  );
}

  getMatchupReadinessLabel(matchup: FantasyMatchup): string {
  if (this.isMatchupComplete(matchup)) {
    return 'Complete';
  }

  if (this.scoringLoading()) {
    return 'Checking Games';
  }

  if (!this.cycleScoring()) {
    return 'Waiting for Scores';
  }

  if (this.isMatchupReadyToComplete(matchup)) {
    return 'Ready to Complete';
  }

  const gamesLeft = this.getMatchupRosterGamesLeft(matchup);
  const gameLabel = gamesLeft === 1 ? 'roster game' : 'roster games';

  return `Waiting on ${gamesLeft} ${gameLabel}`;
}

  getCycleCompletionReadinessText(): string {
  const cycle = this.cycle();

  if (!cycle) {
    return `${this.getCycleLabel()} readiness will appear once the cycle starts.`;
  }

  if (cycle.status === 'complete') {
    return `${this.getCycleLabel()} is complete.`;
  }

  if (this.scoringLoading()) {
    return 'Checking whether all matchup roster games are complete...';
  }

  if (!this.cycleScoring()) {
    return 'Completion readiness will appear once current scoring loads.';
  }

  if (this.areAllMatchupsReadyToComplete()) {
    return `${this.getCycleLabel()} is ready and will complete automatically.`;
  }

  const gamesLeft = this.matchups().reduce(
    (total, matchup) => total + this.getMatchupRosterGamesLeft(matchup),
    0
  );

  const gameLabel = gamesLeft === 1 ? 'roster game' : 'roster games';

  return `${this.getCycleLabel()} is waiting on ${gamesLeft} counted ${gameLabel}.`;
}

  isWinningTeam(
  matchup: FantasyMatchup,
  ownerId: string | null
): boolean {
  if (!ownerId || !this.isMatchupComplete(matchup)) {
    return false;
  }

  return matchup.winnerOwnerId === ownerId;
}

  isLosingTeam(
  matchup: FantasyMatchup,
  ownerId: string | null
): boolean {
  if (
    !ownerId ||
    !this.isMatchupComplete(matchup) ||
    !matchup.teamBOwnerId ||
    !matchup.winnerOwnerId
  ) {
    return false;
  }

  return matchup.winnerOwnerId !== ownerId;
}

  getTeamResultLabel(
  matchup: FantasyMatchup,
  ownerId: string | null
): string {
  if (!ownerId || !this.isMatchupComplete(matchup)) {
    return '';
  }

  if (!matchup.teamBOwnerId && ownerId === matchup.teamAOwnerId) {
    return 'Bye Win';
  }

  if (!matchup.winnerOwnerId) {
    return 'Tie';
  }

  return matchup.winnerOwnerId === ownerId
    ? 'Winner'
    : 'Lost';
}

  async syncCurrentScoresToFirestore(): Promise<void> {
  this.syncScoreMessage.set('');
  this.syncScoreError.set('');

  const scoring = this.cycleScoring();
  const matchups = this.matchups();

  if (!scoring) {
    this.syncScoreError.set(
      'Current scores are not ready yet. Wait for scoring to finish loading.'
    );
    return;
  }

  if (matchups.length === 0) {
    this.syncScoreError.set(
      'No matchups were found to update.'
    );
    return;
  }

  this.syncingScores.set(true);

  try {
    await updateCycleMatchupScores(
      this.leagueId,
      this.cycleNumber,
      matchups,
      scoring.teamScores
    );

    this.syncScoreMessage.set(
      'Current scores were synced to Firestore.'
    );
  } catch (error: unknown) {
    this.syncScoreError.set(
      error instanceof Error
        ? error.message
        : 'Unable to sync current scores.'
    );
  } finally {
    this.syncingScores.set(false);
  }
}

  readonly forwardPositions: DraftPosition[] = [
    'LW',
    'C',
    'RW'
  ];

  readonly defensePositions: DraftPosition[] = [
    'D'
  ];

  readonly goaliePositions: DraftPosition[] = [
    'G'
  ];

  private routeSubscription: Subscription | null = null;
  private pageLoadRequestId = 0;
  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private scheduleLoadStartedForCycleId: string | null = null;
  private scoringLoadKey: string | null = null;
  private scoringRequestId = 0;
  private autoCompleteAttemptKey: string | null = null;

  private async loadCurrentCycleScoringIfReady(): Promise<void> {
  const cycle = this.cycle();
  const league = this.league();
  const picks = this.picks();


  if (!cycle || !league || picks.length === 0) {
    return;
  }

  const startDate =
    this.getProjectionWindowStartDate() ?? new Date();

  const endDate =
    this.getProjectionWindowEndDateFromStart(startDate);

  const season =
    this.getNhlSeasonForDate(startDate);

  const scoringRules =
    league.scoringRules ?? defaultScoringRules;

  const requiredGamesPerCycle =
    scoringRules.requiredGamesPerCycle ??
    defaultScoringRules.requiredGamesPerCycle;

  const scoringKey = [
    cycle.id,
    this.cycleNumber,
    season,
    requiredGamesPerCycle,
    picks.map((pick) => pick.asset.assetKey).join('|')
  ].join('::');

  if (this.scoringLoadKey === scoringKey) {
    return;
  }

  this.scoringLoadKey = scoringKey;
  this.scoringLoading.set(true);
  this.scoringError.set('');

  const requestId = ++this.scoringRequestId;

  try {
    const result =
      await calculateCycleScoring({
        picks,
        cycleNumber: this.cycleNumber,
        season,
        requiredGamesPerCycle,
        scoringRules
      });

    if (requestId !== this.scoringRequestId) {
      return;
    }

    this.cycleScoring.set(result);

    this.teamGameCounts.set({
      ...this.teamGameCounts(),
      ...result.teamGameCounts
    });

    void this.evaluateAutoCompleteCycleIfReady();
  } catch (error: unknown) {
    this.scoringLoadKey = null;

    this.scoringError.set(
      error instanceof Error
        ? error.message
        : 'Unable to load current fantasy scoring.'
    );
  } finally {
    if (requestId === this.scoringRequestId) {
      this.scoringLoading.set(false);
      void this.evaluateAutoCompleteCycleIfReady();
    }
  }
}


  private async evaluateAutoCompleteCycleIfReady(): Promise<void> {
    const cycle = this.cycle();
    const scoring = this.cycleScoring();
    const matchups = this.matchups();

    if (!cycle || cycle.status !== 'active') {
      return;
    }

    if (!scoring || matchups.length === 0) {
      return;
    }

    if (this.scoringLoading() || this.completingCycle()) {
      return;
    }

    if (!this.areAllMatchupsReadyToComplete()) {
      return;
    }

    const attemptKey = this.getAutoCompleteAttemptKey(cycle, scoring, matchups);

    if (this.autoCompleteAttemptKey === attemptKey) {
      return;
    }

    this.autoCompleteAttemptKey = attemptKey;
    this.autoFlowMessage.set(`${this.getCycleLabel()} is ready. Completing automatically...`);
    this.autoFlowError.set('');
    this.completeCycleMessage.set('');
    this.completeCycleError.set('');
    this.completingCycle.set(true);

    try {
      await completeCycle(
        this.leagueId,
        this.cycleNumber,
        matchups,
        scoring.teamScores
      );

      this.autoFlowMessage.set(
        `${this.getCycleLabel()} was completed automatically and team records were updated.`
      );

      this.teams.set(
        await getLeagueTeams(this.leagueId)
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : `Unable to auto-complete ${this.getCycleLabel()}.`;

      if (message.includes('has already been completed')) {
        this.autoFlowMessage.set(`${this.getCycleLabel()} is already complete.`);
        return;
      }

      this.autoCompleteAttemptKey = null;
      this.autoFlowError.set(message);
    } finally {
      this.completingCycle.set(false);
    }
  }

  private getAutoCompleteAttemptKey(
    cycle: FantasyCycle,
    scoring: CycleScoringResult,
    matchups: FantasyMatchup[]
  ): string {
    const teamScoreKey = Object.entries(scoring.teamScores)
      .sort(([firstOwnerId], [secondOwnerId]) =>
        firstOwnerId.localeCompare(secondOwnerId)
      )
      .map(([ownerId, score]) => `${ownerId}:${score}`)
      .join('|');

    const matchupKey = matchups
      .map((matchup) => `${matchup.id}:${matchup.status}`)
      .join('|');

    return [
      this.leagueId,
      cycle.id,
      this.cycleNumber,
      teamScoreKey,
      matchupKey
    ].join('::');
  }

  readonly myMatchup = computed(() =>
    this.matchups().find(
      (matchup) =>
        matchup.teamAOwnerId === this.userId ||
        matchup.teamBOwnerId === this.userId
    ) ?? null
  );

  readonly scheduleHasGamesInWindow = computed(() =>
    Object.values(this.teamGameCounts()).some(
      (gameCount) => gameCount > 0
    )
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.routeSubscription = this.route.paramMap.subscribe((params) => {
      void this.loadCyclePageFromParams(params);
    });
  }

  ngOnDestroy(): void {
    this.routeSubscription?.unsubscribe();
    this.stopLiveListeners();
  }

  private stopLiveListeners(): void {
    this.stopCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopPicksListener?.();

    this.stopCycleListener = null;
    this.stopMatchupsListener = null;
    this.stopPicksListener = null;
  }

  private resetPageStateForNewRoute(): void {
    this.stopLiveListeners();

    this.league.set(null);
    this.teams.set([]);
    this.cycle.set(null);
    this.matchups.set([]);
    this.picks.set([]);
    this.playerPool.set([]);
    this.teamGameCounts.set({});
    this.cycleScoring.set(null);
    this.matchupView.set('both');

    this.scoringLoading.set(false);
    this.scoringError.set('');
    this.loading.set(true);
    this.errorMessage.set('');
    this.scheduleProjectionLoading.set(false);
    this.scheduleProjectionError.set('');
    this.syncingScores.set(false);
    this.syncScoreMessage.set('');
    this.syncScoreError.set('');
    this.completingCycle.set(false);
    this.completeCycleMessage.set('');
    this.completeCycleError.set('');
    this.startingNextCycle.set(false);
    this.startNextCycleMessage.set('');
    this.startNextCycleError.set('');
    this.autoFlowMessage.set('');
    this.autoFlowError.set('');

    this.scheduleLoadStartedForCycleId = null;
    this.scoringLoadKey = null;
    this.autoCompleteAttemptKey = null;
    this.scoringRequestId += 1;
  }

  async loadCyclePageFromParams(params: ParamMap): Promise<void> {
    const leagueId = params.get('leagueId');
    const cycleNumberRaw = params.get('cycleNumber') ?? '1';
    const parsedCycleNumber = Number(cycleNumberRaw);
    const cycleNumber = Number.isInteger(parsedCycleNumber) && parsedCycleNumber > 0
      ? parsedCycleNumber
      : 1;

    const requestId = ++this.pageLoadRequestId;
    this.resetPageStateForNewRoute();

    const user = await waitForAuthUser();

    if (requestId !== this.pageLoadRequestId) {
      return;
    }

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.cycleNumber = cycleNumber;
    this.userId = user.uid;

    try {
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId)
      ]);

      if (requestId !== this.pageLoadRequestId) {
        return;
      }

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);

      this.stopCycleListener = listenToCycle(
        leagueId,
        cycleNumber,
        (cycle) => {
          this.cycle.set(cycle);
          void this.loadScheduleAdjustedProjectionData(cycle);
          void this.loadCurrentCycleScoringIfReady();
          void this.evaluateAutoCompleteCycleIfReady();
        }
      );

      this.stopMatchupsListener = listenToCycleMatchups(
        leagueId,
        cycleNumber,
        (matchups) => {
          this.matchups.set(matchups);
          void this.evaluateAutoCompleteCycleIfReady();
        }
      );

      this.stopPicksListener = listenToDraftPicks(
        leagueId,
        (picks) => {
          this.picks.set(picks);
          void this.loadCurrentCycleScoringIfReady();
        }
      );

      void this.loadPlayerPoolForProjectionFallback();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : `Unable to load ${this.getCycleLabel()}.`
      );
    } finally {
      if (requestId === this.pageLoadRequestId) {
        this.loading.set(false);
      }
    }
  }

  getCycleLabel(): string {
    return `Cycle ${this.cycleNumber}`;
  }

  getNextCycleLabel(): string {
    return `Cycle ${this.cycleNumber + 1}`;
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
  }

  getTeamRecord(ownerId: string | null): string {
    if (!ownerId) {
      return '';
    }

    const team = this.teams().find(
      (candidate) => candidate.ownerId === ownerId
    );

    if (!team) {
      return '';
    }

    return `${team.wins}-${team.losses}-${team.ties}`;
  }

  getTeamPicks(ownerId: string | null): DraftPick[] {
    if (!ownerId) {
      return [];
    }

    return this.picks()
      .filter((pick) => pick.ownerId === ownerId)
      .sort((first, second) => {
        const positionComparison =
          this.getPositionSortValue(first.asset.position) -
          this.getPositionSortValue(second.asset.position);

        if (positionComparison !== 0) {
          return positionComparison;
        }

        return this.getAssetName(first.asset).localeCompare(
          this.getAssetName(second.asset)
        );
      });
  }

  getTeamPicksByPosition(
    ownerId: string | null,
    position: DraftPosition
  ): DraftPick[] {
    return this.getTeamPicks(ownerId).filter(
      (pick) => pick.asset.position === position
    );
  }

  getProjectedCycleForTeam(ownerId: string | null): number | null {
    const picks = this.getTeamPicks(ownerId);

    if (picks.length === 0) {
      return null;
    }

    const projectionTotal = picks.reduce(
      (total, pick) =>
        total + (this.getBestCycleProjection(pick.asset) ?? 0),
      0
    );

    return Number(projectionTotal.toFixed(1));
  }

  getProjectedSeasonForTeam(ownerId: string | null): number | null {
    const picks = this.getTeamPicks(ownerId);

    if (picks.length === 0) {
      return null;
    }

    const projectionTotal = picks.reduce(
      (total, pick) =>
        total + (this.getAssetProjectedSeason(pick.asset) ?? 0),
      0
    );

    return Number(projectionTotal.toFixed(1));
  }

  getProjectedWinnerLabel(matchup: FantasyMatchup): string {
    if (
  matchup.status === 'complete' ||
  this.cycle()?.status === 'complete'
) {
  if (!matchup.teamBOwnerId) {
    return `Final: ${this.getTeamName(matchup.teamAOwnerId)} had a bye.`;
  }

  if (matchup.teamAScore === matchup.teamBScore) {
    return `Final: Tie, ${matchup.teamAScore.toFixed(1)} to ${matchup.teamBScore.toFixed(1)}.`;
  }

  const winnerOwnerId =
    matchup.winnerOwnerId ??
    (
      matchup.teamAScore > matchup.teamBScore
        ? matchup.teamAOwnerId
        : matchup.teamBOwnerId
    );

  const difference =
    Math.abs(matchup.teamAScore - matchup.teamBScore);

  return `Final: ${this.getTeamName(winnerOwnerId)} won by ${difference.toFixed(1)}.`;
}

    if (!matchup.teamBOwnerId) {
      return `${this.getTeamName(matchup.teamAOwnerId)} has a bye.`;
    }

    const teamAProjection =
      this.getProjectedCycleForTeam(matchup.teamAOwnerId);

    const teamBProjection =
      this.getProjectedCycleForTeam(matchup.teamBOwnerId);

    if (
      typeof teamAProjection !== 'number' ||
      typeof teamBProjection !== 'number'
    ) {
      return 'Projection unavailable';
    }

    if (teamAProjection === teamBProjection) {
      return 'Projected tie';
    }

    const winnerOwnerId =
      teamAProjection > teamBProjection
        ? matchup.teamAOwnerId
        : matchup.teamBOwnerId;

    const difference =
      Math.abs(teamAProjection - teamBProjection);

    return `${this.getTeamName(winnerOwnerId)} by ${difference.toFixed(1)}`;
  }

  isMyMatchup(matchup: FantasyMatchup): boolean {
    return (
      matchup.teamAOwnerId === this.userId ||
      matchup.teamBOwnerId === this.userId
    );
  }

  getProjectionDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater'
      ? asset.player.fullName
      : `${asset.teamName} Goalie Unit`;
  }

  getAssetTeamLabel(asset: DraftableAsset): string {
    return asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation;
  }

  getAssetLogoUrl(asset: DraftableAsset): string | undefined {
    return asset.assetType === 'skater'
      ? asset.player.teamLogoUrl
      : asset.teamLogoUrl;
  }

  getPositionLabel(position: DraftPosition): string {
    switch (position) {
      case 'LW':
        return 'Left Wing';

      case 'C':
        return 'Center';

      case 'RW':
        return 'Right Wing';

      case 'D':
        return 'Defense';

      case 'G':
        return 'Goalie Unit';

      default:
        return position;
    }
  }

  getAssetProjectedSeason(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) =>
        availableAsset.assetKey === asset.assetKey
    );

    return (
      asset.projectedSeasonPoints ??
      poolAsset?.projectedSeasonPoints ??
      null
    );
  }

  getAssetProjectedCycle(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) =>
        availableAsset.assetKey === asset.assetKey
    );

    return (
      asset.projectedCyclePoints ??
      poolAsset?.projectedCyclePoints ??
      null
    );
  }

  getAssetScheduleAdjustedCycle(asset: DraftableAsset): number | null {
    if (!this.scheduleHasGamesInWindow()) {
      return null;
    }

    const projectedSeason =
      this.getAssetProjectedSeason(asset);

    const scheduledGames =
      this.getAssetScheduledGames(asset);

    if (
      typeof projectedSeason !== 'number' ||
      scheduledGames <= 0
    ) {
      return null;
    }

    return Number(
      ((projectedSeason / 82) * scheduledGames).toFixed(1)
    );
  }

  getBestCycleProjection(asset: DraftableAsset): number | null {
    return (
      this.getAssetScheduleAdjustedCycle(asset) ??
      this.getAssetProjectedCycle(asset)
    );
  }

 getAssetScoreSummary(
  asset: DraftableAsset
): CycleAssetScoreSummary | null {
  return (
    this.cycleScoring()?.assetScores[asset.assetKey] ??
    null
  );
}

  getAssetCurrentCycleScore(asset: DraftableAsset): number {
  return this.getAssetScoreSummary(asset)?.currentScore ?? 0;
}

  getAssetGamesPlayed(asset: DraftableAsset): number {
  return this.getAssetScoreSummary(asset)?.gamesPlayed ?? 0;
}

  getAssetGamesLeft(asset: DraftableAsset): number {
  const summary = this.getAssetScoreSummary(asset);

  if (summary) {
    return summary.gamesLeft;
  }

  return Math.max(
    0,
    this.getAssetScheduledGames(asset)
  );
}

  getTeamCurrentCycleScore(ownerId: string | null): number {
  if (!ownerId) {
    return 0;
  }

  const scoringTotal =
    this.cycleScoring()?.teamScores[ownerId];

  if (typeof scoringTotal === 'number') {
    return scoringTotal;
  }

  return Number(
    this.getTeamPicks(ownerId)
      .reduce(
        (total, pick) =>
          total + this.getAssetCurrentCycleScore(pick.asset),
        0
      )
      .toFixed(1)
  );
}


  getMatchupTeamCurrentScore(
  matchup: FantasyMatchup,
  ownerId: string | null
): number {
  if (!ownerId) {
    return 0;
  }

  if (this.isMatchupComplete(matchup)) {
    if (ownerId === matchup.teamAOwnerId) {
      return matchup.teamAScore;
    }

    if (ownerId === matchup.teamBOwnerId) {
      return matchup.teamBScore;
    }
  }

  return this.getTeamCurrentCycleScore(ownerId);
}

  getCurrentScoringStatusText(): string {
  if (!this.cycle()) {
    return `Current scoring will appear once ${this.getCycleLabel()} starts.`;
  }

  if (this.scoringLoading()) {
    return 'Loading current fantasy scoring from final NHL games...';
  }

  if (this.scoringError()) {
    return this.scoringError();
  }

  if (!this.cycleScoring()) {
    return 'Current scoring is waiting for drafted player data.';
  }

  const scoringRules = this.league()?.scoringRules ?? defaultScoringRules;
  const requiredGamesPerCycle =
    scoringRules.requiredGamesPerCycle ??
    defaultScoringRules.requiredGamesPerCycle;
  const firstGameNumber =
    (this.cycleNumber - 1) * requiredGamesPerCycle + 1;
  const lastGameNumber = this.cycleNumber * requiredGamesPerCycle;

  return `Current scores use each asset's NHL team games ${firstGameNumber}-${lastGameNumber}. Missed games count as 0-point counted games.`;
}

  getAssetScheduledGames(asset: DraftableAsset): number {
    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

    if (!this.scheduleHasGamesInWindow()) {
      return requiredGames;
    }

    const teamAbbreviation =
      this.getAssetNhlTeamAbbreviation(asset);

    const gameCount = this.teamGameCounts()[teamAbbreviation];

    if (typeof gameCount !== 'number') {
      return requiredGames;
    }

    return Math.min(gameCount, requiredGames);
  }

  getPositionCurrentTotal(
    ownerId: string | null,
    position: DraftPosition
  ): number {
    return this.getTeamPicksByPosition(ownerId, position).reduce(
      (total, pick) =>
        total + this.getAssetCurrentCycleScore(pick.asset),
      0
    );
  }

  getPositionProjectedTotal(
    ownerId: string | null,
    position: DraftPosition
  ): number | null {
    const picks = this.getTeamPicksByPosition(ownerId, position);

    if (picks.length === 0) {
      return null;
    }

    const projectionTotal = picks.reduce(
      (total, pick) =>
        total + (this.getBestCycleProjection(pick.asset) ?? 0),
      0
    );

    return Number(projectionTotal.toFixed(1));
  }

  getPositionGamesPlayed(
    ownerId: string | null,
    position: DraftPosition
  ): number {
    return this.getTeamPicksByPosition(ownerId, position).reduce(
      (total, pick) =>
        total + this.getAssetGamesPlayed(pick.asset),
      0
    );
  }

  getPositionGamesLeft(
    ownerId: string | null,
    position: DraftPosition
  ): number {
    return this.getTeamPicksByPosition(ownerId, position).reduce(
      (total, pick) =>
        total + this.getAssetGamesLeft(pick.asset),
      0
    );
  }

  getProjectionWindowLabel(): string {
    const startDate = this.getProjectionWindowStartDate();
    const endDate = this.getProjectionWindowEndDate();

    if (!startDate || !endDate) {
      return `Projection window will appear once ${this.getCycleLabel()} has a start time.`;
    }

    return `${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`;
  }

  getScheduleProjectionStatusText(): string {
    if (this.scheduleProjectionLoading()) {
      return 'Loading NHL schedules...';
    }

    if (this.scheduleProjectionError()) {
      return this.scheduleProjectionError();
    }

    if (!this.scheduleHasGamesInWindow()) {
      const requiredGames =
        this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

      return `No NHL games found in this window. Using ${requiredGames} projected games per player until games are available.`;
    }

    return 'Projected scores use each NHL team’s games in the cycle window.';
  }

  private async loadPlayerPoolForProjectionFallback(): Promise<void> {
    try {
      this.playerPool.set(
        await loadDraftPlayerPool()
      );
    } catch (error: unknown) {
      console.warn(
        'Unable to load player pool projection fallback.',
        error
      );
    }
  }

  private async loadScheduleAdjustedProjectionData(
    cycle: FantasyCycle | null
  ): Promise<void> {
    if (!cycle) {
      return;
    }

    if (this.scheduleLoadStartedForCycleId === cycle.id) {
      return;
    }

    this.scheduleLoadStartedForCycleId = cycle.id;
    this.scheduleProjectionLoading.set(true);
    this.scheduleProjectionError.set('');

    const startDate =
      this.getProjectionWindowStartDate() ?? new Date();

    const endDate =
      this.getProjectionWindowEndDateFromStart(startDate);

    const season =
      this.getNhlSeasonForDate(startDate);

    const gameCounts: Record<string, number> = {};

    try {
      for (
        let index = 0;
        index < NHL_DRAFT_CLUBS.length;
        index += NHL_SCHEDULE_BATCH_SIZE
      ) {
        const batch = NHL_DRAFT_CLUBS.slice(
          index,
          index + NHL_SCHEDULE_BATCH_SIZE
        );

        const results = await Promise.allSettled(
          batch.map(async (club) => {
            const schedule =
              await getNhlTeamSeasonSchedule(
                club.abbreviation,
                season
              );

            const gameCount = schedule.filter((game) =>
              this.isGameInProjectionWindow(
                game.gameDate,
                startDate,
                endDate
              )
            ).length;

            return {
              teamAbbreviation: club.abbreviation,
              gameCount
            };
          })
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            gameCounts[result.value.teamAbbreviation] =
              result.value.gameCount;
          } else {
            console.warn(
              'Unable to load one NHL team schedule.',
              result.reason
            );
          }
        }

        await this.wait(125);
      }

      this.teamGameCounts.set(gameCounts);
    } catch (error: unknown) {
      this.scheduleProjectionError.set(
        error instanceof Error
          ? error.message
          : 'Unable to load NHL schedule projections.'
      );
    } finally {
      this.scheduleProjectionLoading.set(false);
    }
  }

  private getAssetNhlTeamAbbreviation(
    asset: DraftableAsset
  ): string {
    return asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation;
  }

  private getProjectionWindowStartDate(): Date | null {
  if (TEST_CYCLE_START_DATE) {
    return TEST_CYCLE_START_DATE;
  }

  const cycle = this.cycle();

  return this.getDateFromUnknown(cycle?.startedAt);
}

  private getProjectionWindowEndDate(): Date | null {
    const startDate = this.getProjectionWindowStartDate();

    if (!startDate) {
      return null;
    }

    return this.getProjectionWindowEndDateFromStart(startDate);
  }

  private getProjectionWindowEndDateFromStart(
    startDate: Date
  ): Date {
    const endDate = new Date(startDate);

    endDate.setDate(
      endDate.getDate() + CYCLE_PROJECTION_WINDOW_DAYS
    );

    return endDate;
  }

  private getDateFromUnknown(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      'toDate' in value
    ) {
      const timestampLike = value as {
        toDate?: () => Date;
      };

      if (typeof timestampLike.toDate === 'function') {
        return timestampLike.toDate();
      }
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsedDate = new Date(value);

      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return null;
  }

  private getNhlSeasonForDate(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    const seasonStartYear =
      month >= 7
        ? year
        : year - 1;

    return `${seasonStartYear}${seasonStartYear + 1}`;
  }

  private isGameInProjectionWindow(
    gameDate: string,
    startDate: Date,
    endDate: Date
  ): boolean {
    const startKey = this.getDateKey(startDate);
    const endKey = this.getDateKey(endDate);

    return gameDate >= startKey && gameDate <= endKey;
  }

  private getDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  async openAssetDetail(asset: DraftableAsset): Promise<void> {
    await this.router.navigate([
      '/leagues',
      this.leagueId,
      'cycles',
      this.cycleNumber,
      'assets',
      asset.assetKey
    ]);
  }

  private getPositionSortValue(position: DraftPosition): number {
    const order: DraftPosition[] = [
      'LW',
      'C',
      'RW',
      'D',
      'G'
    ];

    return order.indexOf(position);
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}