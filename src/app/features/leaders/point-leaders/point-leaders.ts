import { Component, computed, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  getCycleTeamWindows,
  listenToCycleTeamWindows,
} from '../../../core/cycle/asset-cycle-window.service';
import {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyTeamCycleWindows,
} from '../../../core/cycle/cycle.models';
import { getLeagueCycles } from '../../../core/cycle/cycle.service';
import { DraftableAsset } from '../../../core/draft/draft.models';
import { getLeagueById, League } from '../../../core/league/league.service';
import {
  buildLeaguePlayerOwnership,
  LeaguePlayerOwnership,
} from '../../../core/player/league-player-board.util';
import {
  isSupportedProjectionSnapshotHashSchemaVersion,
  loadSharedProjectionSnapshot,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  SHARED_PROJECTION_VERSION,
  SharedProjectionSnapshotMetadata,
} from '../../../core/projection/projection-snapshot.service';
import { DRAFT_RANKING_MODEL_VERSION } from '../../../core/projection/projection-ranking.util';
import { FantasyRoster } from '../../../core/team/roster.models';
import { getFantasyRosterOnce } from '../../../core/team/roster.service';
import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';
import { AssetPortrait } from '../../../shared/asset-portrait/asset-portrait';
import { LeagueQuickNavigation } from '../../../shared/league-quick-navigation/league-quick-navigation';
import {
  areLeaderCycleTeamWindowsComplete,
  buildProjectedLeaderRows,
  buildScoringLeaderRows,
  filterAndRankLeaderRows,
  getVerifiedProjectionLeaderAssets,
  mergeLeaderWindows,
  PointLeaderPositionFilter,
  PointLeaderRow,
  PointLeaderScope,
  resolveLeaderCycleCompletion,
  selectInitialLeaderCycleNumber,
} from './point-leaders.util';

const LEADER_PAGE_SIZE = 50;

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

function flattenTeamWindows(
  teamWindows: readonly FantasyTeamCycleWindows[],
): FantasyAssetCycleWindow[] {
  return teamWindows.flatMap((entry) => entry.windows);
}

@Component({
  selector: 'app-point-leaders',
  imports: [RouterLink, AssetPortrait, LeagueQuickNavigation],
  templateUrl: './point-leaders.html',
  styleUrl: './point-leaders.css',
})
export class PointLeaders implements OnDestroy {
  leagueId = '';

  readonly league = signal<League | null>(null);
  readonly teams = signal<FantasyTeam[]>([]);
  readonly cycles = signal<FantasyCycle[]>([]);
  readonly selectedCurrentCycleNumber = signal<number | null>(null);
  readonly currentWindows = signal<FantasyAssetCycleWindow[]>([]);
  readonly historicalWindowsByCycle = signal<
    Readonly<Record<number, FantasyAssetCycleWindow[]>>
  >({});
  readonly projectionAssets = signal<DraftableAsset[]>([]);
  readonly projectionMetadata = signal<SharedProjectionSnapshotMetadata | null>(null);
  readonly projectionOwnership = signal<ReadonlyMap<string, LeaguePlayerOwnership>>(new Map());

  readonly loading = signal(true);
  readonly projectionLoading = signal(false);
  readonly errorMessage = signal('');
  readonly projectionError = signal('');
  readonly selectedScope = signal<PointLeaderScope>('current');
  readonly selectedPosition = signal<PointLeaderPositionFilter>('ALL');
  readonly visibleLimit = signal(LEADER_PAGE_SIZE);

  private stopCurrentWindowListener: (() => void) | null = null;
  private destroyed = false;
  private loadGeneration = 0;
  private projectionLoadGeneration = 0;
  private currentWindowListenerGeneration = 0;
  private transitioningCycleNumber: number | null = null;

  readonly sortedCycles = computed(() =>
    [...this.cycles()].sort((first, second) => first.cycleNumber - second.cycleNumber),
  );

