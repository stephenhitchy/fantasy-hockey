import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import {
  ActivatedRoute,
  Router,
  RouterLink
} from '@angular/router';

import {
  onAuthStateChanged,
  User
} from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  FantasyCycle,
  FantasyMatchup
} from '../../../core/cycle/cycle.models';

import {
  buildCycleSchedulePreview,
  CycleSchedulePreviewCycle,
  CycleSchedulePreviewMatchup,
  getRoundRobinCycleCount,
  listenToCycle,
  listenToCycleMatchups
} from '../../../core/cycle/cycle.service';

import {
  DraftableAsset,
  DraftPick
} from '../../../core/draft/draft.models';

import {
  loadDraftPlayerPool
} from '../../../core/draft/draft-player-pool.service';

import {
  getFantasyDraft,
  listenToDraftPicks
} from '../../../core/draft/draft.service';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  getStandardRegularSeasonCycleCount
} from '../../../core/playoffs/playoff-format';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-cycle-schedule-preview',
  imports: [RouterLink],
  templateUrl: './cycle-schedule-preview.html',
  styleUrl: './cycle-schedule-preview.css'
})
export class CycleSchedulePreview implements OnDestroy {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  picks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);
  schedulePreview = signal<CycleSchedulePreviewCycle[]>([]);
  existingCycles = signal<Record<number, FantasyCycle | null>>({});
  existingMatchups = signal<Record<number, FantasyMatchup[]>>({});
  selectedOwnerId = signal('');

  loading = signal(true);
  errorMessage = signal('');

  private stopListeners: Array<() => void> = [];

  readonly cyclesBeforeRepeat = computed(() =>
    getRoundRobinCycleCount(this.teams().length)
  );

  readonly matchupsPerCycle = computed(() =>
    this.schedulePreview()[0]?.matchups.length ?? 0
  );

  readonly hasByeWeeks = computed(() =>
    this.teams().length % 2 === 1
  );

  readonly regularSeasonCycleCount = computed(() =>
    getStandardRegularSeasonCycleCount(this.teams().length)
  );

  readonly selectedTeamName = computed(() =>
    this.getTeamName(this.selectedOwnerId())
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    void this.loadSchedulePreview();
  }

  ngOnDestroy(): void {
    this.stopAllListeners();
  }

  async loadSchedulePreview(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;

    try {
      const [league, teams, draft, playerPool] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
        getFantasyDraft(leagueId),
        loadDraftPlayerPool()
      ]);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);
      this.playerPool.set(playerPool);

      const defaultOwnerId = teams.some((team) => team.ownerId === user.uid)
        ? user.uid
        : teams[0]?.ownerId ?? '';

      this.selectedOwnerId.set(defaultOwnerId);

      const previewCycleCount =
        getStandardRegularSeasonCycleCount(teams.length);

      const schedulePreview = buildCycleSchedulePreview(
        teams,
        draft,
        previewCycleCount
      );

      this.schedulePreview.set(schedulePreview);
      this.listenToDraftAndExistingCycles(schedulePreview);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load the schedule preview.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  setSelectedOwnerIdFromEvent(event: Event): void {
    const target = event.target as HTMLSelectElement | null;
    this.selectedOwnerId.set(target?.value ?? '');
  }

  getSelectedTeamMatchup(
    cycle: CycleSchedulePreviewCycle
  ): CycleSchedulePreviewMatchup | null {
    const selectedOwnerId = this.selectedOwnerId();

    if (!selectedOwnerId) {
      return null;
    }

    return cycle.matchups.find(
      (matchup) =>
        matchup.teamAOwnerId === selectedOwnerId ||
        matchup.teamBOwnerId === selectedOwnerId
    ) ?? null;
  }

  getOpponentOwnerId(
    matchup: CycleSchedulePreviewMatchup
  ): string | null {
    const selectedOwnerId = this.selectedOwnerId();

    if (matchup.teamAOwnerId === selectedOwnerId) {
      return matchup.teamBOwnerId;
    }

    if (matchup.teamBOwnerId === selectedOwnerId) {
      return matchup.teamAOwnerId;
    }

    return null;
  }

  getSelectedTeamActualScore(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): number | null {
    return this.getTeamActualScore(
      cycleNumber,
      matchup,
      this.selectedOwnerId()
    );
  }

  getOpponentActualScore(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): number | null {
    return this.getTeamActualScore(
      cycleNumber,
      matchup,
      this.getOpponentOwnerId(matchup)
    );
  }

  getSelectedTeamResultLabel(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): string {
    return this.getPreviewResultLabel(
      cycleNumber,
      matchup,
      this.selectedOwnerId()
    );
  }

  getOpponentResultLabel(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): string {
    return this.getPreviewResultLabel(
      cycleNumber,
      matchup,
      this.getOpponentOwnerId(matchup)
    );
  }

  getSelectedScheduleSummaryText(): string {
    const selectedOwnerId = this.selectedOwnerId();

    if (!selectedOwnerId) {
      return 'Choose a team to preview its season schedule.';
    }

    return `Showing ${this.selectedTeamName()}'s schedule. Use the dropdown to view another team's schedule.`;
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

  getCycleLabel(cycleNumber: number): string {
    const cycle = this.existingCycles()[cycleNumber];

    if (cycle?.phase === 'playoffs') {
      return cycle.playoffRoundLabel ??
        `Playoff Cycle ${cycleNumber}`;
    }

    return `Cycle ${cycleNumber}`;
  }

  getCycleStatusLabel(cycleNumber: number): string {
    const cycle = this.existingCycles()[cycleNumber];

    if (!cycle) {
      return 'Not Started';
    }

    if (cycle.status === 'complete') {
      return 'Complete';
    }

    if (cycle.status === 'active') {
      return 'Active';
    }

    return cycle.status;
  }

  isCycleComplete(cycleNumber: number): boolean {
    return this.existingCycles()[cycleNumber]?.status === 'complete';
  }

  isCycleActive(cycleNumber: number): boolean {
    return this.existingCycles()[cycleNumber]?.status === 'active';
  }

  isByeMatchup(matchup: CycleSchedulePreviewMatchup): boolean {
    return !matchup.teamBOwnerId;
  }

  getMatchupLabel(matchup: CycleSchedulePreviewMatchup): string {
    if (!matchup.teamBOwnerId) {
      return `${this.getTeamName(matchup.teamAOwnerId)} has a bye`;
    }

    return `${this.getTeamName(matchup.teamAOwnerId)} vs ${this.getTeamName(matchup.teamBOwnerId)}`;
  }

  getScoreDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getTeamProjectedScore(ownerId: string | null): number | null {
    if (!ownerId) {
      return null;
    }

    const teamPicks = this.picks().filter(
      (pick) => pick.ownerId === ownerId
    );

    if (teamPicks.length === 0) {
      return null;
    }

    const total = teamPicks.reduce(
      (sum, pick) => sum + (this.getAssetProjectedCycle(pick.asset) ?? 0),
      0
    );

    return Number(total.toFixed(1));
  }

  getTeamActualScore(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): number | null {
    if (!ownerId) {
      return null;
    }

    const existingMatchup = this.getExistingMatchup(cycleNumber, matchup);

    if (!existingMatchup) {
      return null;
    }

    if (existingMatchup.teamAOwnerId === ownerId) {
      return existingMatchup.teamAScore;
    }

    if (existingMatchup.teamBOwnerId === ownerId) {
      return existingMatchup.teamBScore;
    }

    return null;
  }

  getPreviewResultLabel(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): string {
    if (!ownerId || !this.isCompletedPreviewMatchup(cycleNumber, matchup)) {
      return '';
    }

    if (!matchup.teamBOwnerId && ownerId === matchup.teamAOwnerId) {
      return 'Bye';
    }

    const winnerOwnerId = this.getPreviewWinnerOwnerId(
      cycleNumber,
      matchup
    );

    if (!winnerOwnerId) {
      return 'Tie';
    }

    return winnerOwnerId === ownerId
      ? 'Winner'
      : 'Lost';
  }

  isPreviewWinner(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): boolean {
    if (!ownerId || !this.isCompletedPreviewMatchup(cycleNumber, matchup)) {
      return false;
    }

    return this.getPreviewWinnerOwnerId(cycleNumber, matchup) === ownerId;
  }

  isPreviewLoser(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): boolean {
    if (
      !ownerId ||
      !matchup.teamBOwnerId ||
      !this.isCompletedPreviewMatchup(cycleNumber, matchup)
    ) {
      return false;
    }

    const winnerOwnerId = this.getPreviewWinnerOwnerId(
      cycleNumber,
      matchup
    );

    return Boolean(winnerOwnerId && winnerOwnerId !== ownerId);
  }

  private listenToDraftAndExistingCycles(
    schedulePreview: CycleSchedulePreviewCycle[]
  ): void {
    this.stopAllListeners();

    this.stopListeners.push(
      listenToDraftPicks(this.leagueId, (picks) => {
        this.picks.set(picks);
      })
    );

    for (const cycle of schedulePreview) {
      this.stopListeners.push(
        listenToCycle(this.leagueId, cycle.cycleNumber, (existingCycle) => {
          this.existingCycles.set({
            ...this.existingCycles(),
            [cycle.cycleNumber]: existingCycle
          });
        })
      );

      this.stopListeners.push(
        listenToCycleMatchups(
          this.leagueId,
          cycle.cycleNumber,
          (matchups) => {
            this.existingMatchups.set({
              ...this.existingMatchups(),
              [cycle.cycleNumber]: matchups
            });
          }
        )
      );
    }
  }

  private stopAllListeners(): void {
    for (const stopListener of this.stopListeners) {
      stopListener();
    }

    this.stopListeners = [];
  }

  private getAssetProjectedCycle(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey
    );

    const projectedCyclePoints =
      asset.projectedCyclePoints ??
      poolAsset?.projectedCyclePoints;

    if (typeof projectedCyclePoints === 'number') {
      return projectedCyclePoints;
    }

    const projectedSeasonPoints =
      asset.projectedSeasonPoints ??
      poolAsset?.projectedSeasonPoints;

    if (typeof projectedSeasonPoints !== 'number') {
      return null;
    }

    const requiredGamesPerCycle =
      this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

    return Number(
      ((projectedSeasonPoints / 82) * requiredGamesPerCycle).toFixed(1)
    );
  }

  private getExistingMatchup(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): FantasyMatchup | null {
    const existingMatchups = this.existingMatchups()[cycleNumber] ?? [];

    return existingMatchups.find(
      (existingMatchup) => existingMatchup.id === matchup.id
    ) ?? existingMatchups.find(
      (existingMatchup) =>
        existingMatchup.teamAOwnerId === matchup.teamAOwnerId &&
        existingMatchup.teamBOwnerId === matchup.teamBOwnerId
    ) ?? null;
  }

  private isCompletedPreviewMatchup(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): boolean {
    const existingMatchup = this.getExistingMatchup(cycleNumber, matchup);
    const existingCycle = this.existingCycles()[cycleNumber];

    return (
      existingMatchup?.status === 'complete' ||
      existingCycle?.status === 'complete'
    );
  }

  private getPreviewWinnerOwnerId(
    cycleNumber: number,
    matchup: CycleSchedulePreviewMatchup
  ): string | null {
    const existingMatchup = this.getExistingMatchup(cycleNumber, matchup);

    if (!existingMatchup) {
      return null;
    }

    if (existingMatchup.winnerOwnerId) {
      return existingMatchup.winnerOwnerId;
    }

    if (!existingMatchup.teamBOwnerId) {
      return null;
    }

    if (existingMatchup.teamAScore > existingMatchup.teamBScore) {
      return existingMatchup.teamAOwnerId;
    }

    if (existingMatchup.teamBScore > existingMatchup.teamAScore) {
      return existingMatchup.teamBOwnerId;
    }

    return null;
  }
}
