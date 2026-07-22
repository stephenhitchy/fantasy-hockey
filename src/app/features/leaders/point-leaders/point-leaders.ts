import { Component, computed, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import { FantasyCycle, FantasyTeamCycleWindows } from '../../../core/cycle/cycle.models';
import { listenToCycleTeamWindows } from '../../../core/cycle/asset-cycle-window.service';
import { listenToLeagueCycles } from '../../../core/cycle/cycle.service';
import { DraftableAsset } from '../../../core/draft/draft.models';
import { getLeagueById, League } from '../../../core/league/league.service';
import { FantasyTeam, listenToLeagueTeams } from '../../../core/team/team.service';

type LeaderGroup = 'forwards' | 'defense' | 'goalies';

interface PointLeaderRow {
  rank: number;
  assetKey: string;
  asset: DraftableAsset;
  group: LeaderGroup;
  ownerId: string;
  totalPoints: number;
  gamesPlayed: number;
  appearances: number;
  cycleCount: number;
  latestCycleNumber: number;
  pointsPerGame: number;
}

interface MutableLeaderRow {
  assetKey: string;
  asset: DraftableAsset;
  group: LeaderGroup;
  ownerId: string;
  totalPoints: number;
  gamesPlayed: number;
  appearances: number;
  cycleNumbers: Set<number>;
  latestCycleNumber: number;
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

function getFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getLeaderGroup(asset: DraftableAsset): LeaderGroup {
  if (asset.assetType === 'team-goalie-unit') {
    return 'goalies';
  }

  return asset.position === 'D' ? 'defense' : 'forwards';
}

@Component({
  selector: 'app-point-leaders',
  imports: [RouterLink],
  templateUrl: './point-leaders.html',
  styleUrl: './point-leaders.css',
})
export class PointLeaders implements OnDestroy {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  cycles = signal<FantasyCycle[]>([]);
  windowsByCycle = signal<Record<number, FantasyTeamCycleWindows[]>>({});

  loading = signal(true);
  errorMessage = signal('');
  selectedGroup = signal<LeaderGroup>('forwards');
  selectedCycleNumber = signal(0);

  private stopCyclesListener: (() => void) | null = null;
  private stopTeamsListener: (() => void) | null = null;
  private readonly stopWindowListeners = new Map<number, () => void>();

  readonly sortedCycles = computed(() =>
    [...this.cycles()].sort((first, second) => first.cycleNumber - second.cycleNumber),
  );

  readonly latestCycleNumber = computed(() =>
    this.sortedCycles().at(-1)?.cycleNumber ?? 0,
  );

  readonly allLeaderRows = computed<PointLeaderRow[]>(() => {
    const selectedCycleNumber = this.selectedCycleNumber();
    const aggregate = new Map<string, MutableLeaderRow>();

    for (const [cycleNumberKey, teamWindows] of Object.entries(this.windowsByCycle())) {
      const cycleNumber = Number(cycleNumberKey);

      for (const teamWindow of teamWindows) {
        for (const window of teamWindow.windows) {
          const asset = window.asset;
          const windowCycleNumber = window.cycleNumber || cycleNumber;

          if (selectedCycleNumber > 0 && windowCycleNumber !== selectedCycleNumber) {
            continue;
          }

          if (!asset?.assetKey) {
            continue;
          }

          const existing = aggregate.get(asset.assetKey);
          const latestCycleNumber = Math.max(cycleNumber, windowCycleNumber);

          if (!existing) {
            aggregate.set(asset.assetKey, {
              assetKey: asset.assetKey,
              asset,
              group: getLeaderGroup(asset),
              ownerId: window.ownerId,
              totalPoints: getFiniteNumber(window.fantasyPoints),
              gamesPlayed: Math.max(0, getFiniteNumber(window.gamesPlayed)),
              appearances: Math.max(0, getFiniteNumber(window.actualGamesPlayed)),
              cycleNumbers: new Set([latestCycleNumber]),
              latestCycleNumber,
            });
            continue;
          }

          existing.totalPoints += getFiniteNumber(window.fantasyPoints);
          existing.gamesPlayed += Math.max(0, getFiniteNumber(window.gamesPlayed));
          existing.appearances += Math.max(0, getFiniteNumber(window.actualGamesPlayed));
          existing.cycleNumbers.add(latestCycleNumber);

          if (latestCycleNumber >= existing.latestCycleNumber) {
            existing.latestCycleNumber = latestCycleNumber;
            existing.asset = asset;
            existing.ownerId = window.ownerId;
            existing.group = getLeaderGroup(asset);
          }
        }
      }
    }

    const rows = [...aggregate.values()]
      .filter((entry) => entry.gamesPlayed > 0 || Math.abs(entry.totalPoints) > 0.0001)
      .map<PointLeaderRow>((entry) => ({
        rank: 0,
        assetKey: entry.assetKey,
        asset: entry.asset,
        group: entry.group,
        ownerId: entry.ownerId,
        totalPoints: entry.totalPoints,
        gamesPlayed: entry.gamesPlayed,
        appearances: entry.appearances,
        cycleCount: entry.cycleNumbers.size,
        latestCycleNumber: entry.latestCycleNumber,
        pointsPerGame: entry.gamesPlayed > 0 ? entry.totalPoints / entry.gamesPlayed : 0,
      }));

    return rows.sort((first, second) =>
      second.totalPoints - first.totalPoints ||
      second.pointsPerGame - first.pointsPerGame ||
      this.getAssetName(first.asset).localeCompare(this.getAssetName(second.asset)),
    );
  });

  readonly forwardRows = computed(() => this.rankRows('forwards'));
  readonly defenseRows = computed(() => this.rankRows('defense'));
  readonly goalieRows = computed(() => this.rankRows('goalies'));

  readonly displayedRows = computed(() => {
    switch (this.selectedGroup()) {
      case 'defense':
        return this.defenseRows();
      case 'goalies':
        return this.goalieRows();
      default:
        return this.forwardRows();
    }
  });

  readonly topForward = computed(() => this.forwardRows()[0] ?? null);
  readonly topDefense = computed(() => this.defenseRows()[0] ?? null);
  readonly topGoalie = computed(() => this.goalieRows()[0] ?? null);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    void this.initializePage();
  }

  ngOnDestroy(): void {
    this.stopCyclesListener?.();
    this.stopTeamsListener?.();

    for (const stopListener of this.stopWindowListeners.values()) {
      stopListener();
    }

    this.stopWindowListeners.clear();
  }

  async initializePage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        this.errorMessage.set('League not found.');
        this.loading.set(false);
        return;
      }

      this.league.set(league);
      this.startTeamListener();
      this.startCycleListener();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load point leaders.',
      );
      this.loading.set(false);
    }
  }

  setGroup(group: LeaderGroup): void {
    this.selectedGroup.set(group);
  }

  setCycleScope(value: string): void {
    const cycleNumber = Number(value);
    this.selectedCycleNumber.set(Number.isFinite(cycleNumber) && cycleNumber > 0 ? cycleNumber : 0);
  }

  getGroupLabel(): string {
    switch (this.selectedGroup()) {
      case 'defense':
        return 'Defense Leaders';
      case 'goalies':
        return 'Goalie Unit Leaders';
      default:
        return 'Forward Leaders';
    }
  }

  getScopeLabel(): string {
    const cycleNumber = this.selectedCycleNumber();
    return cycleNumber > 0 ? `Cycle ${cycleNumber}` : 'Season Total';
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
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  }

  getFantasyTeamName(ownerId: string): string {
    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Former roster';
  }

  getPointsLabel(value: number): string {
    return value.toFixed(1);
  }

  getPointsPerGameLabel(row: PointLeaderRow): string {
    return row.gamesPlayed > 0 ? row.pointsPerGame.toFixed(2) : '—';
  }

  getGamesLabel(row: PointLeaderRow): string {
    if (row.asset.assetType === 'team-goalie-unit') {
      return `${row.gamesPlayed}`;
    }

    return row.appearances === row.gamesPlayed
      ? `${row.gamesPlayed}`
      : `${row.appearances}/${row.gamesPlayed}`;
  }

  getGamesTitle(row: PointLeaderRow): string {
    return row.asset.assetType === 'team-goalie-unit'
      ? `${row.gamesPlayed} NHL team games counted`
      : `${row.appearances} player appearances across ${row.gamesPlayed} NHL team games`;
  }

  private startTeamListener(): void {
    this.stopTeamsListener = listenToLeagueTeams(
      this.leagueId,
      (teams) => this.teams.set(teams),
      (error) => this.errorMessage.set(error.message),
    );
  }

  private startCycleListener(): void {
    this.stopCyclesListener = listenToLeagueCycles(
      this.leagueId,
      (cycles) => {
        this.cycles.set(cycles);
        this.syncWindowListeners(cycles);

        if (cycles.length === 0) {
          this.loading.set(false);
        }
      },
      (error) => {
        this.errorMessage.set(error.message);
        this.loading.set(false);
      },
    );
  }

  private syncWindowListeners(cycles: FantasyCycle[]): void {
    const cycleNumbers = new Set(cycles.map((cycle) => cycle.cycleNumber));

    for (const [cycleNumber, stopListener] of this.stopWindowListeners.entries()) {
      if (cycleNumbers.has(cycleNumber)) {
        continue;
      }

      stopListener();
      this.stopWindowListeners.delete(cycleNumber);
      this.windowsByCycle.update((current) => {
        const next = { ...current };
        delete next[cycleNumber];
        return next;
      });
    }

    for (const cycleNumber of cycleNumbers) {
      if (this.stopWindowListeners.has(cycleNumber)) {
        continue;
      }

      const stopListener = listenToCycleTeamWindows(
        this.leagueId,
        cycleNumber,
        (teamWindows) => {
          this.windowsByCycle.update((current) => ({
            ...current,
            [cycleNumber]: teamWindows,
          }));
          this.updateLoadingState(cycleNumbers);
        },
        (error) => {
          this.errorMessage.set(error.message);
          this.loading.set(false);
        },
      );

      this.stopWindowListeners.set(cycleNumber, stopListener);
    }
  }

  private updateLoadingState(cycleNumbers: Set<number>): void {
    const windowsByCycle = this.windowsByCycle();
    const allLoaded = [...cycleNumbers].every((cycleNumber) =>
      Object.prototype.hasOwnProperty.call(windowsByCycle, cycleNumber),
    );

    if (allLoaded) {
      this.loading.set(false);
    }
  }

  private rankRows(group: LeaderGroup): PointLeaderRow[] {
    return this.allLeaderRows()
      .filter((row) => row.group === group)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }
}
