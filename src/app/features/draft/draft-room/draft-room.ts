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
  DraftQueue,
  FantasyDraft
} from '../../../core/draft/draft.models';

import {
  activateScheduledDraftIfReady,
  getCurrentDraftPick,
  getDraftClockRemainingSeconds,
  getDraftPickAtOverall,
  getDraftTotalPickCount,
  getScheduledStartDate,
  isDraftClockExpired,
  isDraftStartTimeReached,
  listenToDraftPicks,
  listenToDraftQueue,
  listenToDraftQueues,
  listenToFantasyDraft,
  makeAutomaticDraftPick,
  makeDraftPick,
  pauseDraftClock,
  resumeDraftClock,
  saveDraftQueue,
  setDraftAutoDraftEnabled
} from '../../../core/draft/draft.service';

import {
  loadDraftPlayerPool
} from '../../../core/draft/draft-player-pool.service';

import {
  DraftPlayerNewsOverride,
  getDraftNewsOverrideForAsset,
  getDraftNewsTeamLogoUrl
} from '../../../core/draft/draft-news-overrides';

import {
  PlayerAvailability,
  PlayerAvailabilitySyncState
} from '../../../core/player/player-availability.models';

import {
  getPlayerAvailabilityForPlayer,
  getPlayerAvailabilityStatusClass,
  shouldDisplayPlayerAvailability,
  startPlayerAvailabilityListenerForLeague
} from '../../../core/player/player-availability.service';

import {
  listenToPlayerAvailabilitySyncState,
  syncPlayerAvailabilityFromEspn
} from '../../../core/player/player-availability-sync.service';

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
  | 'DRAFT_VALUE'
  | 'RELIABILITY'
  | 'RATING'
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
  injurySyncState = signal<PlayerAvailabilitySyncState | null>(null);
  draftQueues = signal<DraftQueue[]>([]);

  loading = signal(true);
  playerPoolLoading = signal(false);
  makingPickAssetKey = signal<string | null>(null);
  isCommissioner = signal(false);
  draftInjurySyncInProgress = signal(false);
  queueSaving = signal(false);
  autoPickInProgress = signal(false);
  clockActionInProgress = signal(false);

  errorMessage = signal('');
  successMessage = signal('');
  playerPoolError = signal('');
  draftInjurySyncMessage = signal('');
  draftInjurySyncWarning = signal('');
  autoPickMessage = signal('');

  searchTerm = signal('');
  positionFilter = signal<DraftFilter>('ALL');
  sortMode = signal<PlayerPoolSort>('DRAFT_VALUE');
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
    'DRAFT_VALUE',
    'RELIABILITY',
    'RATING',
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

private compareDraftValueThenProjection(
  first: DraftableAsset,
  second: DraftableAsset
): number {
  const firstValue = this.getAssetDraftValue(first);
  const secondValue = this.getAssetDraftValue(second);

  const firstHasValue = typeof firstValue === 'number';
  const secondHasValue = typeof secondValue === 'number';

  if (firstHasValue && secondHasValue) {
    const valueComparison = secondValue - firstValue;

    if (valueComparison !== 0) {
      return valueComparison;
    }
  }

  if (firstHasValue && !secondHasValue) {
    return -1;
  }

  if (!firstHasValue && secondHasValue) {
    return 1;
  }

  const firstProjectedCycle =
    this.getAssetProjectedCycle(first) ?? -1;

  const secondProjectedCycle =
    this.getAssetProjectedCycle(second) ?? -1;

  if (secondProjectedCycle !== firstProjectedCycle) {
    return secondProjectedCycle - firstProjectedCycle;
  }

  return this.getAssetName(first).localeCompare(
    this.getAssetName(second)
  );
}

getAssetValueRank(asset: DraftableAsset): number | null {
  return this.assetValueRankByKey()[asset.assetKey] ?? null;
}

getAssetValueRankDisplay(asset: DraftableAsset): string {
  const rank = this.getAssetValueRank(asset);

  return typeof rank === 'number'
    ? `#${rank}`
    : '—';
}

