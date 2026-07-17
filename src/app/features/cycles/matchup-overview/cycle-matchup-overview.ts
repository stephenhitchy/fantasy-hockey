import {
  Component,
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
  CycleScoringResult
} from '../../../core/cycle/cycle-scoring.service';

import {
  FantasyCycle,
  FantasyMatchup
} from '../../../core/cycle/cycle.models';

import {
  buildCycleSchedulePreview,
  CycleSchedulePreviewMatchup,
  listenToCycle,
  listenToCycleMatchups,
  listenToCycleRosterPicks
} from '../../../core/cycle/cycle.service';


import {
  DraftableAsset,
  DraftPick
} from '../../../core/draft/draft.models';

import {
  getFantasyDraft,
  listenToDraftPicks
} from '../../../core/draft/draft.service';

import {
  loadDraftPlayerPool
} from '../../../core/draft/draft-player-pool.service';

import {
  getFrozenCycleProjection
} from '../../../core/projection/cycle-projection.util';

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

import {
  listenToSharedCycleScoring
} from '../../../core/live-scoring/live-scoring.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-cycle-matchup-overview',
  imports: [RouterLink],
  templateUrl: './cycle-matchup-overview.html',
  styleUrl: './cycle-matchup-overview.css'
})
export class CycleMatchupOverview implements OnDestroy {
  leagueId = '';
  cycleNumber = 1;

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  cycle = signal<FantasyCycle | null>(null);
  matchups = signal<FantasyMatchup[]>([]);
  previewMatchups = signal<CycleSchedulePreviewMatchup[]>([]);
  picks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);
  cycleScoring = signal<CycleScoringResult | null>(null);

  loading = signal(true);
  scoringLoading = signal(false);
  errorMessage = signal('');
  scoringError = signal('');

  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private stopCycleRosterPicksListener: (() => void) | null = null;
  private stopSharedScoringListener: (() => void) | null = null;
  private liveDraftPicks: DraftPick[] = [];
  private cycleRosterSnapshotPicks: DraftPick[] = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    void this.loadOverviewPage();
  }

  ngOnDestroy(): void {
    this.stopCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopPicksListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopSharedScoringListener?.();
  }

  async loadOverviewPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const cycleNumberParam = this.route.snapshot.paramMap.get('cycleNumber');
    const user = await waitForAuthUser();

    const parsedCycleNumber = Number(cycleNumberParam);

    if (!leagueId || !user || !Number.isInteger(parsedCycleNumber) || parsedCycleNumber < 1) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.cycleNumber = parsedCycleNumber;

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

      this.scoringLoading.set(true);
      this.stopSharedScoringListener = listenToSharedCycleScoring(
        leagueId,
        this.cycleNumber,
        (snapshot) => {
          this.cycleScoring.set(snapshot?.result ?? null);
          this.scoringLoading.set(false);
          this.scoringError.set('');
        },
        (error) => {
          this.scoringLoading.set(false);
          this.scoringError.set(error.message);
        }
      );

      const regularSeasonCycleCount =
        getStandardRegularSeasonCycleCount(teams.length);
      const preview = this.cycleNumber <= regularSeasonCycleCount
        ? buildCycleSchedulePreview(
            teams,
            draft,
            this.cycleNumber
          )
        : [];

      this.previewMatchups.set(
        preview.find(
          (cycle) => cycle.cycleNumber === this.cycleNumber
        )?.matchups ?? []
      );

      this.stopCycleListener = listenToCycle(
        leagueId,
        this.cycleNumber,
        (cycle) => {
          this.cycle.set(cycle);
          void this.loadCurrentCycleScoringIfReady();
        }
      );

      this.stopMatchupsListener = listenToCycleMatchups(
        leagueId,
        this.cycleNumber,
        (matchups) => {
          this.matchups.set(matchups);
        }
      );

      this.stopCycleRosterPicksListener = listenToCycleRosterPicks(
        leagueId,
        this.cycleNumber,
        (picks) => {
          this.cycleRosterSnapshotPicks = picks;
          this.refreshEffectivePicks();
        }
      );

      this.stopPicksListener = listenToDraftPicks(
        leagueId,
        (picks) => {
          this.liveDraftPicks = picks;
          this.refreshEffectivePicks();
        }
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load matchup overview.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  getCycleLabel(): string {
    const cycle = this.cycle();

    if (cycle?.phase === 'playoffs') {
      return cycle.playoffRoundLabel ??
        `Playoff Cycle ${this.cycleNumber}`;
    }

    return `Cycle ${this.cycleNumber}`;
  }

  getCycleStatusLabel(): string {
    const cycle = this.cycle();

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

  getOverviewStatusText(): string {
    if (!this.cycle()) {
      return `${this.getCycleLabel()} has not been created yet. This page is showing the scheduled matchups.`;
    }

    if (this.scoringLoading()) {
      return 'Loading current fantasy scores from NHL game data...';
    }

    if (this.scoringError()) {
      return this.scoringError();
    }

    if (this.cycle()?.status === 'complete') {
      return `${this.getCycleLabel()} is complete. Final scores and winners are saved.`;
    }

    return `${this.getCycleLabel()} is active. Scores update from the current scoring calculation when available.`;
  }

  getMatchupList(): CycleSchedulePreviewMatchup[] {
    if (this.matchups().length > 0) {
      return this.matchups().map((matchup) => ({
        id: matchup.id,
        teamAOwnerId: matchup.teamAOwnerId,
        teamBOwnerId: matchup.teamBOwnerId
      }));
    }

    return this.previewMatchups();
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
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): number | null {
    if (!ownerId) {
      return null;
    }

    const existingMatchup = this.getExistingMatchup(matchup);
    const cycleComplete = this.cycle()?.status === 'complete';

    if (existingMatchup && cycleComplete) {
      if (existingMatchup.teamAOwnerId === ownerId) {
        return existingMatchup.teamAScore;
      }

      if (existingMatchup.teamBOwnerId === ownerId) {
        return existingMatchup.teamBScore;
      }
    }

    const liveScore = this.cycleScoring()?.teamScores[ownerId];

    if (typeof liveScore === 'number') {
      return liveScore;
    }

    if (existingMatchup) {
      if (existingMatchup.teamAOwnerId === ownerId) {
        return existingMatchup.teamAScore;
      }

      if (existingMatchup.teamBOwnerId === ownerId) {
        return existingMatchup.teamBScore;
      }
    }

    return null;
  }

  getScoreLabel(): string {
    return this.cycle()?.status === 'complete'
      ? 'Final'
      : 'Current';
  }

  getMatchupStatusLabel(matchup: CycleSchedulePreviewMatchup): string {
    const existingMatchup = this.getExistingMatchup(matchup);

    if (!this.cycle()) {
      return 'Not Started';
    }

    if (!matchup.teamBOwnerId) {
      return this.isCompletedMatchup(matchup)
        ? 'Bye Win'
        : 'Bye';
    }

    if (existingMatchup?.status === 'complete' || this.cycle()?.status === 'complete') {
      return 'Complete';
    }

    return 'Active';
  }

  getMatchupResultText(matchup: CycleSchedulePreviewMatchup): string {
    if (!this.isCompletedMatchup(matchup)) {
      if (!matchup.teamBOwnerId) {
        return `${this.getTeamName(matchup.teamAOwnerId)} has a bye.`;
      }

      return `${this.getTeamName(matchup.teamAOwnerId)} vs ${this.getTeamName(matchup.teamBOwnerId)}`;
    }

    if (!matchup.teamBOwnerId) {
      return `${this.getTeamName(matchup.teamAOwnerId)} received a bye win.`;
    }

    const teamAScore = this.getTeamActualScore(matchup, matchup.teamAOwnerId) ?? 0;
    const teamBScore = this.getTeamActualScore(matchup, matchup.teamBOwnerId) ?? 0;
    const winnerOwnerId = this.getWinnerOwnerId(matchup);

    if (!winnerOwnerId) {
      return `Final tie, ${teamAScore.toFixed(1)} to ${teamBScore.toFixed(1)}.`;
    }

    const difference = Math.abs(teamAScore - teamBScore);

    return `${this.getTeamName(winnerOwnerId)} won by ${difference.toFixed(1)}.`;
  }

  getResultLabel(
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): string {
    if (!ownerId || !this.isCompletedMatchup(matchup)) {
      return '';
    }

    if (!matchup.teamBOwnerId && ownerId === matchup.teamAOwnerId) {
      return 'Bye Win';
    }

    const winnerOwnerId = this.getWinnerOwnerId(matchup);

    if (!winnerOwnerId) {
      return 'Tie';
    }

    return winnerOwnerId === ownerId
      ? 'Winner'
      : 'Lost';
  }

  isWinner(
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): boolean {
    if (!ownerId || !this.isCompletedMatchup(matchup)) {
      return false;
    }

    return this.getWinnerOwnerId(matchup) === ownerId;
  }

  isLoser(
    matchup: CycleSchedulePreviewMatchup,
    ownerId: string | null
  ): boolean {
    if (!ownerId || !matchup.teamBOwnerId || !this.isCompletedMatchup(matchup)) {
      return false;
    }

    const winnerOwnerId = this.getWinnerOwnerId(matchup);

    return Boolean(winnerOwnerId && winnerOwnerId !== ownerId);
  }

  getMatchupCardClass(matchup: CycleSchedulePreviewMatchup): string {
    if (!this.cycle()) {
      return 'not-started-matchup-card';
    }

    if (this.isCompletedMatchup(matchup)) {
      return 'completed-matchup-card';
    }

    return 'active-matchup-card';
  }

  private async loadCurrentCycleScoringIfReady(): Promise<void> {
    if (this.cycleScoring()) {
      this.scoringLoading.set(false);
      return;
    }

    if (this.cycle() && this.picks().length > 0) {
      this.scoringLoading.set(true);
    }
  }

  private getAssetProjectedCycle(asset: DraftableAsset): number | null {
    return getFrozenCycleProjection(asset);
  }

  private refreshEffectivePicks(): void {
    const effectivePicks = this.cycleRosterSnapshotPicks.length > 0
      ? this.cycleRosterSnapshotPicks
      : this.liveDraftPicks;

    this.picks.set(effectivePicks);
    void this.loadCurrentCycleScoringIfReady();
  }

  private getExistingMatchup(
    matchup: CycleSchedulePreviewMatchup
  ): FantasyMatchup | null {
    return this.matchups().find(
      (existingMatchup) => existingMatchup.id === matchup.id
    ) ?? this.matchups().find(
      (existingMatchup) =>
        existingMatchup.teamAOwnerId === matchup.teamAOwnerId &&
        existingMatchup.teamBOwnerId === matchup.teamBOwnerId
    ) ?? null;
  }

  private isCompletedMatchup(matchup: CycleSchedulePreviewMatchup): boolean {
    const existingMatchup = this.getExistingMatchup(matchup);

    return (
      existingMatchup?.status === 'complete' ||
      this.cycle()?.status === 'complete'
    );
  }

  private getWinnerOwnerId(
    matchup: CycleSchedulePreviewMatchup
  ): string | null {
    const existingMatchup = this.getExistingMatchup(matchup);

    if (existingMatchup?.winnerOwnerId) {
      return existingMatchup.winnerOwnerId;
    }

    if (!matchup.teamBOwnerId) {
      return null;
    }

    const teamAScore = this.getTeamActualScore(matchup, matchup.teamAOwnerId) ?? 0;
    const teamBScore = this.getTeamActualScore(matchup, matchup.teamBOwnerId) ?? 0;

    if (teamAScore > teamBScore) {
      return matchup.teamAOwnerId;
    }

    if (teamBScore > teamAScore) {
      return matchup.teamBOwnerId;
    }

    return null;
  }


}
