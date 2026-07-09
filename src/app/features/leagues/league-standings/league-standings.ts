import {
  Component,
  computed,
  signal
} from '@angular/core';

import {
  ActivatedRoute,
  Router,
  RouterLink
} from '@angular/router';

import {
  collection,
  getDocs
} from 'firebase/firestore';

import {
  onAuthStateChanged,
  User
} from 'firebase/auth';

import { auth, db } from '../../../core/firebase';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

interface StandingCycleSummary {
  id: string;
  cycleNumber: number;
  status: string;
}

interface StandingMatchupSummary {
  id: string;
  cycleNumber: number;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string | null;
  status: string;
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
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string'
    ? value
    : fallback;
}

function getNullableString(value: unknown): string | null {
  return typeof value === 'string'
    ? value
    : null;
}

@Component({
  selector: 'app-league-standings',
  imports: [RouterLink],
  templateUrl: './league-standings.html',
  styleUrl: './league-standings.css'
})
export class LeagueStandings {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  cycles = signal<StandingCycleSummary[]>([]);
  matchups = signal<StandingMatchupSummary[]>([]);

  loading = signal(true);
  refreshing = signal(false);
  errorMessage = signal('');

  readonly completedMatchups = computed(() =>
    this.matchups().filter((matchup) =>
      matchup.status === 'complete'
    )
  );

  readonly activeCycle = computed(() =>
    this.cycles().find((cycle) => cycle.status === 'active') ?? null
  );

  readonly latestCycle = computed(() => {
    const cycles = this.cycles();

    if (cycles.length === 0) {
      return null;
    }

    return [...cycles].sort(
      (first, second) => second.cycleNumber - first.cycleNumber
    )[0];
  });

  readonly currentCycleNumber = computed(() =>
    this.activeCycle()?.cycleNumber ??
    this.latestCycle()?.cycleNumber ??
    1
  );