getAssetRating(asset: DraftableAsset): number | null {
  const projectedCycle =
    this.getAssetProjectedCycle(asset);

  if (typeof projectedCycle !== 'number') {
    return null;
  }

  const denominator =
    asset.position === 'G'
      ? this.topGoalieCycleProjection()
      : this.topSkaterCycleProjection();

  return Math.round(
    projectedCycle / denominator * 100
  );
}

getAssetRatingDisplay(asset: DraftableAsset): string {
  const rating = this.getAssetRating(asset);

  return typeof rating === 'number'
    ? rating.toString()
    : '—';
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

getAssetProjectedCycle(
  asset: DraftableAsset
): number | null {
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

getAssetFloorAdjustedCycle(
  asset: DraftableAsset
): number | null {
  const poolAsset = this.playerPool().find(
    (availableAsset) =>
      availableAsset.assetKey === asset.assetKey
  );

  return (
    asset.floorAdjustedCyclePoints ??
    poolAsset?.floorAdjustedCyclePoints ??
    this.getAssetProjectedCycle(asset)
  );
}

getAssetReliabilityRating(asset: DraftableAsset): number | null {
  const poolAsset = this.playerPool().find(
    (availableAsset) =>
      availableAsset.assetKey === asset.assetKey
  );

  return (
    asset.reliabilityRating ??
    poolAsset?.reliabilityRating ??
    null
  );
}

getAssetReliabilityDisplay(asset: DraftableAsset): string {
  const rating = this.getAssetReliabilityRating(asset);

  return typeof rating === 'number'
    ? Math.round(rating).toString()
    : '—';
}

getAssetRiskLabel(asset: DraftableAsset): string {
  const rating = this.getAssetReliabilityRating(asset);

  if (typeof rating !== 'number') {
    return 'Risk: —';
  }

  if (rating >= 85) {
    return 'Risk: Very Safe';
  }

  if (rating >= 75) {
    return 'Risk: Safe';
  }

  if (rating >= 65) {
    return 'Risk: Normal';
  }

  if (rating >= 55) {
    return 'Risk: Volatile';
  }

  return 'Risk: Risky';
}

getAssetDraftValue(
  asset: DraftableAsset
): number | null {
  const projectedCycle =
    this.getAssetFloorAdjustedCycle(asset);

  const replacementCycle =
    this.replacementCycleValueByPosition()[asset.position];

  if (
    typeof projectedCycle !== 'number' ||
    typeof replacementCycle !== 'number'
  ) {
    return null;
  }

  return Number(
    (projectedCycle - replacementCycle).toFixed(1)
  );
}

private compareDraftAssets(
  first: DraftableAsset,
  second: DraftableAsset
): number {
const sortMode = this.sortMode();

if (sortMode === 'DRAFT_VALUE') {
  return this.compareDraftValueThenProjection(
    first,
    second
  );
}

if (sortMode === 'RELIABILITY') {
  const firstReliability =
    this.getAssetReliabilityRating(first) ?? -1;

  const secondReliability =
    this.getAssetReliabilityRating(second) ?? -1;

  if (secondReliability !== firstReliability) {
    return secondReliability - firstReliability;
  }

  return this.compareDraftValueThenProjection(
    first,
    second
  );
}

if (sortMode === 'RATING') {
  const firstRating = this.getAssetRating(first) ?? -1;
  const secondRating = this.getAssetRating(second) ?? -1;

  if (secondRating !== firstRating) {
    return secondRating - firstRating;
  }

  return this.getAssetName(first).localeCompare(
    this.getAssetName(second)
  );
}

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
  private stopInjurySyncListener: (() => void) | null = null;
  private stopQueueListener: (() => void) | null = null;
  private activationInProgress = false;
  private lastAutoPickAttemptKey = '';

  private readonly clockTimer = setInterval(() => {
    this.now.set(Date.now());
    void this.maybeActivateDraft();
    void this.maybeHandleAutomaticPick();
  }, 1000);

  readonly currentPick = computed<DraftPickPreview | null>(() =>
    getCurrentDraftPick(this.draft())
  );


  readonly myQueue = computed<DraftQueue>(() =>
    this.getQueueForOwner(this.userId)
  );

  readonly queueAssets = computed(() => {
    const draftedAssetKeys = new Set(
      this.draft()?.draftedAssetKeys ?? []
    );

    const assetsByKey = new Map(
      this.playerPool().map((asset) => [
        asset.assetKey,
        asset
      ])
    );

    return this.myQueue().assetKeys
      .map((assetKey) => assetsByKey.get(assetKey))
      .filter(
        (asset): asset is DraftableAsset =>
          asset !== undefined &&
          !draftedAssetKeys.has(asset.assetKey)
      );
  });

  readonly draftClockRemainingSeconds = computed(() =>
    getDraftClockRemainingSeconds(
      this.draft(),
      new Date(this.now())
    )
  );

  readonly draftClockDisplay = computed(() => {
    const totalSeconds = this.draftClockRemainingSeconds();
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });

  readonly draftClockIsUrgent = computed(() =>
    this.draft()?.clockStatus === 'running' &&
    this.draftClockRemainingSeconds() <= 10
  );

  readonly currentOwnerAutoDraftEnabled = computed(() => {
    const ownerId = this.currentPick()?.ownerId;

    return ownerId
      ? this.getQueueForOwner(ownerId).autoDraftEnabled
      : false;
  });

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

  readonly replacementCycleValueByPosition = computed(() => {
  const draft = this.draft();

  const replacementValues: Record<DraftPosition, number | null> = {
    LW: null,
    C: null,
    RW: null,
    D: null,
    G: null
  };

  if (!draft) {
    return replacementValues;
  }

  const teamCount = Math.max(
    this.teams().length,
    draft.roundOneOrder.length,
    1
  );

  for (const position of this.rosterPositions) {
    const requiredSlotsAtPosition =
      draft.rosterRequirements[position] ?? 0;

    const replacementRank = Math.max(
      1,
      teamCount * requiredSlotsAtPosition
    );

    const projectedCycles = this.playerPool()
      .filter((asset) => asset.position === position)
      .map((asset) =>
        asset.floorAdjustedCyclePoints ??
        asset.projectedCyclePoints
      )
      .filter(
        (value): value is number =>
          typeof value === 'number'
      )
      .sort((first, second) => second - first);

    replacementValues[position] =
      projectedCycles[
        Math.min(
          replacementRank - 1,
          projectedCycles.length - 1
        )
      ] ?? null;
  }

  return replacementValues;
});

readonly topSkaterCycleProjection = computed(() => {
  const topProjection = Math.max(
    1,
    ...this.playerPool()
      .filter((asset) => asset.position !== 'G')
      .map((asset) => asset.projectedCyclePoints ?? 0)
  );

  return topProjection;
});

readonly topGoalieCycleProjection = computed(() => {
  const topProjection = Math.max(
    1,
    ...this.playerPool()
      .filter((asset) => asset.position === 'G')
      .map((asset) => asset.projectedCyclePoints ?? 0)
  );

  return topProjection;
});

readonly assetValueRankByKey = computed(() => {
  const ranks: Record<string, number> = {};

  [...this.playerPool()]
    .sort((first, second) =>
      this.compareDraftValueThenProjection(first, second)
    )
    .forEach((asset, index) => {
      ranks[asset.assetKey] = index + 1;
    });

  return ranks;
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
    this.stopInjurySyncListener?.();
    this.stopQueueListener?.();
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
      this.isCommissioner.set(
        league.commissionerId === user.uid
      );
      startPlayerAvailabilityListenerForLeague(leagueId);


      this.stopQueueListener?.();

      if (league.commissionerId === user.uid) {
        this.stopQueueListener = listenToDraftQueues(
          leagueId,
          (queues) => {
            this.draftQueues.set(queues);
          }
        );
      } else {
        this.stopQueueListener = listenToDraftQueue(
          leagueId,
          user.uid,
          (queue) => {
            this.draftQueues.set([queue]);
          }
        );
      }

      this.stopInjurySyncListener?.();
      this.stopInjurySyncListener =
        listenToPlayerAvailabilitySyncState(
          leagueId,
          (state) => {
            this.injurySyncState.set(state);
          }
        );

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

  getDraftInjurySyncStatusLabel(): string {
    if (
      this.draftInjurySyncInProgress() ||
      this.injurySyncState()?.status === 'running'
    ) {
      return 'Updating Injury Report';
    }

    if (this.injurySyncState()?.status === 'success') {
      return 'Injury Report Ready';
    }

    if (this.injurySyncState()?.status === 'error') {
      return 'Using Last Saved Report';
    }

    return 'Waiting for Injury Report';
  }

  getDraftInjurySyncDescription(): string {
    if (
      this.draftInjurySyncInProgress() ||
      this.injurySyncState()?.status === 'running'
    ) {
      return 'The commissioner is pulling the latest ESPN injury report. The draft will open when this attempt finishes.';
    }

    if (this.draftInjurySyncWarning()) {
      return this.draftInjurySyncWarning();
    }

    if (this.draftInjurySyncMessage()) {
      return this.draftInjurySyncMessage();
    }

    const state = this.injurySyncState();

    if (state?.status === 'success') {
      return state.message || 'The shared ESPN injury report is ready for every team.';
    }

    if (state?.status === 'error') {
      return state.message || 'The most recent saved report will remain available.';
    }

    return this.isCommissioner()
      ? 'The latest ESPN injury report will be pulled when the scheduled start time arrives.'
      : 'Waiting for the commissioner to refresh the shared injury report and open the draft.';
  }

  getDraftInjurySyncTimeLabel(): string {
    const value = this.injurySyncState()?.lastSuccessfulSyncAt;

    if (!value) {
      return 'No successful sync yet';
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return 'Last successful sync recorded';
    }

    return `Last successful sync: ${parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })}`;
  }

  private getSkatersForInjurySync(
    assets: DraftableAsset[]
  ) {
    return assets
      .filter(
        (asset): asset is Extract<
          DraftableAsset,
          { assetType: 'skater' }
        > => asset.assetType === 'skater'
      )
      .map((asset) => asset.player);
  }

  private async refreshDraftInjuriesBeforeOpening(): Promise<void> {
    this.draftInjurySyncInProgress.set(true);
    this.draftInjurySyncMessage.set(
      'Refreshing the shared ESPN injury report before the draft opens.'
    );
    this.draftInjurySyncWarning.set('');

    try {
      let assets = this.playerPool();

      if (assets.length === 0) {
        assets = await loadDraftPlayerPool(true);
        this.playerPool.set(assets);
      }

      const result = await syncPlayerAvailabilityFromEspn({
        leagueId: this.leagueId,
        players: this.getSkatersForInjurySync(assets),
        force: true,
        minimumIntervalMinutes: 1
      });

      this.draftInjurySyncMessage.set(
        result.skipped
          ? result.message
          : `Injury report ready. ${result.matchedCount} injured skaters matched and shared with the league.`
      );
    } catch (error: unknown) {
      const detail = error instanceof Error
        ? error.message
        : 'Unable to refresh ESPN injury data.';

      this.draftInjurySyncWarning.set(
        `The live refresh failed: ${detail} The draft will use the most recent saved injury report instead.`
      );
    } finally {
      this.draftInjurySyncInProgress.set(false);
    }
  }

  async maybeActivateDraft(): Promise<void> {
    const draft = this.draft();

    if (
      !draft ||
      draft.status !== 'scheduled' ||
      !isDraftStartTimeReached(draft)
    ) {
      return;
    }

    if (!this.isCommissioner()) {
      this.draftInjurySyncMessage.set(
        'Waiting for the commissioner to refresh the shared injury report and open the draft.'
      );
      return;
    }

    if (this.activationInProgress) {
      return;
    }

    this.activationInProgress = true;

    try {
      await this.refreshDraftInjuriesBeforeOpening();

      const activatedDraft =
        await activateScheduledDraftIfReady(
          this.leagueId,
          this.userId
        );

      if (activatedDraft?.status === 'live') {
        this.draft.set(activatedDraft);
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to open the scheduled draft.'
      );
    } finally {
      this.activationInProgress = false;
    }
  }

  private getQueueForOwner(ownerId: string): DraftQueue {
    return this.draftQueues().find(
      (queue) => queue.ownerId === ownerId
    ) ?? {
      ownerId,
      assetKeys: [],
      autoDraftEnabled: false
    };
  }

  isAssetQueued(asset: DraftableAsset): boolean {
    return this.myQueue().assetKeys.includes(
      asset.assetKey
    );
  }

  async toggleAssetInQueue(
    asset: DraftableAsset
  ): Promise<void> {
    if (this.isAssetQueued(asset)) {
      await this.removeAssetFromQueue(asset.assetKey);
      return;
    }

    await this.addAssetToQueue(asset);
  }

  async addAssetToQueue(
    asset: DraftableAsset
  ): Promise<void> {
    if (
      this.queueSaving() ||
      this.isAssetQueued(asset) ||
      this.draft()?.status === 'complete'
    ) {
      return;
    }

    await this.saveMyQueue([
      ...this.myQueue().assetKeys,
      asset.assetKey
    ]);
  }

  async removeAssetFromQueue(
    assetKey: string
  ): Promise<void> {
    if (this.queueSaving()) {
      return;
    }

    await this.saveMyQueue(
      this.myQueue().assetKeys.filter(
        (queuedAssetKey) =>
          queuedAssetKey !== assetKey
      )
    );
  }

  async moveQueueAsset(
    assetKey: string,
    direction: -1 | 1
  ): Promise<void> {
    if (this.queueSaving()) {
      return;
    }

    const assetKeys = [...this.myQueue().assetKeys];
    const currentIndex = assetKeys.indexOf(assetKey);
    const nextIndex = currentIndex + direction;

    if (
      currentIndex < 0 ||
      nextIndex < 0 ||
      nextIndex >= assetKeys.length
    ) {
      return;
    }

    [assetKeys[currentIndex], assetKeys[nextIndex]] = [
      assetKeys[nextIndex],
      assetKeys[currentIndex]
    ];

    await this.saveMyQueue(assetKeys);
  }

  async toggleMyAutoDraft(): Promise<void> {
    if (this.queueSaving()) {
      return;
    }

    this.queueSaving.set(true);
    this.errorMessage.set('');

    try {
      await saveDraftQueue(
        this.leagueId,
        this.userId,
        this.myQueue().assetKeys,
        !this.myQueue().autoDraftEnabled
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to update your auto-draft preference.'
      );
    } finally {
      this.queueSaving.set(false);
    }
  }

  async toggleCurrentOwnerAutoDraft(): Promise<void> {
    const ownerId = this.currentPick()?.ownerId;

    if (
      !ownerId ||
      !this.isCommissioner() ||
      this.queueSaving()
    ) {
      return;
    }

    this.queueSaving.set(true);
    this.errorMessage.set('');

    try {
      await setDraftAutoDraftEnabled(
        this.leagueId,
        ownerId,
        !this.getQueueForOwner(ownerId).autoDraftEnabled
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to update that manager’s auto-draft preference.'
      );
    } finally {
      this.queueSaving.set(false);
    }
  }

  async toggleDraftClockPause(): Promise<void> {
    const draft = this.draft();

    if (
      !draft ||
      draft.status !== 'live' ||
      !this.isCommissioner() ||
      this.clockActionInProgress()
    ) {
      return;
    }

    this.clockActionInProgress.set(true);
    this.errorMessage.set('');

    try {
      if (draft.clockStatus === 'paused') {
        await resumeDraftClock(
          this.leagueId,
          this.userId
        );
      } else {
        await pauseDraftClock(
          this.leagueId,
          this.userId
        );
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to change the draft clock.'
      );
    } finally {
      this.clockActionInProgress.set(false);
    }
  }

  getCurrentPickTeamName(): string {
    const pick = this.currentPick();

    return pick
      ? this.getTeamName(pick.ownerId)
      : 'Updating Draft';
  }

  getCurrentPickNumberLabel(): string {
    const pick = this.currentPick();

    return pick
      ? `Pick #${pick.overallPick}`
      : 'Draft Clock';
  }

  getDraftClockStatusLabel(): string {
    const draft = this.draft();

    if (draft?.status === 'complete') {
      return 'Draft Complete';
    }

    if (draft?.clockStatus === 'paused') {
      return 'Clock Paused';
    }

    if (this.currentOwnerAutoDraftEnabled()) {
      return 'Auto-Draft Active';
    }

    return this.isMyTurn()
      ? 'Your Pick'
      : `${this.getTeamName(
          this.currentPick()?.ownerId ?? ''
        )} Picking`;
  }

  private async saveMyQueue(
    assetKeys: string[]
  ): Promise<void> {
    this.queueSaving.set(true);
    this.errorMessage.set('');

    try {
      await saveDraftQueue(
        this.leagueId,
        this.userId,
        assetKeys,
        this.myQueue().autoDraftEnabled
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to update your draft queue.'
      );
    } finally {
      this.queueSaving.set(false);
    }
  }

  private isAssetEligibleForOwner(
    asset: DraftableAsset,
    ownerId: string
  ): boolean {
    const draft = this.draft();

    if (!draft) {
      return false;
    }

    if (
      draft.draftedAssetKeys.includes(asset.assetKey)
    ) {
      return false;
    }

    return (
      this.getPositionCount(ownerId, asset.position) <
      this.getPositionRequirement(asset.position)
    );
  }

  private getAutomaticDraftCandidate(
    ownerId: string
  ): {
    asset: DraftableAsset;
    selectionType: 'queue' | 'automatic';
  } | null {
    const queue = this.getQueueForOwner(ownerId);
    const assetsByKey = new Map(
      this.playerPool().map((asset) => [
        asset.assetKey,
        asset
      ])
    );

    for (const assetKey of queue.assetKeys) {
      const queuedAsset = assetsByKey.get(assetKey);

      if (
        queuedAsset &&
        this.isAssetEligibleForOwner(
          queuedAsset,
          ownerId
        )
      ) {
        return {
          asset: queuedAsset,
          selectionType: 'queue'
        };
      }
    }

    const fallbackAsset = this.playerPool()
      .filter((asset) =>
        this.isAssetEligibleForOwner(
          asset,
          ownerId
        )
      )
      .sort((first, second) =>
        this.compareDraftValueThenProjection(
          first,
          second
        )
      )[0];

    return fallbackAsset
      ? {
          asset: fallbackAsset,
          selectionType: 'automatic'
        }
      : null;
  }

  private async maybeHandleAutomaticPick(): Promise<void> {
    const draft = this.draft();
    const currentPick = this.currentPick();

    if (
      !this.isCommissioner() ||
      !draft ||
      draft.status !== 'live' ||
      draft.clockStatus !== 'running' ||
      !currentPick ||
      this.autoPickInProgress() ||
      this.playerPoolLoading() ||
      this.playerPool().length === 0
    ) {
      return;
    }

    const ownerQueue = this.getQueueForOwner(
      currentPick.ownerId
    );

    const timerExpired = isDraftClockExpired(
      draft,
      new Date(this.now())
    );

    if (
      !timerExpired &&
      !ownerQueue.autoDraftEnabled
    ) {
      return;
    }

    const reason = ownerQueue.autoDraftEnabled
      ? 'manager-auto-mode'
      : 'timer-expired';

    const attemptKey = [
      currentPick.overallPick,
      currentPick.ownerId,
      reason
    ].join(':');

    if (this.lastAutoPickAttemptKey === attemptKey) {
      return;
    }

    this.lastAutoPickAttemptKey = attemptKey;
    this.autoPickInProgress.set(true);
    this.errorMessage.set('');

    try {
      const candidate =
        this.getAutomaticDraftCandidate(
          currentPick.ownerId
        );

      if (!candidate) {
        await pauseDraftClock(
          this.leagueId,
          this.userId
        );

        throw new Error(
          'No eligible auto-draft asset could be found. The draft clock was paused for commissioner review.'
        );
      }

      const pick = await makeAutomaticDraftPick(
        this.leagueId,
        this.userId,
        currentPick.ownerId,
        candidate.asset,
        candidate.selectionType,
        reason
      );

      this.autoPickMessage.set(
        `${this.getTeamName(pick.ownerId)} auto-drafted ${this.getAssetName(pick.asset)} at pick #${pick.overallPick}.`
      );
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to process the automatic draft pick.';

      const staleAttempt =
        message.includes('no longer on the clock') ||
        message.includes('already been drafted') ||
        message.includes('timer has not expired');

      if (!staleAttempt) {
        this.errorMessage.set(message);
      }

      setTimeout(() => {
        if (
          this.lastAutoPickAttemptKey === attemptKey
        ) {
          this.lastAutoPickAttemptKey = '';
        }
      }, 3000);
    } finally {
      this.autoPickInProgress.set(false);
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

  getPickSelectionLabel(pick: DraftPick): string {
    return pick.selectionType && pick.selectionType !== 'manual'
      ? ' · Auto'
      : '';
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

  getDraftNews(
    asset: DraftableAsset
  ): DraftPlayerNewsOverride | null {
    return getDraftNewsOverrideForAsset(asset);
  }

  hasDraftNews(asset: DraftableAsset): boolean {
    return Boolean(this.getDraftNews(asset)?.note);
  }

  hasOffseasonTeamChange(asset: DraftableAsset): boolean {
    const news = this.getDraftNews(asset);

    return Boolean(
      news?.previousTeamAbbreviation &&
        this.getNewsNewTeamAbbreviation(asset)
    );
  }

  getPreviousTeamAbbreviation(
    asset: DraftableAsset
  ): string {
    return this.getDraftNews(asset)?.previousTeamAbbreviation ?? '';
  }

  getNewsNewTeamAbbreviation(
    asset: DraftableAsset
  ): string {
    return (
      this.getDraftNews(asset)?.newTeamAbbreviation ??
      this.getAssetTeamLabel(asset)
    );
  }

  getPreviousTeamLogoUrl(asset: DraftableAsset): string | undefined {
    const abbreviation = this.getPreviousTeamAbbreviation(asset);

    return abbreviation
      ? getDraftNewsTeamLogoUrl(abbreviation)
      : undefined;
  }

  getNewTeamLogoUrl(asset: DraftableAsset): string | undefined {
    const abbreviation = this.getNewsNewTeamAbbreviation(asset);

    return abbreviation
      ? getDraftNewsTeamLogoUrl(abbreviation)
      : undefined;
  }

  getPlayerAvailability(
    asset: DraftableAsset
  ): PlayerAvailability | null {
    if (asset.assetType !== 'skater') {
      return null;
    }

    return getPlayerAvailabilityForPlayer(asset.player);
  }

  shouldShowPlayerAvailabilityBadge(
    asset: DraftableAsset
  ): boolean {
    const availability = this.getPlayerAvailability(asset);

    return availability
      ? shouldDisplayPlayerAvailability(availability)
      : false;
  }

  getPlayerAvailabilityLabel(asset: DraftableAsset): string {
    return this.getPlayerAvailability(asset)?.shortLabel ?? '';
  }

  getPlayerAvailabilityClass(asset: DraftableAsset): string {
    const availability = this.getPlayerAvailability(asset);

    return availability
      ? getPlayerAvailabilityStatusClass(availability.status)
      : '';
  }

  getPlayerAvailabilityNote(asset: DraftableAsset): string {
    return this.getPlayerAvailability(asset)?.note ?? '';
  }

  isPlayerAvailabilityIrEligible(asset: DraftableAsset): boolean {
    return this.getPlayerAvailability(asset)?.irEligible ?? false;
  }

  getDraftNewsNote(asset: DraftableAsset): string {
    return this.getDraftNews(asset)?.note ?? '';
  }

  getDraftNewsTooltip(asset: DraftableAsset): string {
    const news = this.getDraftNews(asset);

    if (!news) {
      return '';
    }

    const details: string[] = [];

    if (this.hasOffseasonTeamChange(asset)) {
      details.push(
        `${this.getPreviousTeamAbbreviation(asset)} → ${this.getNewsNewTeamAbbreviation(asset)}`
      );
    }

    if (news.note) {
      details.push(news.note);
    }

    return details.join(' · ');
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
      draft.clockStatus !== 'running' ||
      isDraftClockExpired(
        draft,
        new Date(this.now())
      ) ||
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

    if (this.draft()?.clockStatus === 'paused') {
      return 'Paused';
    }

    if (
      this.draft() &&
      isDraftClockExpired(
        this.draft(),
        new Date(this.now())
      )
    ) {
      return 'Time Expired';
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