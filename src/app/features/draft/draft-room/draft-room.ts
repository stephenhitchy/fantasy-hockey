import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  DraftableAsset,
  DraftPick,
  DraftPickPreview,
  DraftPosition,
  FantasyDraft
} from '../../../core/draft/draft.models';

import {
  activateScheduledDraftIfReady,
  getCurrentDraftPick,
  getDraftPickAtOverall,
  getDraftTotalPickCount,
  getScheduledStartDate,
  isDraftStartTimeReached,
  listenToDraftPicks,
  listenToFantasyDraft,
  makeDraftPick
} from '../../../core/draft/draft.service';

import {
  loadDraftPlayerPool
} from '../../../core/draft/draft-player-pool.service';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  getFantasyTeam,
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

type DraftFilter = 'ALL' | DraftPosition;

type PlayerPoolSort =
  | 'PROJECTED_CYCLE'
  | 'PROJECTED_SEASON'
  | 'NAME'
  | 'POSITION'
  | 'TEAM';

@Component({
  selector: 'app-draft-room',
  imports: [FormsModule, RouterLink],
  templateUrl: './draft-room.html',
  styleUrl: './draft-room.css'
})
export class DraftRoom implements OnDestroy {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  draft = signal<FantasyDraft | null>(null);
  picks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);

  loading = signal(true);
  playerPoolLoading = signal(false);
  makingPickAssetKey = signal<string | null>(null);

  errorMessage = signal('');
  successMessage = signal('');
  playerPoolError = signal('');

  searchTerm = signal('');
  positionFilter = signal<DraftFilter>('ALL');
  sortMode = signal<PlayerPoolSort>('PROJECTED_CYCLE');
  now = signal(Date.now());

  readonly rosterPositions: DraftPosition[] = [
    'LW',
    'C',
    'RW',
    'D',
    'G'
  ];
  setSortMode(value: string): void {
  const validSorts: PlayerPoolSort[] = [
    'PROJECTED_CYCLE',
    'PROJECTED_SEASON',
    'NAME',
    'POSITION',
    'TEAM'
  ];

  if (validSorts.includes(value as PlayerPoolSort)) {
    this.sortMode.set(value as PlayerPoolSort);
  }
}

getMyPicksByPosition(
  position: DraftPosition
): DraftPick[] {
  return this.picks().filter(
    (pick) =>
      pick.ownerId === this.userId &&
      pick.asset.position === position
  );
}

getEmptySlotsForPosition(
  position: DraftPosition
): number[] {
  const openSlotCount = Math.max(
    0,
    this.getPositionRequirement(position) -
      this.getMyPositionCount(position)
  );

  return Array.from(
    { length: openSlotCount },
    (_, index) => index
  );
}

getProjectionDisplay(
  value: number | null | undefined
): string {
  if (typeof value !== 'number') {
    return '—';
  }

  return value.toFixed(1);
}

getAssetProjectedSeason(
  asset: DraftableAsset
): number | null {
  return asset.projectedSeasonPoints ?? null;
}

getAssetProjectedCycle(
  asset: DraftableAsset
): number | null {
  return asset.projectedCyclePoints ?? null;
}

private compareDraftAssets(
  first: DraftableAsset,
  second: DraftableAsset
): number {
  const sortMode = this.sortMode();

  if (sortMode === 'PROJECTED_CYCLE') {
    return this.compareProjectionThenName(
      first,
      second,
      'projectedCyclePoints'
    );
  }

  if (sortMode === 'PROJECTED_SEASON') {
    return this.compareProjectionThenName(
      first,
      second,
      'projectedSeasonPoints'
    );
  }

  if (sortMode === 'POSITION') {
    const positionComparison =
      this.getPositionSortValue(first.position) -
      this.getPositionSortValue(second.position);

    if (positionComparison !== 0) {
      return positionComparison;
    }

    return this.getAssetName(first).localeCompare(
      this.getAssetName(second)
    );
  }

  if (sortMode === 'TEAM') {
    const teamComparison =
      this.getAssetTeamLabel(first).localeCompare(
        this.getAssetTeamLabel(second)
      );

    if (teamComparison !== 0) {
      return teamComparison;
    }

    return this.getAssetName(first).localeCompare(
      this.getAssetName(second)
    );
  }

  return this.getAssetName(first).localeCompare(
    this.getAssetName(second)
  );
}