  readonly standingsRows = computed<StandingRow[]>(() => {
    const completedMatchups = this.completedMatchups();

    const rows = this.teams().map((team) => {
      const wins = getNumber((team as Partial<FantasyTeam> & { wins?: number }).wins);
      const losses = getNumber((team as Partial<FantasyTeam> & { losses?: number }).losses);
      const ties = getNumber((team as Partial<FantasyTeam> & { ties?: number }).ties);
      const gamesPlayed = wins + losses + ties;

      let pointsFor = 0;
      let pointsAgainst = 0;

      for (const matchup of completedMatchups) {
        if (matchup.teamAOwnerId === team.ownerId) {
          pointsFor += matchup.teamAScore;
          pointsAgainst += matchup.teamBScore;
        }

        if (matchup.teamBOwnerId === team.ownerId) {
          pointsFor += matchup.teamBScore;
          pointsAgainst += matchup.teamAScore;
        }
      }

      const roundedPointsFor = Number(pointsFor.toFixed(1));
      const roundedPointsAgainst = Number(pointsAgainst.toFixed(1));
      const pointDifferential = Number(
        (roundedPointsFor - roundedPointsAgainst).toFixed(1)
      );

      const winPercentage = gamesPlayed > 0
        ? Number(((wins + ties * 0.5) / gamesPlayed).toFixed(3))
        : 0;

      return {
        rank: 0,
        ownerId: team.ownerId,
        teamName: team.teamName,
        wins,
        losses,
        ties,
        gamesPlayed,
        winPercentage,
        pointsFor: roundedPointsFor,
        pointsAgainst: roundedPointsAgainst,
        pointDifferential
      };
    });

    return rows
      .sort((first, second) => {
        if (second.winPercentage !== first.winPercentage) {
          return second.winPercentage - first.winPercentage;
        }

        if (second.wins !== first.wins) {
          return second.wins - first.wins;
        }

        if (second.pointDifferential !== first.pointDifferential) {
          return second.pointDifferential - first.pointDifferential;
        }

        if (second.pointsFor !== first.pointsFor) {
          return second.pointsFor - first.pointsFor;
        }

        return first.teamName.localeCompare(second.teamName);
      })
      .map((row, index) => ({
        ...row,
        rank: index + 1
      }));
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
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
        error instanceof Error
          ? error.message
          : 'Unable to load league standings.'
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
        error instanceof Error
          ? error.message
          : 'Unable to refresh league standings.'
      );
    } finally {
      this.refreshing.set(false);
    }
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

    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
  }

  getLeagueStatusText(): string {
    const activeCycle = this.activeCycle();

    if (activeCycle) {
      return `Cycle ${activeCycle.cycleNumber} is currently active.`;
    }

    const latestCycle = this.latestCycle();

    if (latestCycle?.status === 'complete') {
      return `Cycle ${latestCycle.cycleNumber} is complete. The league is waiting for the next playable cycle.`;
    }

    if (latestCycle) {
      return `Latest cycle: Cycle ${latestCycle.cycleNumber}.`;
    }

    return 'No cycles have started yet.';
  }

  getActiveMatchup(ownerId: string): StandingMatchupSummary | null {
    const activeCycle = this.activeCycle();

    if (!activeCycle) {
      return null;
    }

    return this.matchups().find((matchup) =>
      matchup.cycleNumber === activeCycle.cycleNumber &&
      matchup.status === 'active' &&
      (
        matchup.teamAOwnerId === ownerId ||
        matchup.teamBOwnerId === ownerId
      )
    ) ?? null;
  }

  getActiveMatchupOpponentLabel(ownerId: string): string {
    const matchup = this.getActiveMatchup(ownerId);

    if (!matchup) {
      return 'No active matchup';
    }

    if (!matchup.teamBOwnerId) {
      return 'Bye';
    }

    const opponentOwnerId = matchup.teamAOwnerId === ownerId
      ? matchup.teamBOwnerId
      : matchup.teamAOwnerId;

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

    return [
      '/leagues',
      this.leagueId,
      'cycles',
      matchup.cycleNumber,
      'matchups',
      matchup.id
    ];
  }

  getLastResultLabel(ownerId: string): string {
    const lastMatchup = [...this.completedMatchups()]
      .filter((matchup) =>
        matchup.teamAOwnerId === ownerId ||
        matchup.teamBOwnerId === ownerId
      )
      .sort((first, second) =>
        second.cycleNumber - first.cycleNumber
      )[0];

    if (!lastMatchup) {
      return 'No completed matchups';
    }

    if (!lastMatchup.teamBOwnerId) {
      return `Cycle ${lastMatchup.cycleNumber}: Bye win`;
    }

    if (!lastMatchup.winnerOwnerId) {
      return `Cycle ${lastMatchup.cycleNumber}: Tie`;
    }

    return lastMatchup.winnerOwnerId === ownerId
      ? `Cycle ${lastMatchup.cycleNumber}: Win`
      : `Cycle ${lastMatchup.cycleNumber}: Loss`;
  }

  private async loadLeagueData(): Promise<void> {
    const [league, teams] = await Promise.all([
      getLeagueById(this.leagueId),
      getLeagueTeams(this.leagueId)
    ]);

    if (!league) {
      throw new Error('League not found.');
    }

    this.league.set(league);
    this.teams.set(teams);

    await this.loadCycleAndMatchupData();
  }

  private async loadCycleAndMatchupData(): Promise<void> {
    const cycleSnapshots = await getDocs(
      collection(db, 'leagues', this.leagueId, 'cycles')
    );

    const cycles: StandingCycleSummary[] = cycleSnapshots.docs
      .map((cycleDoc) => {
        const data = cycleDoc.data();
        const cycleNumber = getNumber(
          data['cycleNumber'],
          parseCycleNumberFromId(cycleDoc.id)
        );

        return {
          id: cycleDoc.id,
          cycleNumber,
          status: getString(data['status'], 'active')
        };
      })
      .filter((cycle) => cycle.cycleNumber > 0)
      .sort((first, second) =>
        first.cycleNumber - second.cycleNumber
      );

    const matchupsByCycle = await Promise.all(
      cycles.map(async (cycle) => {
        const matchupSnapshots = await getDocs(
          collection(
            db,
            'leagues',
            this.leagueId,
            'cycles',
            cycle.id,
            'matchups'
          )
        );

        return matchupSnapshots.docs.map((matchupDoc) => {
          const data = matchupDoc.data();

          return {
            id: getString(data['id'], matchupDoc.id),
            cycleNumber: getNumber(
              data['cycleNumber'],
              cycle.cycleNumber
            ),
            teamAOwnerId: getString(data['teamAOwnerId']),
            teamBOwnerId: getNullableString(data['teamBOwnerId']),
            teamAScore: getNumber(data['teamAScore']),
            teamBScore: getNumber(data['teamBScore']),
            winnerOwnerId: getNullableString(data['winnerOwnerId']),
            status: getString(data['status'], cycle.status)
          } satisfies StandingMatchupSummary;
        });
      })
    );

    this.cycles.set(cycles);
    this.matchups.set(
      matchupsByCycle
        .flat()
        .sort((first, second) => {
          if (first.cycleNumber !== second.cycleNumber) {
            return first.cycleNumber - second.cycleNumber;
          }

          return first.id.localeCompare(second.id);
        })
    );
  }
}