  readonly currentCycle = computed(() => {
    const selectedCycleNumber = this.selectedCurrentCycleNumber();
    return selectedCycleNumber === null
      ? null
      : this.sortedCycles().find(
          (cycle) => cycle.cycleNumber === selectedCycleNumber,
        ) ?? null;
  });

  readonly currentLeaderRows = computed(() =>
    buildScoringLeaderRows(this.currentWindows(), { completedOnly: false }),
  );

  readonly seasonLeaderRows = computed(() =>
    buildScoringLeaderRows(
      mergeLeaderWindows(
        ...Object.values(this.historicalWindowsByCycle()),
        this.currentWindows(),
      ),
      { completedOnly: true },
    ),
  );

  readonly projectedLeaderRows = computed(() =>
    buildProjectedLeaderRows(this.projectionAssets(), this.projectionOwnership()),
  );

  readonly selectedRows = computed(() => {
    switch (this.selectedScope()) {
      case 'season':
        return this.seasonLeaderRows();
      case 'projected':
        return this.projectedLeaderRows();
      default:
        return this.currentLeaderRows();
    }
  });

  readonly rankedRows = computed(() =>
    filterAndRankLeaderRows(this.selectedRows(), this.selectedPosition()),
  );

  readonly visibleRows = computed(() => this.rankedRows().slice(0, this.visibleLimit()));
  readonly hiddenRowCount = computed(() =>
    Math.max(0, this.rankedRows().length - this.visibleRows().length),
  );
  readonly featuredRows = computed(() =>
    this.rankedRows().filter((row) => row.rank !== null).slice(0, 3),
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    void this.initializePage();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.loadGeneration += 1;
    this.projectionLoadGeneration += 1;
    this.currentWindowListenerGeneration += 1;
    this.stopCurrentWindowListener?.();
    this.stopCurrentWindowListener = null;
  }

  async initializePage(): Promise<void> {
    const generation = ++this.loadGeneration;
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.stopCurrentWindowListener?.();
    this.stopCurrentWindowListener = null;
    this.currentWindowListenerGeneration += 1;
    this.transitioningCycleNumber = null;
    this.leagueId = leagueId;
    this.loading.set(true);
    this.errorMessage.set('');

    try {
      const [league, teams, cycles] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
        getLeagueCycles(leagueId),
      ]);