private compareProjectionThenName(
  first: DraftableAsset,
  second: DraftableAsset,
  projectionKey:
    | 'projectedSeasonPoints'
    | 'projectedCyclePoints'
): number {
  const firstValue = first[projectionKey];
  const secondValue = second[projectionKey];

  const firstHasProjection = typeof firstValue === 'number';
  const secondHasProjection = typeof secondValue === 'number';

  if (firstHasProjection && secondHasProjection) {
    const projectionComparison = secondValue - firstValue;

    if (projectionComparison !== 0) {
      return projectionComparison;
    }
  }

  if (firstHasProjection && !secondHasProjection) {
    return -1;
  }

  if (!firstHasProjection && secondHasProjection) {
    return 1;
  }

  return this.getAssetName(first).localeCompare(
    this.getAssetName(second)
  );
}

private getPositionSortValue(
  position: DraftPosition
): number {
  return this.rosterPositions.indexOf(position);
}

  private stopDraftListener: (() => void) | null = null;
  private stopPickListener: (() => void) | null = null;
  private activationInProgress = false;

  private readonly clockTimer = setInterval(() => {
    this.now.set(Date.now());
    void this.maybeActivateDraft();
  }, 1000);

  readonly currentPick = computed<DraftPickPreview | null>(() =>
    getCurrentDraftPick(this.draft())
  );

  readonly draftStartDate = computed(() =>
    getScheduledStartDate(this.draft())
  );

  readonly startTimeReached = computed(() =>
    isDraftStartTimeReached(
      this.draft(),
      new Date(this.now())
    )
  );

  readonly isMyTurn = computed(() =>
    this.currentPick()?.ownerId === this.userId
  );

  readonly totalPickCount = computed(() =>
    getDraftTotalPickCount(this.draft())
  );

  readonly draftProgressText = computed(() => {
    const draft = this.draft();

    if (!draft) {
      return '0 / 0 Picks';
    }

    const completed = Math.max(
      0,
      draft.nextOverallPick - 1
    );

    return `${completed} / ${this.totalPickCount()} Picks`;
  });

  readonly availableAssetCount = computed(() => {
    const draftedAssetKeys = new Set(
      this.draft()?.draftedAssetKeys ?? []
    );

    return this.playerPool().filter(
      (asset) => !draftedAssetKeys.has(asset.assetKey)
    ).length;
  });

