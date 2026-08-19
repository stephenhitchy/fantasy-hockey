import { Component, computed, signal } from '@angular/core';

import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { collection, getDocs } from 'firebase/firestore';

import { onAuthStateChanged, User } from 'firebase/auth';

import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';
import { getFantasyTeamProfileIconId } from '../../../core/team/team.service';
import { auth, db } from '../../../core/firebase';

import { getLeagueById, League } from '../../../core/league/league.service';
import { shareLeagueStandingsCard } from '../../../core/league/league-standings-share-card.service';

import { buildFantasyStandings } from '../../../core/league/standings.util';
import {
  buildLeaguePowerRankings,
  type LeaguePowerRankingRow,
} from '../../../core/league/league-power-rankings.util';

import { getStandardPlayoffTeamCount } from '../../../core/playoffs/playoff-format';

import { FantasyPlayoffs } from '../../../core/playoffs/playoff.models';

import { getFantasyPlayoffs } from '../../../core/playoffs/playoff.service';

import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

interface StandingCycleSummary {
  id: string;
  cycleNumber: number;
  status: string;
  phase: 'regular_season' | 'playoffs';
  playoffRoundLabel: string | null;
}

interface StandingMatchupSummary {
  id: string;
  cycleNumber: number;
  phase: 'regular_season' | 'playoffs';
  playoffRoundLabel: string | null;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string | null;
  status: string;
  tieBrokenByHigherSeed: boolean;
}

interface StandingRow {
  rank: number;
  ownerId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  winPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
}

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