      if (generation !== this.loadGeneration || this.destroyed) {
        return;
      }

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);
      this.cycles.set(cycles);
      const currentCycleNumber = selectInitialLeaderCycleNumber(cycles);
      this.selectedCurrentCycleNumber.set(currentCycleNumber);

      const sortedCycles = [...cycles].sort(
        (first, second) => first.cycleNumber - second.cycleNumber,
      );
      const historicalCycles = sortedCycles.filter(
        (cycle) => cycle.cycleNumber !== currentCycleNumber,
      );
      const historicalTeamWindows = await Promise.all(
        historicalCycles.map(async (cycle) => [
          cycle.cycleNumber,
          flattenTeamWindows(await getCycleTeamWindows(leagueId, cycle.cycleNumber)),
        ] as const),
      );

      if (generation !== this.loadGeneration || this.destroyed) {
        return;
      }

      this.historicalWindowsByCycle.set(Object.fromEntries(historicalTeamWindows));

      if (currentCycleNumber !== null) {
        await this.startCurrentWindowListener(currentCycleNumber, generation);
      } else {
        this.currentWindows.set([]);
      }
    } catch (error: unknown) {
      if (generation === this.loadGeneration && !this.destroyed) {
        this.errorMessage.set(
          error instanceof Error ? error.message : 'Unable to load league leaders.',
        );
      }
    } finally {
      if (generation === this.loadGeneration && !this.destroyed) {
        this.loading.set(false);
      }
    }
  }

  setScope(scope: PointLeaderScope): void {
    this.selectedScope.set(scope);
    this.visibleLimit.set(LEADER_PAGE_SIZE);

    if (scope === 'projected' && this.projectionAssets().length === 0) {
      void this.loadProjectionLeaders();
    }
  }

  setPosition(position: PointLeaderPositionFilter): void {
    this.selectedPosition.set(position);
    this.visibleLimit.set(LEADER_PAGE_SIZE);
  }

  showMore(): void {
    this.visibleLimit.update((value) => value + LEADER_PAGE_SIZE);
  }

  retryPage(): void {
    void this.initializePage();
  }

  retryProjection(): void {
    void this.loadProjectionLeaders();
  }

  getScopeTitle(): string {
    switch (this.selectedScope()) {
      case 'season':
        return 'Season leaders';
      case 'projected':
        return 'Expected next-six leaders';
      default:
        return this.currentCycle()
          ? `Matchup ${this.currentCycle()?.cycleNumber} leaders`
          : 'Current matchup leaders';
    }
  }

  getScopeDescription(): string {
    switch (this.selectedScope()) {
      case 'season':
        return 'Completed immutable six-game windows only. Live partial windows are not included.';
      case 'projected':
        return 'Availability-adjusted Projection V11 estimates for each player’s next six NHL team games.';
      default:
        return 'Live and provisional points from the current fantasy matchup. Totals can change until windows settle.';
    }
  }

  getPositionLabel(position: PointLeaderPositionFilter): string {
    switch (position) {
      case 'ALL':
        return 'All';
      case 'G':
        return 'Goalie Units';
      default:
        return position;
    }
  }

  getPositionCount(position: PointLeaderPositionFilter): number {
    return position === 'ALL'
      ? this.selectedRows().length
      : this.selectedRows().filter((row) => row.position === position).length;
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

  getValueLabel(value: number | null): string {
    return value === null ? '—' : value.toFixed(1);
  }

  getPointsPerGameLabel(row: PointLeaderRow): string {
    return row.pointsPerGame === null ? '—' : row.pointsPerGame.toFixed(2);
  }

  getGamesLabel(row: PointLeaderRow): string {
    if (row.gamesPlayed === null) {
      return '—';
    }

    if (row.asset.assetType === 'team-goalie-unit' || row.appearances === row.gamesPlayed) {
      return `${row.gamesPlayed}`;
    }

    return row.appearances === null ? `${row.gamesPlayed}` : `${row.appearances}/${row.gamesPlayed}`;
  }

  getFantasyTeamName(ownerId: string): string {
    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Previous roster';
  }

  getProjectionOwnershipLabel(row: PointLeaderRow): string {
    return row.currentOwnership
      ? `Rostered by ${row.currentOwnership.teamName}`
      : 'Free agent';
  }

  getProjectionRangeLabel(row: PointLeaderRow): string {
    if (row.projectionFloor === null || row.projectionCeiling === null) {
      return 'Range unavailable';
    }

    return `${row.projectionFloor.toFixed(1)}–${row.projectionCeiling.toFixed(1)} pts`;
  }

  getProjectionAvailabilityLabel(row: PointLeaderRow): string {
    const availability = row.availabilityLabel ?? 'Availability not reported';
    const games = row.expectedGamesAvailable === null
      ? 'expected games unavailable'
      : `${row.expectedGamesAvailable.toFixed(1)} expected games`;
    return `${availability} · ${games}`;
  }

  getProjectionAsOfLabel(): string {
    const metadata = this.projectionMetadata();

    if (!metadata) {
      return '';
    }

    const asOf = metadata.projectionAsOfDate || metadata.generatedAt;
    const parsed = new Date(asOf);
    return Number.isNaN(parsed.getTime())
      ? 'Verified Projection V11 snapshot'
      : `Verified Projection V11 · ${parsed.toLocaleDateString()}`;
  }

  private async startCurrentWindowListener(
    cycleNumber: number,
    generation: number,
  ): Promise<void> {
    const listenerGeneration = ++this.currentWindowListenerGeneration;

    await new Promise<void>((resolve, reject) => {
      let receivedFirstSnapshot = false;

      this.stopCurrentWindowListener = listenToCycleTeamWindows(
        this.leagueId,
        cycleNumber,
        (teamWindows) => {
          if (
            generation !== this.loadGeneration ||
            listenerGeneration !== this.currentWindowListenerGeneration ||
            this.selectedCurrentCycleNumber() !== cycleNumber ||
            this.destroyed
          ) {
            return;
          }

          const windows = flattenTeamWindows(teamWindows);
          this.currentWindows.set(windows);

          if (!receivedFirstSnapshot) {
            receivedFirstSnapshot = true;
            resolve();
          }

          if (areLeaderCycleTeamWindowsComplete(
            teamWindows,
            this.teams().map((team) => team.ownerId),
          )) {
            void this.advanceCompletedCurrentCycle(
              cycleNumber,
              windows,
              generation,
              listenerGeneration,
            );
          }
        },
        (error) => {
          if (
            generation !== this.loadGeneration ||
            listenerGeneration !== this.currentWindowListenerGeneration ||
            this.destroyed
          ) {
            return;
          }

          if (!receivedFirstSnapshot) {
            receivedFirstSnapshot = true;
            reject(error);
            return;
          }

          this.errorMessage.set('Live matchup leaders stopped updating. Reload to reconnect.');
        },
      );
    });
  }

  private async advanceCompletedCurrentCycle(
    cycleNumber: number,
    completedWindows: FantasyAssetCycleWindow[],
    generation: number,
    listenerGeneration: number,
  ): Promise<void> {
    if (
      this.transitioningCycleNumber !== null ||
      generation !== this.loadGeneration ||
      listenerGeneration !== this.currentWindowListenerGeneration ||
      this.selectedCurrentCycleNumber() !== cycleNumber ||
      this.destroyed
    ) {
      return;
    }

    this.transitioningCycleNumber = cycleNumber;

    try {
      this.historicalWindowsByCycle.update((current) => ({
        ...current,
        [cycleNumber]: mergeLeaderWindows(current[cycleNumber] ?? [], completedWindows),
      }));

      let transition = resolveLeaderCycleCompletion(
        this.cycles(),
        this.selectedCurrentCycleNumber(),
        cycleNumber,
      );

      if (!transition.shouldSwapListener) {
        return;
      }

      if (transition.nextCycleNumber === null) {
        const refreshedCycles = await getLeagueCycles(this.leagueId);

        if (generation !== this.loadGeneration || this.destroyed) {
          return;
        }

        transition = resolveLeaderCycleCompletion(
          refreshedCycles,
          cycleNumber,
          cycleNumber,
        );
        await this.loadMissingHistoricalCycles(
          transition.cycles,
          transition.nextCycleNumber,
          generation,
        );
      }

      if (
        generation !== this.loadGeneration ||
        listenerGeneration !== this.currentWindowListenerGeneration ||
        this.destroyed
      ) {
        return;
      }

      // A newer all-complete snapshot may have arrived while the bounded
      // successor/history reads were in flight. Capture the signal again in
      // the same synchronous teardown turn so that newest snapshot wins.
      const latestCompletedWindows = this.currentWindows();
      this.historicalWindowsByCycle.update((current) => ({
        ...current,
        [cycleNumber]: mergeLeaderWindows(
          current[cycleNumber] ?? [],
          completedWindows,
          latestCompletedWindows,
        ),
      }));

      this.cycles.set(transition.cycles);
      this.stopCurrentWindowListener?.();
      this.stopCurrentWindowListener = null;
      this.currentWindowListenerGeneration += 1;
      this.currentWindows.set([]);
      this.selectedCurrentCycleNumber.set(transition.nextCycleNumber);

      if (transition.nextCycleNumber !== null) {
        void this.startCurrentWindowListener(transition.nextCycleNumber, generation).catch(
          (error: unknown) => {
            if (generation === this.loadGeneration && !this.destroyed) {
              this.errorMessage.set(
                error instanceof Error
                  ? error.message
                  : 'Unable to listen for the next live matchup leaders.',
              );
            }
          },
        );
      }
    } catch (error: unknown) {
      if (generation === this.loadGeneration && !this.destroyed) {
        this.errorMessage.set(
          error instanceof Error
            ? error.message
            : 'Unable to advance live league leaders to the next matchup.',
        );
      }
    } finally {
      if (this.transitioningCycleNumber === cycleNumber) {
        this.transitioningCycleNumber = null;
      }
    }
  }

  private async loadMissingHistoricalCycles(
    cycles: readonly FantasyCycle[],
    selectedCycleNumber: number | null,
    generation: number,
  ): Promise<void> {
    const loadedByCycle = this.historicalWindowsByCycle();
    const missingCycles = cycles.filter(
      (cycle) =>
        cycle.cycleNumber !== selectedCycleNumber &&
        !Object.prototype.hasOwnProperty.call(loadedByCycle, cycle.cycleNumber),
    );

    if (missingCycles.length === 0) {
      return;
    }

    const entries = await Promise.all(
      missingCycles.map(async (cycle) => [
        cycle.cycleNumber,
        flattenTeamWindows(await getCycleTeamWindows(this.leagueId, cycle.cycleNumber)),
      ] as const),
    );

    if (generation !== this.loadGeneration || this.destroyed) {
      return;
    }

    this.historicalWindowsByCycle.update((current) => ({
      ...current,
      ...Object.fromEntries(entries),
    }));
  }

  private async loadProjectionLeaders(): Promise<void> {
    if (this.projectionLoading()) {
      return;
    }

    const generation = ++this.projectionLoadGeneration;
    this.projectionLoading.set(true);
    this.projectionError.set('');

    try {
      const league = this.league();

      if (!league) {
        throw new Error('League information is not ready yet.');
      }

      const snapshot = await loadSharedProjectionSnapshot(this.leagueId);
      const verifiedAssets = getVerifiedProjectionLeaderAssets(snapshot, {
        expectedProjectionVersion: SHARED_PROJECTION_VERSION,
        expectedDraftRankingVersion: DRAFT_RANKING_MODEL_VERSION,
        expectedScoringRulesVersion: league.scoringRulesVersion ?? 0,
        expectedAuthoritySchemaVersion: PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
        hashSchemaSupported: isSupportedProjectionSnapshotHashSchemaVersion(
          snapshot?.metadata.snapshotHashSchemaVersion,
        ),
      });

      if (!snapshot || !verifiedAssets) {
        throw new Error(
          'A complete, verified Projection V11 snapshot is not available for this league yet.',
        );
      }

      const rosterEntries = await Promise.all(
        this.teams().map(async (team) => [
          team.ownerId,
          await getFantasyRosterOnce(this.leagueId, team.ownerId),
        ] as const),
      );

      if (generation !== this.projectionLoadGeneration || this.destroyed) {
        return;
      }

      const rosters = new Map<string, FantasyRoster | null>(rosterEntries);
      this.projectionOwnership.set(buildLeaguePlayerOwnership(this.teams(), rosters));
      this.projectionAssets.set(verifiedAssets);
      this.projectionMetadata.set(snapshot.metadata);
    } catch (error: unknown) {
      if (generation === this.projectionLoadGeneration && !this.destroyed) {
        this.projectionAssets.set([]);
        this.projectionMetadata.set(null);
        this.projectionError.set(
          error instanceof Error ? error.message : 'Unable to load Projection V11 leaders.',
        );
      }
    } finally {
      if (generation === this.projectionLoadGeneration && !this.destroyed) {
        this.projectionLoading.set(false);
      }
    }
  }
}