readonly availableAssets = computed(() => {
  const draftedAssetKeys = new Set(
    this.draft()?.draftedAssetKeys ?? []
  );

  const search = this.searchTerm()
    .trim()
    .toLowerCase();

  const positionFilter = this.positionFilter();

  return this.playerPool()
    .filter(
      (asset) => !draftedAssetKeys.has(asset.assetKey)
    )
    .filter((asset) =>
      positionFilter === 'ALL'
        ? true
        : asset.position === positionFilter
    )
    .filter((asset) => {
      if (!search) {
        return true;
      }

      return this.getAssetName(asset)
        .toLowerCase()
        .includes(search);
    })
    .sort((first, second) =>
      this.compareDraftAssets(first, second)
    )
    .slice(0, 120);
});

  readonly recentPicks = computed(() =>
    [...this.picks()]
      .slice(-10)
      .reverse()
  );

  readonly upcomingPicks = computed(() => {
    const draft = this.draft();

    if (!draft) {
      return [];
    }

    return Array.from({ length: 8 }, (_, index) =>
      getDraftPickAtOverall(
        draft,
        draft.nextOverallPick + index
      )
    ).filter(
      (pick): pick is DraftPickPreview => pick !== null
    );
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadDraftRoom();
  }

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
    this.stopDraftListener?.();
    this.stopPickListener?.();
  }

  async loadDraftRoom(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;

    try {
      const [league, teams, myTeam] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
        getFantasyTeam(leagueId, user.uid)
      ]);

      if (!league || !myTeam) {
        await this.router.navigate(['/dashboard']);
        return;
      }

      this.league.set(league);
      this.teams.set(teams);

      this.stopDraftListener = listenToFantasyDraft(
        leagueId,
        (draft) => {
          this.draft.set(draft);
          void this.maybeActivateDraft();
        }
      );

      this.stopPickListener = listenToDraftPicks(
        leagueId,
        (picks) => {
          this.picks.set(picks);
        }
      );

      await this.loadPlayerPool();
      await this.maybeActivateDraft();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load the draft room.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  async loadPlayerPool(): Promise<void> {
    this.playerPoolLoading.set(true);
    this.playerPoolError.set('');

    try {
      this.playerPool.set(
        await loadDraftPlayerPool()
      );
    } catch (error: unknown) {
      this.playerPoolError.set(
        error instanceof Error
          ? error.message
          : 'Unable to load the NHL player pool.'
      );
    } finally {
      this.playerPoolLoading.set(false);
    }
  }

  async maybeActivateDraft(): Promise<void> {
    const draft = this.draft();

    if (
      !draft ||
      draft.status !== 'scheduled' ||
      !isDraftStartTimeReached(draft) ||
      this.activationInProgress
    ) {
      return;
    }

    this.activationInProgress = true;

    try {
      await activateScheduledDraftIfReady(
        this.leagueId
      );
    } catch {
      // The real-time listener will still update when another user activates it.
    } finally {
      this.activationInProgress = false;
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  setPositionFilter(value: string): void {
    const validFilters: DraftFilter[] = [
      'ALL',
      'LW',
      'C',
      'RW',
      'D',
      'G'
    ];

    if (validFilters.includes(value as DraftFilter)) {
      this.positionFilter.set(value as DraftFilter);
    }
  }

  getTeamName(ownerId: string): string {
    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
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

  getPositionRequirement(
    position: DraftPosition
  ): number {
    return this.draft()?.rosterRequirements[position] ?? 0;
  }

  getPositionCount(
    ownerId: string,
    position: DraftPosition
  ): number {
    return this.picks().filter(
      (pick) =>
        pick.ownerId === ownerId &&
        pick.asset.position === position
    ).length;
  }

  getMyPositionCount(
    position: DraftPosition
  ): number {
    return this.getPositionCount(
      this.userId,
      position
    );
  }

  canDraftAsset(asset: DraftableAsset): boolean {
    const draft = this.draft();

    if (
      !draft ||
      draft.status !== 'live' ||
      !this.isMyTurn()
    ) {
      return false;
    }

    return (
      this.getMyPositionCount(asset.position) <
      this.getPositionRequirement(asset.position)
    );
  }

  getDraftButtonLabel(
    asset: DraftableAsset
  ): string {
    if (this.makingPickAssetKey() === asset.assetKey) {
      return 'Drafting...';
    }

    if (!this.isMyTurn()) {
      return 'Waiting';
    }

    if (
      this.getMyPositionCount(asset.position) >=
      this.getPositionRequirement(asset.position)
    ) {
      return 'Position Full';
    }

    return 'Draft';
  }

  async selectAsset(
    asset: DraftableAsset
  ): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    if (!this.canDraftAsset(asset)) {
      return;
    }

    this.makingPickAssetKey.set(asset.assetKey);

    try {
      const pick = await makeDraftPick(
        this.leagueId,
        this.userId,
        asset
      );

      this.successMessage.set(
        `${this.getAssetName(pick.asset)} was drafted at pick #${pick.overallPick}.`
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to make this draft pick.'
      );
    } finally {
      this.makingPickAssetKey.set(null);
    }
  }

  formatDraftStart(): string {
    const startDate = this.draftStartDate();

    if (!startDate) {
      return 'Not scheduled';
    }

    return startDate.toLocaleString(undefined, {
      dateStyle: 'full',
      timeStyle: 'short'
    });
  }

  getCountdownText(): string {
    const startDate = this.draftStartDate();

    if (!startDate) {
      return 'Waiting for a scheduled start time.';
    }

    const millisecondsRemaining =
      startDate.getTime() - this.now();

    if (millisecondsRemaining <= 0) {
      return 'Opening the draft...';
    }

    const totalSeconds = Math.floor(
      millisecondsRemaining / 1000
    );

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(
      (totalSeconds % 86400) / 3600
    );
    const minutes = Math.floor(
      (totalSeconds % 3600) / 60
    );
    const seconds = totalSeconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m remaining`;
    }

    return `${hours}h ${minutes}m ${seconds}s remaining`;
  }
}