function parseCycleNumberFromId(cycleId: string): number {
  const match = cycleId.match(/cycle-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function getNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

@Component({
  selector: 'app-league-standings',
  imports: [RouterLink, ManagerAvatar],
  templateUrl: './league-standings.html',
  styleUrl: './league-standings.css',
})
export class LeagueStandings {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  cycles = signal<StandingCycleSummary[]>([]);
  matchups = signal<StandingMatchupSummary[]>([]);
  playoffs = signal<FantasyPlayoffs | null>(null);

  loading = signal(true);
  refreshing = signal(false);
  errorMessage = signal('');

  standingsShareInProgress = signal(false);
  standingsShareStatusMessage = signal('');
  standingsShareErrorMessage = signal('');
  viewMode = signal<'official' | 'power'>('official');

  readonly completedMatchups = computed(() =>
    this.matchups().filter((matchup) => matchup.status === 'complete'),
  );

  readonly completedRegularSeasonMatchups = computed(() =>
    this.completedMatchups().filter(
      (matchup) => matchup.phase === 'regular_season' && matchup.teamBOwnerId,
    ),
  );

  readonly activeCycle = computed(
    () => this.cycles().find((cycle) => cycle.status === 'active') ?? null,
  );

  readonly latestCycle = computed(() => {
    const cycles = this.cycles();

    if (cycles.length === 0) {
      return null;
    }

    return [...cycles].sort((first, second) => second.cycleNumber - first.cycleNumber)[0];
  });

  readonly currentCycleNumber = computed(
    () => this.activeCycle()?.cycleNumber ?? this.latestCycle()?.cycleNumber ?? 1,
  );

  readonly playoffTeamCount = computed(
    () => this.playoffs()?.playoffTeamCount ?? getStandardPlayoffTeamCount(this.teams().length),
  );

  readonly standingsRows = computed<StandingRow[]>(() =>
    buildFantasyStandings(this.teams()).map((row, index) => ({
      ...row,
      rank: index + 1,
    })),
  );

  readonly powerRankings = computed(() =>
    buildLeaguePowerRankings({
      teams: this.teams(),
      matchups: this.matchups(),
    }),
  );

  readonly powerRankingRows = computed<LeaguePowerRankingRow[]>(() =>
    this.powerRankings().rows,
  );

  readonly canShareStandings = computed(() =>
    Boolean(this.league()) && this.standingsRows().length >= 2,
  );


  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    void this.loadStandingsPage();
  }

  async loadStandingsPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;

    try {
      await this.loadLeagueData();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load league standings.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  async refreshStandings(): Promise<void> {
    this.refreshing.set(true);
    this.errorMessage.set('');

    try {
      await this.loadLeagueData();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to refresh league standings.',
      );
    } finally {
      this.refreshing.set(false);
    }
  }

  selectView(mode: 'official' | 'power'): void {
    this.viewMode.set(mode);
    this.standingsShareStatusMessage.set('');
    this.standingsShareErrorMessage.set('');
  }

  isOfficialView(): boolean {
    return this.viewMode() === 'official';
  }

  isPowerView(): boolean {
    return this.viewMode() === 'power';
  }

  getPowerRankingsPeriodLabel(): string {
    const cycleNumber = this.powerRankings().asOfCycleNumber;
    return cycleNumber ? `Through Matchup ${cycleNumber}` : 'Waiting for the first final';
  }

  getPowerMovementLabel(row: LeaguePowerRankingRow): string {
    if (row.movement > 0) {
      return `↑${row.movement} vs official`;
    }

    if (row.movement < 0) {
      return `↓${Math.abs(row.movement)} vs official`;
    }

    return 'Same as official';
  }

  getPowerRecentRecord(row: LeaguePowerRankingRow): string {
    return row.recentGamesPlayed > 0
      ? `${row.recentWins}-${row.recentLosses}-${row.recentTies}`
      : '—';
  }

  getPowerScoreLabel(row: LeaguePowerRankingRow): string {
    return row.powerScore.toFixed(1);
  }

  getPowerFactorWeight(weight: number): string {
    return `${Math.round(weight * 100)}%`;
  }

  getPowerFactorContribution(value: number): string {
    return `${value.toFixed(1)} pts`;
  }

  async shareCurrentStandings(): Promise<void> {
    if (!this.canShareStandings() || this.standingsShareInProgress()) {
      return;
    }

    const league = this.league();
    if (!league) {
      this.standingsShareErrorMessage.set('The standings card is not ready yet.');
      return;
    }

    this.standingsShareInProgress.set(true);
    this.standingsShareStatusMessage.set('');
    this.standingsShareErrorMessage.set('');

    try {
      const rows = this.standingsRows();
      const result = await shareLeagueStandingsCard({
        leagueName: league.name,
        periodLabel: this.getCurrentPeriodLabel(),
        totalTeams: Math.max(2, this.teams().length),
        playoffTeamCount: this.playoffTeamCount(),
        rows: rows.map((row) => ({
          rank: row.rank,
          teamName: row.teamName,
          record: this.getRecordLabel(row),
          pointsFor: row.pointsFor,
          pointDifferential: row.pointDifferential,
          playoffQualifier: this.isPlayoffQualifier(row),
          currentManager: row.ownerId === this.userId,
        })),
      });

      if (result.outcome !== 'cancelled') {
        this.standingsShareStatusMessage.set(result.message);
      }
    } catch (error) {
      this.standingsShareErrorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to prepare the standings card right now.',
      );
    } finally {
      this.standingsShareInProgress.set(false);
    }
  }

  isPlayoffQualifier(row: StandingRow): boolean {
    return row.rank <= this.playoffTeamCount();
  }

  isPlayoffCutLine(row: StandingRow): boolean {
    return row.rank === this.playoffTeamCount();
  }

  getRecordLabel(row: StandingRow): string {
    return `${row.wins}-${row.losses}-${row.ties}`;
  }

  getWinPercentageLabel(row: StandingRow): string {
    if (row.gamesPlayed === 0) {
      return '—';
    }

    return row.winPercentage.toFixed(3).replace(/^0/, '');
  }

  getPointDisplay(value: number): string {
    return value.toFixed(1);
  }

  getPointDifferentialDisplay(value: number): string {
    if (value > 0) {
      return `+${value.toFixed(1)}`;
    }

    return value.toFixed(1);
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  getCurrentPeriodLabel(): string {
    const activeCycle = this.activeCycle();
    const latestCycle = this.latestCycle();
    const cycle = activeCycle ?? latestCycle;

    if (!cycle) {
      return 'Matchup 1';
    }

    return cycle.phase === 'playoffs'
      ? (cycle.playoffRoundLabel ?? `Playoff Matchup ${cycle.cycleNumber}`)
      : `Matchup ${cycle.cycleNumber}`;
  }

  getLeagueStatusText(): string {
    const activeCycle = this.activeCycle();

    if (activeCycle) {
      return `${this.getCurrentPeriodLabel()} is currently active.`;
    }

    if (this.playoffs()?.status === 'complete') {
      const champion = this.getTeamName(this.playoffs()?.championOwnerId ?? null);
      return `The fantasy season is complete. ${champion} won the league championship.`;
    }

    const latestCycle = this.latestCycle();

    if (latestCycle?.status === 'complete') {
      return `${this.getCurrentPeriodLabel()} is complete. The league is waiting for the next matchup period.`;
    }

    if (latestCycle) {
      return `Latest matchup period: ${this.getCurrentPeriodLabel()}.`;
    }

    return 'No matchups have started yet.';
  }

  getActiveMatchup(ownerId: string): StandingMatchupSummary | null {
    const activeCycle = this.activeCycle();

    if (!activeCycle) {
      return null;
    }

    return (
      this.matchups().find(
        (matchup) =>
          matchup.cycleNumber === activeCycle.cycleNumber &&
          matchup.status === 'active' &&
          (matchup.teamAOwnerId === ownerId || matchup.teamBOwnerId === ownerId),
      ) ?? null
    );
  }

  getActiveMatchupOpponentLabel(ownerId: string): string {
    const matchup = this.getActiveMatchup(ownerId);

    if (!matchup) {
      return 'No active matchup';
    }

    if (!matchup.teamBOwnerId) {
      return 'Bye';
    }

    const opponentOwnerId =
      matchup.teamAOwnerId === ownerId ? matchup.teamBOwnerId : matchup.teamAOwnerId;

    return `vs ${this.getTeamName(opponentOwnerId)}`;
  }

  getActiveMatchupScoreLabel(ownerId: string): string {
    const matchup = this.getActiveMatchup(ownerId);

    if (!matchup) {
      return '';
    }

    if (matchup.teamAOwnerId === ownerId) {
      return `${matchup.teamAScore.toFixed(1)} - ${matchup.teamBScore.toFixed(1)}`;
    }

    return `${matchup.teamBScore.toFixed(1)} - ${matchup.teamAScore.toFixed(1)}`;
  }

  getActiveMatchupLink(row: StandingRow): unknown[] | null {
    const matchup = this.getActiveMatchup(row.ownerId);

    if (!matchup) {
      return null;
    }

    return ['/leagues', this.leagueId, 'cycles', matchup.cycleNumber, 'matchups', matchup.id];
  }

  getLastResultLabel(ownerId: string): string {
    const lastMatchup = [...this.completedMatchups()]
      .filter(
        (matchup) =>
          matchup.teamBOwnerId &&
          (matchup.teamAOwnerId === ownerId || matchup.teamBOwnerId === ownerId),
      )
      .sort((first, second) => second.cycleNumber - first.cycleNumber)[0];

    if (!lastMatchup) {
      return 'No completed matchups';
    }

    const periodLabel =
      lastMatchup.phase === 'playoffs'
        ? (lastMatchup.playoffRoundLabel ?? `Playoffs`)
        : `Matchup ${lastMatchup.cycleNumber}`;

    if (lastMatchup.tieBrokenByHigherSeed) {
      return lastMatchup.winnerOwnerId === ownerId
        ? `${periodLabel}: Advanced on seed`
        : `${periodLabel}: Eliminated on seed`;
    }

    if (!lastMatchup.winnerOwnerId) {
      return `${periodLabel}: Tie`;
    }

    return lastMatchup.winnerOwnerId === ownerId ? `${periodLabel}: Win` : `${periodLabel}: Loss`;
  }

  private async loadLeagueData(): Promise<void> {
    const [league, teams, playoffs] = await Promise.all([
      getLeagueById(this.leagueId),
      getLeagueTeams(this.leagueId),
      getFantasyPlayoffs(this.leagueId),
    ]);

    if (!league) {
      throw new Error('League not found.');
    }

    this.league.set(league);
    this.teams.set(teams);
    this.playoffs.set(playoffs);

    await this.loadCycleAndMatchupData();
  }

  private async loadCycleAndMatchupData(): Promise<void> {
    const cycleSnapshots = await getDocs(collection(db, 'leagues', this.leagueId, 'cycles'));

    const cycles: StandingCycleSummary[] = cycleSnapshots.docs
      .map((cycleDoc) => {
        const data = cycleDoc.data();
        const cycleNumber = getNumber(data['cycleNumber'], parseCycleNumberFromId(cycleDoc.id));

        return {
          id: cycleDoc.id,
          cycleNumber,
          status: getString(data['status'], 'active'),
          phase: data['phase'] === 'playoffs' ? 'playoffs' : 'regular_season',
          playoffRoundLabel: getNullableString(data['playoffRoundLabel']),
        } satisfies StandingCycleSummary;
      })
      .filter((cycle) => cycle.cycleNumber > 0)
      .sort((first, second) => first.cycleNumber - second.cycleNumber);

    const matchupsByCycle = await Promise.all(
      cycles.map(async (cycle) => {
        const matchupSnapshots = await getDocs(
          collection(db, 'leagues', this.leagueId, 'cycles', cycle.id, 'matchups'),
        );

        return matchupSnapshots.docs.map((matchupDoc) => {
          const data = matchupDoc.data();

          return {
            id: getString(data['id'], matchupDoc.id),
            cycleNumber: getNumber(data['cycleNumber'], cycle.cycleNumber),
            phase: data['phase'] === 'playoffs' ? 'playoffs' : cycle.phase,
            playoffRoundLabel: cycle.playoffRoundLabel,
            teamAOwnerId: getString(data['teamAOwnerId']),
            teamBOwnerId: getNullableString(data['teamBOwnerId']),
            teamAScore: getNumber(data['teamAScore']),
            teamBScore: getNumber(data['teamBScore']),
            winnerOwnerId: getNullableString(data['winnerOwnerId']),
            status: getString(data['status'], cycle.status),
            tieBrokenByHigherSeed: data['tieBrokenByHigherSeed'] === true,
          } satisfies StandingMatchupSummary;
        });
      }),
    );

    this.cycles.set(cycles);
    this.matchups.set(
      matchupsByCycle.flat().sort((first, second) => {
        if (first.cycleNumber !== second.cycleNumber) {
          return first.cycleNumber - second.cycleNumber;
        }

        return first.id.localeCompare(second.id);
      }),
    );
  }

  getTeamProfileIconId(ownerId: string | null | undefined): string {
    const team = ownerId
      ? this.teams().find((candidate) => candidate.ownerId === ownerId)
      : null;
    return getFantasyTeamProfileIconId(team);
  }

  getTeamManagerLabel(ownerId: string | null | undefined): string {
    const team = ownerId
      ? this.teams().find((candidate) => candidate.ownerId === ownerId)
      : null;
    return team?.managerName?.trim() || team?.teamName?.trim() || 'Manager';
  }

}
