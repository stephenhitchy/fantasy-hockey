import { Component, computed, ElementRef, OnDestroy, signal, ViewChild } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  type AutoDraftBenchRole,
  getAutoDraftBenchRole,
  isAutomaticDraftCandidateAllowed,
} from '../../../core/draft/auto-draft-strategy';

import {
  DraftableAsset,
  DraftPick,
  DraftPickPreview,
  DraftPosition,
  DraftQueue,
  FantasyDraft,
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
  setDraftAutoDraftEnabled,
  startDraftClock,
} from '../../../core/draft/draft.service';

import {
  generateSharedProjectionSnapshot,
  isSharedProjectionSnapshotFreshForDraft,
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotMetadata,
  PRE_DRAFT_PROJECTION_WARMUP_MINUTES,
  SHARED_PROJECTION_VERSION,
  SharedProjectionGenerationReason,
} from '../../../core/projection/projection-snapshot.service';

import {
  DraftPlayerNewsOverride,
  getDraftNewsOverrideForAsset,
  getDraftNewsTeamLogoUrl,
} from '../../../core/draft/draft-news-overrides';

import {
  PlayerAvailability,
  PlayerAvailabilitySyncState,
} from '../../../core/player/player-availability.models';

import {
  getPlayerAvailabilityForPlayer,
  getPlayerAvailabilityStatusClass,
  shouldDisplayPlayerAvailability,
  startPlayerAvailabilityListenerForLeague,
} from '../../../core/player/player-availability.service';

import {
  listenToPlayerAvailabilitySyncState,
  syncPlayerAvailabilityFromEspn,
} from '../../../core/player/player-availability-sync.service';

import { getLeagueById, League } from '../../../core/league/league.service';

import { FantasyTeam, getFantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

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

interface DraftTimelineEntry {
  preview: DraftPickPreview;
  pick: DraftPick | null;
}

@Component({
  selector: 'app-draft-room',
  imports: [FormsModule, RouterLink],
  templateUrl: './draft-room.html',
  styleUrl: './draft-room.css',
})
export class DraftRoom implements OnDestroy {
  @ViewChild('draftTimelineScroller')
  private draftTimelineElement?: ElementRef<HTMLElement>;

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
  sharedProjectionRepairInProgress = signal(false);
  preDraftPreparationInProgress = signal(false);
  preDraftPreparationReady = signal(false);
  preDraftPreparationMessage = signal('');
  preDraftPreparationWarning = signal('');

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

  readonly rosterPositions: DraftPosition[] = ['LW', 'C', 'RW', 'D', 'G'];
  setSortMode(value: string): void {
    const validSorts: PlayerPoolSort[] = [
      'DRAFT_VALUE',
      'RELIABILITY',
      'RATING',
      'PROJECTED_CYCLE',
      'PROJECTED_SEASON',
      'NAME',
      'POSITION',
      'TEAM',
    ];

    if (validSorts.includes(value as PlayerPoolSort)) {
      this.sortMode.set(value as PlayerPoolSort);
    }
  }

  private compareDraftValueThenProjection(first: DraftableAsset, second: DraftableAsset): number {
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

    const firstProjectedCycle = this.getAssetDraftProjectedCycle(first) ?? -1;

    const secondProjectedCycle = this.getAssetDraftProjectedCycle(second) ?? -1;

    if (secondProjectedCycle !== firstProjectedCycle) {
      return secondProjectedCycle - firstProjectedCycle;
    }

    return this.getAssetName(first).localeCompare(this.getAssetName(second));
  }

  getAssetValueRank(asset: DraftableAsset): number | null {
    return (
      asset.draftRank ?? asset.balancedRank ?? this.assetValueRankByKey()[asset.assetKey] ?? null
    );
  }

  getAssetValueRankDisplay(asset: DraftableAsset): string {
    const rank = this.getAssetValueRank(asset);

    return typeof rank === 'number' ? `#${rank}` : '—';
  }

  getAssetRating(asset: DraftableAsset): number | null {
    const projectedCycle = this.getAssetDraftProjectedCycle(asset);

    if (typeof projectedCycle !== 'number') {
      return null;
    }

    const denominator =
      asset.position === 'G' ? this.topGoalieDraftProjection() : this.topSkaterDraftProjection();

    return Math.round((projectedCycle / denominator) * 100);
  }

  getAssetRatingDisplay(asset: DraftableAsset): string {
    const rating = this.getAssetRating(asset);

    return typeof rating === 'number' ? rating.toString() : '—';
  }

  getAssetRatingLabel(asset: DraftableAsset): string {
    return asset.assetType === 'team-goalie-unit' ? 'Goalie Rating' : 'Player Rating';
  }

  getMyPicksByPosition(position: DraftPosition): DraftPick[] {
    return this.picks().filter(
      (pick) => pick.ownerId === this.userId && pick.asset.position === position,
    );
  }

  isBenchDraftPick(pick: DraftPick): boolean {
    if (pick.rosterArea) {
      return pick.rosterArea === 'bench';
    }

    const samePositionPicks = this.picks()
      .filter(
        (candidate) =>
          candidate.ownerId === pick.ownerId && candidate.asset.position === pick.asset.position,
      )
      .sort((first, second) => first.overallPick - second.overallPick);
    const positionIndex = samePositionPicks.findIndex(
      (candidate) => candidate.overallPick === pick.overallPick,
    );

    return positionIndex >= this.getPositionRequirement(pick.asset.position);
  }

  getMyStarterPositionCount(position: DraftPosition): number {
    return this.getMyPicksByPosition(position).filter((pick) => !this.isBenchDraftPick(pick)).length;
  }

  getMyBenchPositionCount(position: DraftPosition): number {
    return this.getMyPicksByPosition(position).filter((pick) => this.isBenchDraftPick(pick)).length;
  }

  getEmptySlotsForPosition(position: DraftPosition): number[] {
    const openSlotCount = Math.max(
      0,
      this.getPositionRequirement(position) - this.getMyStarterPositionCount(position),
    );

    return Array.from({ length: openSlotCount }, (_, index) => index);
  }

  getAssetExpectedGamesDisplay(asset: DraftableAsset): string {
    const expected = asset.expectedGamesAvailable;
    const scheduled = asset.scheduledGamesInProjectionCycle;

    if (typeof expected !== 'number' || typeof scheduled !== 'number') {
      return '';
    }

    return `${expected.toFixed(1)}/${scheduled} games`;
  }

  getAssetAvailabilityLabel(asset: DraftableAsset): string {
    return asset.availabilityLabel ?? 'Active';
  }

  getProjectionDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getAssetProjectedSeason(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return (
      asset.draftProjectedSeasonPoints ??
      poolAsset?.draftProjectedSeasonPoints ??
      asset.projectedSeasonPoints ??
      poolAsset?.projectedSeasonPoints ??
      null
    );
  }

  getAssetDraftProjectedCycle(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return (
      asset.draftProjectedCyclePoints ??
      poolAsset?.draftProjectedCyclePoints ??
      (typeof this.getAssetProjectedSeason(asset) === 'number'
        ? (this.getAssetProjectedSeason(asset)! / 82) * 6
        : null)
    );
  }

  getAssetProjectedCycle(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return asset.projectedCyclePoints ?? poolAsset?.projectedCyclePoints ?? null;
  }

  getAssetFloorAdjustedCycle(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return (
      asset.floorAdjustedCyclePoints ??
      poolAsset?.floorAdjustedCyclePoints ??
      this.getAssetProjectedCycle(asset)
    );
  }

  getAssetReliabilityRating(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return (
      asset.draftReliabilityRating ??
      poolAsset?.draftReliabilityRating ??
      asset.reliabilityRating ??
      poolAsset?.reliabilityRating ??
      null
    );
  }

  getAssetReliabilityDisplay(asset: DraftableAsset): string {
    const rating = this.getAssetReliabilityRating(asset);

    return typeof rating === 'number' ? Math.round(rating).toString() : '—';
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

  getAssetRecentFormAdjustment(asset: DraftableAsset): number | null {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    return asset.recentFormAdjustment ?? poolAsset?.recentFormAdjustment ?? null;
  }

  getAssetRecentFormLabel(asset: DraftableAsset): string {
    const adjustment = this.getAssetRecentFormAdjustment(asset);

    if (typeof adjustment !== 'number') {
      return 'Form: —';
    }

    const prefix = adjustment > 0 ? '+' : '';

    return `Form: ${prefix}${adjustment.toFixed(1)}`;
  }

  getAssetRecentFormClass(asset: DraftableAsset): string {
    const adjustment = this.getAssetRecentFormAdjustment(asset);

    if (typeof adjustment !== 'number' || Math.abs(adjustment) < 0.05) {
      return 'form-neutral';
    }

    return adjustment > 0 ? 'form-positive' : 'form-negative';
  }

  getAssetProjectionDataLabel(asset: DraftableAsset): string {
    const poolAsset = this.playerPool().find(
      (availableAsset) => availableAsset.assetKey === asset.assetKey,
    );

    const source = asset.projectionDataSource ?? poolAsset?.projectionDataSource;

    const gamesPlayed = asset.projectionGamesPlayed ?? poolAsset?.projectionGamesPlayed;

    const sourceLabel =
      source === 'current-season-form'
        ? 'Current form'
        : source === 'current-season-baseline'
          ? 'Current baseline'
          : source === 'previous-season-form'
            ? 'Previous form'
            : source === 'previous-season-baseline'
              ? 'Previous baseline'
              : 'Baseline';

    return typeof gamesPlayed === 'number' ? `${sourceLabel} · ${gamesPlayed} GP` : sourceLabel;
  }

  getAssetDraftValue(asset: DraftableAsset): number | null {
    if (typeof asset.draftScore === 'number') {
      return asset.draftScore;
    }

    if (typeof asset.balancedDraftValue === 'number') {
      return asset.balancedDraftValue;
    }

    return this.getAssetDraftProjectedCycle(asset);
  }

  private compareDraftAssets(first: DraftableAsset, second: DraftableAsset): number {
    const sortMode = this.sortMode();

    if (sortMode === 'DRAFT_VALUE') {
      return this.compareDraftValueThenProjection(first, second);
    }

    if (sortMode === 'RELIABILITY') {
      const firstReliability = this.getAssetReliabilityRating(first) ?? -1;

      const secondReliability = this.getAssetReliabilityRating(second) ?? -1;

      if (secondReliability !== firstReliability) {
        return secondReliability - firstReliability;
      }

      return this.compareDraftValueThenProjection(first, second);
    }

    if (sortMode === 'RATING') {
      const firstRating = this.getAssetRating(first) ?? -1;
      const secondRating = this.getAssetRating(second) ?? -1;

      if (secondRating !== firstRating) {
        return secondRating - firstRating;
      }

      return this.getAssetName(first).localeCompare(this.getAssetName(second));
    }

    if (sortMode === 'PROJECTED_CYCLE') {
      return this.compareProjectionThenName(first, second, 'projectedCyclePoints');
    }

    if (sortMode === 'PROJECTED_SEASON') {
      return this.compareProjectionThenName(first, second, 'projectedSeasonPoints');
    }

    if (sortMode === 'POSITION') {
      const positionComparison =
        this.getPositionSortValue(first.position) - this.getPositionSortValue(second.position);

      if (positionComparison !== 0) {
        return positionComparison;
      }

      return this.getAssetName(first).localeCompare(this.getAssetName(second));
    }

    if (sortMode === 'TEAM') {
      const teamComparison = this.getAssetTeamLabel(first).localeCompare(
        this.getAssetTeamLabel(second),
      );

      if (teamComparison !== 0) {
        return teamComparison;
      }

      return this.getAssetName(first).localeCompare(this.getAssetName(second));
    }

    return this.getAssetName(first).localeCompare(this.getAssetName(second));
  }

  private compareProjectionThenName(
    first: DraftableAsset,
    second: DraftableAsset,
    projectionKey: 'projectedSeasonPoints' | 'projectedCyclePoints',
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

    return this.getAssetName(first).localeCompare(this.getAssetName(second));
  }

  private getPositionSortValue(position: DraftPosition): number {
    return this.rosterPositions.indexOf(position);
  }

  private stopDraftListener: (() => void) | null = null;
  private stopPickListener: (() => void) | null = null;
  private stopInjurySyncListener: (() => void) | null = null;
  private stopQueueListener: (() => void) | null = null;
  private activationInProgress = false;
  private scheduledDraftCheckInProgress = false;
  private destroyed = false;
  private activationFailureCount = 0;
  private activationRetryNotBefore = 0;
  private preDraftPreparationAttemptKey = '';
  private lastAutoPickAttemptKey = '';
  private lastObservedDraftStatus: FantasyDraft['status'] | null = null;

  private readonly clockTimer = setInterval(() => {
    if (this.destroyed) {
      return;
    }

    this.now.set(Date.now());
    void this.maybeHandleAutomaticPick();
  }, 1000);

  private readonly scheduledDraftCheckTimer = setInterval(() => {
    void this.runScheduledDraftChecks();
  }, 5000);

  readonly currentPick = computed<DraftPickPreview | null>(() => getCurrentDraftPick(this.draft()));

  readonly myQueue = computed<DraftQueue>(() => this.getQueueForOwner(this.userId));

  readonly queueAssets = computed(() => {
    const draftedAssetKeys = new Set(this.draft()?.draftedAssetKeys ?? []);

    const assetsByKey = new Map(this.playerPool().map((asset) => [asset.assetKey, asset]));

    return this.myQueue()
      .assetKeys.map((assetKey) => assetsByKey.get(assetKey))
      .filter(
        (asset): asset is DraftableAsset =>
          asset !== undefined && !draftedAssetKeys.has(asset.assetKey),
      );
  });

  readonly draftClockRemainingSeconds = computed(() =>
    getDraftClockRemainingSeconds(this.draft(), new Date(this.now())),
  );

  readonly draftClockDisplay = computed(() => {
    const draft = this.draft();

    const totalSeconds =
      draft?.clockStatus === 'stopped'
        ? (draft.currentPickSeconds ?? draft.pickSeconds)
        : this.draftClockRemainingSeconds();

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });

  readonly draftClockIsUrgent = computed(
    () => this.draft()?.clockStatus === 'running' && this.draftClockRemainingSeconds() <= 10,
  );

  readonly currentOwnerAutoDraftEnabled = computed(() => {
    const ownerId = this.currentPick()?.ownerId;

    return ownerId ? this.getQueueForOwner(ownerId).autoDraftEnabled : false;
  });

  readonly draftStartDate = computed(() => getScheduledStartDate(this.draft()));

  readonly startTimeReached = computed(() =>
    isDraftStartTimeReached(this.draft(), new Date(this.now())),
  );

  readonly isMyTurn = computed(() => this.currentPick()?.ownerId === this.userId);

  readonly totalPickCount = computed(() => getDraftTotalPickCount(this.draft()));

  readonly draftProgressText = computed(() => {
    const draft = this.draft();

    if (!draft) {
      return '0 / 0 Picks';
    }

    const completed = Math.max(0, draft.nextOverallPick - 1);

    return `${completed} / ${this.totalPickCount()} Picks`;
  });

  readonly availableAssetCount = computed(() => {
    const draftedAssetKeys = new Set(this.draft()?.draftedAssetKeys ?? []);

    return this.playerPool().filter((asset) => !draftedAssetKeys.has(asset.assetKey)).length;
  });

  readonly replacementCycleValueByPosition = computed(() => {
    const draft = this.draft();

    const replacementValues: Record<DraftPosition, number | null> = {
      LW: null,
      C: null,
      RW: null,
      D: null,
      G: null,
    };

    if (!draft) {
      return replacementValues;
    }

    const teamCount = Math.max(this.teams().length, draft.roundOneOrder.length, 1);

    for (const position of this.rosterPositions) {
      const requiredSlotsAtPosition = draft.rosterRequirements[position] ?? 0;

      const replacementRank = Math.max(1, teamCount * requiredSlotsAtPosition);

      const projectedCycles = this.playerPool()
        .filter((asset) => asset.position === position)
        .map((asset) => asset.floorAdjustedCyclePoints ?? asset.projectedCyclePoints)
        .filter((value): value is number => typeof value === 'number')
        .sort((first, second) => second - first);

      replacementValues[position] =
        projectedCycles[Math.min(replacementRank - 1, projectedCycles.length - 1)] ?? null;
    }

    return replacementValues;
  });

  readonly topSkaterDraftProjection = computed(() => {
    const topProjection = Math.max(
      1,
      ...this.playerPool()
        .filter((asset) => asset.position !== 'G')
        .map((asset) => asset.draftProjectedCyclePoints ?? asset.projectedCyclePoints ?? 0),
    );

    return topProjection;
  });

  readonly topGoalieDraftProjection = computed(() => {
    const topProjection = Math.max(
      1,
      ...this.playerPool()
        .filter((asset) => asset.position === 'G')
        .map((asset) => asset.draftProjectedCyclePoints ?? asset.projectedCyclePoints ?? 0),
    );

    return topProjection;
  });

  readonly assetValueRankByKey = computed(() => {
    const ranks: Record<string, number> = {};

    [...this.playerPool()]
      .sort((first, second) => this.compareDraftValueThenProjection(first, second))
      .forEach((asset, index) => {
        ranks[asset.assetKey] = index + 1;
      });

    return ranks;
  });

  readonly availableAssets = computed(() => {
    const draftedAssetKeys = new Set(this.draft()?.draftedAssetKeys ?? []);

    const search = this.searchTerm().trim().toLowerCase();

    const positionFilter = this.positionFilter();

    return this.playerPool()
      .filter((asset) => !draftedAssetKeys.has(asset.assetKey))
      .filter((asset) => (positionFilter === 'ALL' ? true : asset.position === positionFilter))
      .filter((asset) => {
        if (!search) {
          return true;
        }

        return this.getAssetName(asset).toLowerCase().includes(search);
      })
      .sort((first, second) => this.compareDraftAssets(first, second))
      .slice(0, 120);
  });

  readonly draftTimeline = computed<DraftTimelineEntry[]>(() => {
    const draft = this.draft();

    if (!draft) {
      return [];
    }

    const totalPicks = getDraftTotalPickCount(draft);
    const visiblePickCount = 20;
    const currentOverallPick = Math.min(
      Math.max(1, draft.nextOverallPick),
      Math.max(1, totalPicks),
    );

    let startOverallPick = Math.max(1, currentOverallPick - 8);
    let endOverallPick = Math.min(totalPicks, startOverallPick + visiblePickCount - 1);

    startOverallPick = Math.max(1, endOverallPick - visiblePickCount + 1);

    const completedPicks = new Map<number, DraftPick>(
      this.picks().map((pick): [number, DraftPick] => [pick.overallPick, pick]),
    );

    const entries: DraftTimelineEntry[] = [];

    for (let overallPick = startOverallPick; overallPick <= endOverallPick; overallPick += 1) {
      const preview = getDraftPickAtOverall(draft, overallPick);

      if (preview) {
        entries.push({
          preview,
          pick: completedPicks.get(overallPick) ?? null,
        });
      }
    }

    return entries;
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    this.loadDraftRoom();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.clockTimer);
    clearInterval(this.scheduledDraftCheckTimer);
    this.stopDraftListener?.();
    this.stopPickListener?.();
    this.stopInjurySyncListener?.();
    this.stopQueueListener?.();
  }

  async loadDraftRoom(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (this.destroyed) {
      return;
    }

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
        getFantasyTeam(leagueId, user.uid),
      ]);

      if (this.destroyed) {
        return;
      }

      if (!league || !myTeam) {
        await this.router.navigate(['/dashboard']);
        return;
      }

      this.league.set(league);
      this.teams.set(teams);
      this.isCommissioner.set(league.commissionerId === user.uid);
      startPlayerAvailabilityListenerForLeague(leagueId);

      this.stopQueueListener?.();

      if (league.commissionerId === user.uid) {
        this.stopQueueListener = listenToDraftQueues(leagueId, (queues) => {
          if (!this.destroyed) {
            this.draftQueues.set(queues);
          }
        });
      } else {
        this.stopQueueListener = listenToDraftQueue(leagueId, user.uid, (queue) => {
          if (!this.destroyed) {
            this.draftQueues.set([queue]);
          }
        });
      }

      this.stopInjurySyncListener?.();
      this.stopInjurySyncListener = listenToPlayerAvailabilitySyncState(leagueId, (state) => {
        if (!this.destroyed) {
          this.injurySyncState.set(state);
        }
      });

      this.stopDraftListener = listenToFantasyDraft(leagueId, (draft) => {
        if (this.destroyed) {
          return;
        }

        const previousStatus = this.lastObservedDraftStatus;

        this.lastObservedDraftStatus = draft?.status ?? null;

        this.draft.set(draft);
        this.scheduleDraftTimelineScroll();

        if (draft?.status === 'live' && previousStatus !== null && previousStatus !== 'live') {
          // The commissioner creates the final frozen snapshot immediately
          // before activating the draft. Reload once on the scheduled-to-live
          // transition so managers who entered early do not keep an older
          // pre-draft snapshot.
          void this.loadPlayerPool();
        }

        void this.runScheduledDraftChecks();
      });

      this.stopPickListener = listenToDraftPicks(leagueId, (picks) => {
        if (!this.destroyed) {
          this.picks.set(picks);
          this.scheduleDraftTimelineScroll();
        }
      });

      await this.loadPlayerPool();

      if (!this.destroyed) {
        await this.runScheduledDraftChecks();
      }
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.errorMessage.set(
          error instanceof Error ? error.message : 'Unable to load the draft room.',
        );
      }
    } finally {
      if (!this.destroyed) {
        this.loading.set(false);
        this.scheduleDraftTimelineScroll();
      }
    }
  }

  async loadPlayerPool(): Promise<void> {
    this.playerPoolLoading.set(true);
    this.playerPoolError.set('');

    try {
      const snapshot = await loadSharedProjectionSnapshot(this.leagueId);

      if (this.destroyed) {
        return;
      }

      if (!snapshot) {
        this.playerPool.set([]);
        throw new Error(
          'Shared projections are not ready. The commissioner must refresh them before the draft can use rankings or auto-draft.',
        );
      }

      this.playerPool.set(snapshot.assets);
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.playerPoolError.set(
          error instanceof Error ? error.message : 'Unable to load the shared NHL player pool.',
        );
      }
    } finally {
      if (!this.destroyed) {
        this.playerPoolLoading.set(false);
      }
    }
  }

  getDraftInjurySyncStatusLabel(): string {
    if (this.draftInjurySyncInProgress() || this.injurySyncState()?.status === 'running') {
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
    if (this.draftInjurySyncInProgress() || this.injurySyncState()?.status === 'running') {
      return 'The app is preparing today’s shared ESPN injury report. The draft will open after this one daily check finishes.';
    }

    if (this.draftInjurySyncWarning()) {
      return this.draftInjurySyncWarning();
    }

    if (this.draftInjurySyncMessage()) {
      return this.draftInjurySyncMessage();
    }

    const state = this.injurySyncState();

    if (state?.status === 'success') {
      return (
        state.message || 'The shared ESPN injury report is ready for every league and account.'
      );
    }

    if (state?.status === 'error') {
      return state.message || 'The most recent saved report will remain available.';
    }

    return this.isCommissioner()
      ? `The injury report and shared rankings begin preloading ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before the scheduled start.`
      : 'Waiting for the commissioner to refresh the shared injury report and open the draft.';
  }

  getDraftInjurySyncTimeLabel(): string {
    const value = this.injurySyncState()?.lastSuccessfulSyncAt;

    if (!value) {
      return 'Not updated yet';
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return 'Last update recorded';
    }

    return `Last updated: ${parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })}`;
  }

  private getProjectionTeamCount(): number {
    return Math.max(this.league()?.maxTeams ?? this.teams().length, 2);
  }

  private getRequiredGamesPerCycle(): number {
    return this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;
  }

  private getMillisecondsUntilDraftStart(): number | null {
    const startDate = this.draftStartDate();

    if (!startDate) {
      return null;
    }

    return startDate.getTime() - this.now();
  }

  getPreDraftPreparationStatusLabel(): string {
    if (this.preDraftPreparationInProgress()) {
      return 'Preparing Draft Data';
    }

    if (this.preDraftPreparationReady()) {
      return 'Draft Data Ready';
    }

    const millisecondsRemaining = this.getMillisecondsUntilDraftStart();

    if (
      typeof millisecondsRemaining === 'number' &&
      millisecondsRemaining > PRE_DRAFT_PROJECTION_WARMUP_MINUTES * 60 * 1000
    ) {
      return `Preload begins ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before start`;
    }

    return this.isCommissioner()
      ? 'Waiting to prepare draft data'
      : 'Waiting for commissioner preparation';
  }

  getPreDraftPreparationDescription(): string {
    if (this.preDraftPreparationWarning()) {
      return this.preDraftPreparationWarning();
    }

    if (this.preDraftPreparationMessage()) {
      return this.preDraftPreparationMessage();
    }

    if (this.preDraftPreparationReady()) {
      return 'The shared season draft rankings, next-cycle projections, and injury report are ready. The draft can open immediately at the scheduled time.';
    }

    return this.isCommissioner()
      ? `Keep this Draft Room open. The injury refresh and shared projection build will begin automatically ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before the scheduled start.`
      : 'The app will check the shared daily injury report and prepare one league ranking before the scheduled start.';
  }

  private async loadFreshDraftSnapshotIfAvailable(): Promise<boolean> {
    const metadata = await loadSharedProjectionSnapshotMetadata(this.leagueId);

    if (this.destroyed) {
      return false;
    }

    const isFresh = isSharedProjectionSnapshotFreshForDraft(metadata, {
      teamCount: this.getProjectionTeamCount(),
      requiredGamesPerCycle: this.getRequiredGamesPerCycle(),
      now: new Date(this.now()),
    });

    if (!isFresh) {
      return false;
    }

    const snapshot = await loadSharedProjectionSnapshot(this.leagueId);

    if (this.destroyed || !snapshot || snapshot.assets.length === 0) {
      return false;
    }

    this.playerPool.set(snapshot.assets);
    this.playerPoolError.set('');
    this.preDraftPreparationReady.set(true);
    this.preDraftPreparationMessage.set(
      'Shared draft rankings and injury-adjusted cycle projections are already prepared.',
    );

    return true;
  }

  private async loadLastGoodDraftSnapshotIfAvailable(
    refreshFailureDetail: string,
  ): Promise<boolean> {
    try {
      const metadata = await loadSharedProjectionSnapshotMetadata(this.leagueId);

      if (this.destroyed || !metadata) {
        return false;
      }

      const generatedAt = Date.parse(metadata.generatedAt);
      const maximumFallbackAgeMilliseconds = 24 * 60 * 60 * 1000;
      const snapshotAgeMilliseconds = this.now() - generatedAt;
      const isCompatible =
        metadata.status === 'ready' &&
        metadata.projectionVersion === SHARED_PROJECTION_VERSION &&
        metadata.assetCount > 0 &&
        metadata.teamCount === this.getProjectionTeamCount() &&
        metadata.requiredGamesPerCycle === this.getRequiredGamesPerCycle() &&
        Number.isFinite(generatedAt) &&
        snapshotAgeMilliseconds >= 0 &&
        snapshotAgeMilliseconds <= maximumFallbackAgeMilliseconds;

      if (!isCompatible) {
        return false;
      }

      const snapshot = await loadSharedProjectionSnapshot(this.leagueId);

      if (this.destroyed || !snapshot || snapshot.assets.length === 0) {
        return false;
      }

      const generatedLabel = new Date(metadata.generatedAt).toLocaleString();

      this.playerPool.set(snapshot.assets);
      this.playerPoolError.set('');
      this.preDraftPreparationReady.set(true);
      this.preDraftPreparationMessage.set(
        `The last verified shared projection snapshot from ${generatedLabel} is loaded.`,
      );
      this.preDraftPreparationWarning.set(
        `The live NHL statistics refresh was temporarily unavailable (${refreshFailureDetail}). The draft can continue using the last verified Version ${SHARED_PROJECTION_VERSION} rankings. Refresh them later from Projection Lab when the NHL service recovers.`,
      );
      this.draftInjurySyncWarning.set(
        'A temporary data-service interruption occurred, but the saved injury report and last verified projections are available.',
      );

      return true;
    } catch {
      return false;
    }
  }

  private async prepareDraftData(
    generationReason: SharedProjectionGenerationReason,
  ): Promise<void> {
    if (this.destroyed || this.preDraftPreparationInProgress()) {
      return;
    }

    this.preDraftPreparationInProgress.set(true);
    this.draftInjurySyncInProgress.set(true);
    this.preDraftPreparationReady.set(false);
    this.preDraftPreparationWarning.set('');
    this.draftInjurySyncWarning.set('');
    this.preDraftPreparationMessage.set(
      'Checking the daily app-wide injury report before building the final draft snapshot.',
    );
    this.draftInjurySyncMessage.set(
      'Checking the single shared ESPN injury report before building projections.',
    );

    try {
      try {
        const result = await syncPlayerAvailabilityFromEspn({
          leagueId: this.leagueId,
          trigger: 'draft-start',
        });

        if (this.destroyed) {
          return;
        }

        this.draftInjurySyncMessage.set(
          result.skipped
            ? result.message
            : `Injury report ready. ${result.matchedCount} injured skaters matched.`,
        );
      } catch (error: unknown) {
        if (this.destroyed) {
          return;
        }

        if (this.isFirestoreResourceExhausted(error)) {
          throw error;
        }

        const detail =
          error instanceof Error ? error.message : 'Unable to refresh ESPN injury data.';

        this.draftInjurySyncWarning.set(
          `The daily app-wide injury refresh failed: ${detail} The newest saved report will be used.`,
        );
      }

      if (this.destroyed) {
        return;
      }

      this.preDraftPreparationMessage.set(
        'Building the shared season draft ranking and next-cycle projection snapshot.',
      );

      const sharedSnapshot = await generateSharedProjectionSnapshot({
        leagueId: this.leagueId,
        teamCount: this.getProjectionTeamCount(),
        requiredGamesPerCycle: this.getRequiredGamesPerCycle(),
        generationReason,
      });

      if (this.destroyed) {
        return;
      }

      this.playerPool.set(sharedSnapshot.assets);
      this.playerPoolError.set('');
      this.preDraftPreparationReady.set(true);
      this.preDraftPreparationMessage.set(
        `Draft data ready: ${sharedSnapshot.metadata.assetCount} shared assets are prepared for every manager.`,
      );
      this.draftInjurySyncMessage.set(
        `Shared Cycle ${sharedSnapshot.metadata.targetCycleNumber} projections are ready for every manager.`,
      );
    } catch (error: unknown) {
      if (this.destroyed) {
        return;
      }

      const detail = error instanceof Error ? error.message : 'Unable to build shared projections.';
      const fallbackLoaded = await this.loadLastGoodDraftSnapshotIfAvailable(detail);

      if (!fallbackLoaded) {
        this.preDraftPreparationWarning.set(`Pre-draft preparation failed: ${detail}`);
        this.draftInjurySyncWarning.set(
          `The draft cannot open because no verified shared projection snapshot is available: ${detail}`,
        );

        throw error;
      }
    } finally {
      if (!this.destroyed) {
        this.draftInjurySyncInProgress.set(false);
        this.preDraftPreparationInProgress.set(false);
      }
    }
  }

  private async runScheduledDraftChecks(): Promise<void> {
    if (
      this.destroyed ||
      this.scheduledDraftCheckInProgress ||
      Date.now() < this.activationRetryNotBefore
    ) {
      return;
    }

    this.scheduledDraftCheckInProgress = true;

    try {
      await this.maybeWarmPreDraftProjections();

      if (this.destroyed) {
        return;
      }

      await this.maybeActivateDraft();
    } catch (error: unknown) {
      if (this.destroyed) {
        return;
      }

      if (this.isFirestoreResourceExhausted(error)) {
        this.scheduleFirestoreRetry();
        return;
      }

      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to check the scheduled draft state.',
      );
    } finally {
      this.scheduledDraftCheckInProgress = false;
    }
  }

  private isFirestoreResourceExhausted(error: unknown): boolean {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    } | null;

    const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : '';
    const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';

    return (
      code === 'resource-exhausted' ||
      code === 'firestore/resource-exhausted' ||
      message.includes('resource-exhausted') ||
      message.includes('too many requests') ||
      message.includes('429')
    );
  }

  private scheduleFirestoreRetry(): void {
    this.activationFailureCount += 1;

    const delaySeconds = Math.min(300, 15 * Math.pow(2, this.activationFailureCount - 1));

    this.activationRetryNotBefore = Date.now() + delaySeconds * 1000;

    this.errorMessage.set(
      `Firestore is temporarily throttling draft preparation. No injury or draft data was deleted. This browser will wait ${delaySeconds} seconds before checking again.`,
    );
  }

  private clearFirestoreRetry(): void {
    this.activationFailureCount = 0;
    this.activationRetryNotBefore = 0;

    if (this.errorMessage().includes('Firestore is temporarily throttling draft preparation.')) {
      this.errorMessage.set('');
    }
  }

  async maybeWarmPreDraftProjections(): Promise<void> {
    const draft = this.draft();
    const startDate = this.draftStartDate();

    if (
      this.destroyed ||
      !draft ||
      draft.status !== 'scheduled' ||
      !startDate ||
      !this.isCommissioner() ||
      this.preDraftPreparationInProgress() ||
      this.activationInProgress
    ) {
      return;
    }

    const millisecondsRemaining = startDate.getTime() - this.now();

    if (
      millisecondsRemaining <= 0 ||
      millisecondsRemaining > PRE_DRAFT_PROJECTION_WARMUP_MINUTES * 60 * 1000
    ) {
      return;
    }

    if (await this.loadFreshDraftSnapshotIfAvailable()) {
      this.clearFirestoreRetry();
      return;
    }

    if (this.destroyed) {
      return;
    }

    const attemptKey = [
      startDate.getTime(),
      this.getProjectionTeamCount(),
      this.getRequiredGamesPerCycle(),
    ].join(':');

    if (this.preDraftPreparationAttemptKey === attemptKey) {
      return;
    }

    this.preDraftPreparationAttemptKey = attemptKey;

    try {
      await this.prepareDraftData('pre-draft');

      if (!this.destroyed) {
        this.clearFirestoreRetry();
      }
    } catch (error: unknown) {
      if (this.isFirestoreResourceExhausted(error)) {
        throw error;
      }

      // The scheduled-start fallback will retry once the start time arrives.
    }
  }

  async maybeActivateDraft(): Promise<void> {
    const draft = this.draft();

    if (
      this.destroyed ||
      !draft ||
      draft.status !== 'scheduled' ||
      !isDraftStartTimeReached(draft) ||
      Date.now() < this.activationRetryNotBefore
    ) {
      return;
    }

    if (!this.isCommissioner()) {
      this.draftInjurySyncMessage.set(
        'Waiting for the commissioner to finish the shared pre-draft preparation and open the draft.',
      );
      return;
    }

    if (this.activationInProgress) {
      return;
    }

    this.activationInProgress = true;

    try {
      const snapshotReady = await this.loadFreshDraftSnapshotIfAvailable();

      if (this.destroyed) {
        return;
      }

      if (!snapshotReady) {
        await this.prepareDraftData('draft-start-fallback');
      }

      if (this.destroyed) {
        return;
      }

      const activatedDraft = await activateScheduledDraftIfReady(this.leagueId, this.userId);

      if (this.destroyed) {
        return;
      }

      this.clearFirestoreRetry();

      if (activatedDraft?.status === 'live') {
        this.draft.set(activatedDraft);
      }
    } catch (error: unknown) {
      if (this.destroyed) {
        return;
      }

      if (this.isFirestoreResourceExhausted(error)) {
        this.scheduleFirestoreRetry();
        return;
      }

      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to open the scheduled draft.',
      );
    } finally {
      this.activationInProgress = false;
    }
  }

  private getQueueForOwner(ownerId: string): DraftQueue {
    return (
      this.draftQueues().find((queue) => queue.ownerId === ownerId) ?? {
        ownerId,
        assetKeys: [],
        autoDraftEnabled: false,
        consecutiveClockExpirations: 0,
        autoDraftActivatedByTimeout: false,
      }
    );
  }

  isAssetQueued(asset: DraftableAsset): boolean {
    return this.myQueue().assetKeys.includes(asset.assetKey);
  }

  async toggleAssetInQueue(asset: DraftableAsset): Promise<void> {
    if (this.isAssetQueued(asset)) {
      await this.removeAssetFromQueue(asset.assetKey);
      return;
    }

    await this.addAssetToQueue(asset);
  }

  async addAssetToQueue(asset: DraftableAsset): Promise<void> {
    if (this.queueSaving() || this.isAssetQueued(asset) || this.draft()?.status === 'complete') {
      return;
    }

    await this.saveMyQueue([...this.myQueue().assetKeys, asset.assetKey]);
  }

  async removeAssetFromQueue(assetKey: string): Promise<void> {
    if (this.queueSaving()) {
      return;
    }

    await this.saveMyQueue(
      this.myQueue().assetKeys.filter((queuedAssetKey) => queuedAssetKey !== assetKey),
    );
  }

  async moveQueueAsset(assetKey: string, direction: -1 | 1): Promise<void> {
    if (this.queueSaving()) {
      return;
    }

    const assetKeys = [...this.myQueue().assetKeys];
    const currentIndex = assetKeys.indexOf(assetKey);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= assetKeys.length) {
      return;
    }

    [assetKeys[currentIndex], assetKeys[nextIndex]] = [
      assetKeys[nextIndex],
      assetKeys[currentIndex],
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
      await setDraftAutoDraftEnabled(this.leagueId, this.userId, !this.myQueue().autoDraftEnabled);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to update your auto-draft preference.',
      );
    } finally {
      this.queueSaving.set(false);
    }
  }

  async toggleCurrentOwnerAutoDraft(): Promise<void> {
    const ownerId = this.currentPick()?.ownerId;

    if (!ownerId || !this.isCommissioner() || this.queueSaving()) {
      return;
    }

    this.queueSaving.set(true);
    this.errorMessage.set('');

    try {
      await setDraftAutoDraftEnabled(
        this.leagueId,
        ownerId,
        !this.getQueueForOwner(ownerId).autoDraftEnabled,
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to update that manager’s auto-draft preference.',
      );
    } finally {
      this.queueSaving.set(false);
    }
  }

  canRepairSharedProjections(): boolean {
    const draft = this.draft();

    return Boolean(
      this.isCommissioner() &&
      draft?.status === 'live' &&
      draft.nextOverallPick === 1 &&
      draft.draftedAssetKeys.length === 0 &&
      this.picks().length === 0 &&
      !this.sharedProjectionRepairInProgress(),
    );
  }

  async repairSharedProjectionsForLiveDraft(): Promise<void> {
    const draft = this.draft();

    if (!draft || !this.canRepairSharedProjections()) {
      return;
    }

    this.sharedProjectionRepairInProgress.set(true);
    this.playerPoolLoading.set(true);
    this.playerPoolError.set('');
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      if (draft.clockStatus === 'running') {
        await pauseDraftClock(this.leagueId, this.userId);
      }

      const snapshot = await generateSharedProjectionSnapshot({
        leagueId: this.leagueId,
        teamCount: this.getProjectionTeamCount(),
        requiredGamesPerCycle: this.getRequiredGamesPerCycle(),
        generationReason: 'draft-start-fallback',
      });

      this.playerPool.set(snapshot.assets);
      this.successMessage.set(
        draft.clockStatus === 'running'
          ? 'Shared projections were rebuilt. The clock was paused so the commissioner can confirm the player pool before resuming.'
          : 'Shared projections were rebuilt. The first manager can start the clock when ready.',
      );
    } catch (error: unknown) {
      this.playerPoolError.set(
        error instanceof Error ? error.message : 'Unable to rebuild shared projections.',
      );
    } finally {
      this.playerPoolLoading.set(false);
      this.sharedProjectionRepairInProgress.set(false);
    }
  }

  async startMyDraftClock(): Promise<void> {
    const draft = this.draft();

    if (
      !draft ||
      draft.status !== 'live' ||
      draft.clockStatus !== 'stopped' ||
      !this.isMyTurn() ||
      this.clockActionInProgress() ||
      this.playerPoolLoading() ||
      this.playerPool().length === 0 ||
      Boolean(this.playerPoolError())
    ) {
      return;
    }

    this.clockActionInProgress.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      await startDraftClock(this.leagueId, this.userId);

      this.successMessage.set('The draft clock has started. You are on the clock.');
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to start the draft clock.',
      );
    } finally {
      this.clockActionInProgress.set(false);
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
        await resumeDraftClock(this.leagueId, this.userId);
      } else {
        await pauseDraftClock(this.leagueId, this.userId);
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to change the draft clock.',
      );
    } finally {
      this.clockActionInProgress.set(false);
    }
  }

  getCurrentPickTeamName(): string {
    const pick = this.currentPick();

    return pick ? this.getTeamName(pick.ownerId) : 'Updating Draft';
  }

  getCurrentPickNumberLabel(): string {
    const pick = this.currentPick();

    return pick ? `Pick #${pick.overallPick}` : 'Draft Clock';
  }

  getDraftClockStatusLabel(): string {
    const draft = this.draft();

    if (draft?.status === 'complete') {
      return 'Draft Complete';
    }

    if (draft?.clockStatus === 'stopped') {
      return this.isMyTurn()
        ? 'Start Clock When Ready'
        : `Waiting for ${this.getTeamName(this.currentPick()?.ownerId ?? '')} to Start`;
    }

    if (draft?.clockStatus === 'paused') {
      return 'Clock Paused';
    }

    if (this.currentOwnerAutoDraftEnabled()) {
      return 'Auto-Draft Active';
    }

    return this.isMyTurn()
      ? 'Your Pick'
      : `${this.getTeamName(this.currentPick()?.ownerId ?? '')} Picking`;
  }

  private async saveMyQueue(assetKeys: string[]): Promise<void> {
    this.queueSaving.set(true);
    this.errorMessage.set('');

    try {
      await saveDraftQueue(this.leagueId, this.userId, assetKeys, this.myQueue().autoDraftEnabled);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to update your draft queue.',
      );
    } finally {
      this.queueSaving.set(false);
    }
  }

  private isAssetEligibleForOwner(asset: DraftableAsset, ownerId: string): boolean {
    const draft = this.draft();

    if (!draft || draft.draftedAssetKeys.includes(asset.assetKey)) {
      return false;
    }

    return this.getDraftDestinationForAsset(ownerId, asset) !== null;
  }

  private ownerNeedsAnyStartingPosition(ownerId: string): boolean {
    return this.rosterPositions.some(
      (position) => !this.isStartingPositionFilled(ownerId, position),
    );
  }

  private getOwnerBenchRoles(ownerId: string): Set<AutoDraftBenchRole> {
    return new Set(
      this.picks()
        .filter((pick) => pick.ownerId === ownerId && this.isBenchDraftPick(pick))
        .map((pick) => getAutoDraftBenchRole(pick.asset.position)),
    );
  }

  private isAutomaticCandidateForCurrentRosterPhase(
    ownerId: string,
    asset: DraftableAsset,
    needsStarter: boolean,
    benchRoles: ReadonlySet<AutoDraftBenchRole>,
  ): boolean {
    return isAutomaticDraftCandidateAllowed({
      hasOpenStartingSlot: needsStarter,
      destination: this.getDraftDestinationForAsset(ownerId, asset),
      assetPosition: asset.position,
      existingBenchRoles: benchRoles,
    });
  }

  private getAutomaticDraftCandidate(ownerId: string): {
    asset: DraftableAsset;
    selectionType: 'queue' | 'automatic';
  } | null {
    const queue = this.getQueueForOwner(ownerId);
    const needsStarter = this.ownerNeedsAnyStartingPosition(ownerId);
    const benchRoles = this.getOwnerBenchRoles(ownerId);
    const assetsByKey = new Map<string, DraftableAsset>(
      this.playerPool().map((asset): [string, DraftableAsset] => [asset.assetKey, asset]),
    );
    const queuedCandidate = queue.assetKeys
      .map((assetKey) => assetsByKey.get(assetKey))
      .filter((asset): asset is DraftableAsset => !!asset)
      .find(
        (asset) =>
          this.isAssetEligibleForOwner(asset, ownerId) &&
          this.isAutomaticCandidateForCurrentRosterPhase(
            ownerId,
            asset,
            needsStarter,
            benchRoles,
          ),
      );

    if (queuedCandidate) {
      return { asset: queuedCandidate, selectionType: 'queue' };
    }

    const automaticCandidate = this.playerPool()
      .filter(
        (asset) =>
          this.isAssetEligibleForOwner(asset, ownerId) &&
          this.isAutomaticCandidateForCurrentRosterPhase(
            ownerId,
            asset,
            needsStarter,
            benchRoles,
          ),
      )
      .sort((first, second) => this.compareDraftValueThenProjection(first, second))[0];

    return automaticCandidate
      ? { asset: automaticCandidate, selectionType: 'automatic' }
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

    const ownerQueue = this.getQueueForOwner(currentPick.ownerId);

    const timerExpired = isDraftClockExpired(draft, new Date(this.now()));

    if (!timerExpired && !ownerQueue.autoDraftEnabled) {
      return;
    }

    const reason = ownerQueue.autoDraftEnabled ? 'manager-auto-mode' : 'timer-expired';

    const attemptKey = [currentPick.overallPick, currentPick.ownerId, reason].join(':');

    if (this.lastAutoPickAttemptKey === attemptKey) {
      return;
    }

    this.lastAutoPickAttemptKey = attemptKey;
    this.autoPickInProgress.set(true);
    this.errorMessage.set('');

    try {
      const candidate = this.getAutomaticDraftCandidate(currentPick.ownerId);

      if (!candidate) {
        await pauseDraftClock(this.leagueId, this.userId);

        throw new Error(
          'No eligible auto-draft asset could be found. The draft clock was paused for commissioner review.',
        );
      }

      const pick = await makeAutomaticDraftPick(
        this.leagueId,
        this.userId,
        currentPick.ownerId,
        candidate.asset,
        candidate.selectionType,
        reason,
      );

      const autoDraftWasForcedOn =
        reason === 'timer-expired' && ownerQueue.consecutiveClockExpirations >= 1;

      this.autoPickMessage.set(
        `${this.getTeamName(pick.ownerId)} auto-drafted ${this.getAssetName(pick.asset)} at pick #${pick.overallPick}.${
          autoDraftWasForcedOn
            ? ' Auto-draft is now enabled after two consecutive expired turns.'
            : ''
        }`,
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unable to process the automatic draft pick.';

      const staleAttempt =
        message.includes('no longer on the clock') ||
        message.includes('already been drafted') ||
        message.includes('timer has not expired');

      if (!staleAttempt) {
        this.errorMessage.set(message);
      }

      setTimeout(() => {
        if (this.lastAutoPickAttemptKey === attemptKey) {
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
    const validFilters: DraftFilter[] = ['ALL', 'LW', 'C', 'RW', 'D', 'G'];

    if (validFilters.includes(value as DraftFilter)) {
      this.positionFilter.set(value as DraftFilter);
    }
  }

  getMyAutoDraftButtonLabel(): string {
    const queue = this.myQueue();

    if (!queue.autoDraftEnabled) {
      return 'Auto-Draft Off';
    }

    return queue.autoDraftActivatedByTimeout ? 'Auto-Draft On · 2 Missed Turns' : 'Auto-Draft On';
  }

  getTimelineLogoUrl(pick: DraftPick): string | undefined {
    if (this.hasOffseasonTeamChange(pick.asset)) {
      return this.getNewTeamLogoUrl(pick.asset);
    }

    return this.getAssetLogoUrl(pick.asset);
  }

  private scheduleDraftTimelineScroll(): void {
    if (this.destroyed) {
      return;
    }

    requestAnimationFrame(() => {
      if (this.destroyed) {
        return;
      }

      const container = this.draftTimelineElement?.nativeElement;
      const draft = this.draft();

      if (!container || !draft) {
        return;
      }

      const targetOverallPick =
        this.currentPick()?.overallPick ??
        Math.min(getDraftTotalPickCount(draft), Math.max(1, draft.nextOverallPick - 1));
      const target = container.querySelector<HTMLElement>(
        `[data-pick-number="${targetOverallPick}"]`,
      );

      if (!target) {
        return;
      }

      const nextScrollLeft =
        target.offsetLeft - Math.max(0, (container.clientWidth - target.clientWidth) / 2);

      container.scrollTo({
        left: Math.max(0, nextScrollLeft),
        behavior: 'smooth',
      });
    });
  }

  getPickSelectionLabel(pick: DraftPick): string {
    return pick.selectionType && pick.selectionType !== 'manual' ? ' · Auto' : '';
  }

  getTeamName(ownerId: string): string {
    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.fullName : `${asset.teamName} Goalie Unit`;
  }

  getAssetTeamLabel(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  getAssetLogoUrl(asset: DraftableAsset): string | undefined {
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  }

  getDraftNews(asset: DraftableAsset): DraftPlayerNewsOverride | null {
    return getDraftNewsOverrideForAsset(asset);
  }

  hasDraftNews(asset: DraftableAsset): boolean {
    return Boolean(this.getDraftNews(asset)?.note);
  }

  hasOffseasonTeamChange(asset: DraftableAsset): boolean {
    const news = this.getDraftNews(asset);

    return Boolean(news?.previousTeamAbbreviation && this.getNewsNewTeamAbbreviation(asset));
  }

  getPreviousTeamAbbreviation(asset: DraftableAsset): string {
    return this.getDraftNews(asset)?.previousTeamAbbreviation ?? '';
  }

  getNewsNewTeamAbbreviation(asset: DraftableAsset): string {
    return this.getDraftNews(asset)?.newTeamAbbreviation ?? this.getAssetTeamLabel(asset);
  }

  getPreviousTeamLogoUrl(asset: DraftableAsset): string | undefined {
    const abbreviation = this.getPreviousTeamAbbreviation(asset);

    return abbreviation ? getDraftNewsTeamLogoUrl(abbreviation) : undefined;
  }

  getNewTeamLogoUrl(asset: DraftableAsset): string | undefined {
    const abbreviation = this.getNewsNewTeamAbbreviation(asset);

    return abbreviation ? getDraftNewsTeamLogoUrl(abbreviation) : undefined;
  }

  getPlayerAvailability(asset: DraftableAsset): PlayerAvailability | null {
    if (asset.assetType !== 'skater') {
      return null;
    }

    return getPlayerAvailabilityForPlayer(asset.player);
  }

  shouldShowPlayerAvailabilityBadge(asset: DraftableAsset): boolean {
    const availability = this.getPlayerAvailability(asset);

    return availability ? shouldDisplayPlayerAvailability(availability) : false;
  }

  getPlayerAvailabilityLabel(asset: DraftableAsset): string {
    return this.getPlayerAvailability(asset)?.shortLabel ?? '';
  }

  getPlayerAvailabilityClass(asset: DraftableAsset): string {
    const availability = this.getPlayerAvailability(asset);

    return availability ? getPlayerAvailabilityStatusClass(availability.status) : '';
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
        `${this.getPreviousTeamAbbreviation(asset)} → ${this.getNewsNewTeamAbbreviation(asset)}`,
      );
    }

    if (news.note) {
      details.push(news.note);
    }

    return details.join(' · ');
  }

  getPositionRequirement(position: DraftPosition): number {
    return this.draft()?.rosterRequirements[position] ?? 0;
  }

  getPositionCount(ownerId: string, position: DraftPosition): number {
    return this.picks().filter(
      (pick) => pick.ownerId === ownerId && pick.asset.position === position,
    ).length;
  }

  getStarterCount(ownerId: string, position: DraftPosition): number {
    return Math.min(this.getPositionCount(ownerId, position), this.getPositionRequirement(position));
  }

  getMyPositionCount(position: DraftPosition): number {
    return this.getPositionCount(this.userId, position);
  }

  getBenchCount(ownerId: string): number {
    const ownerPicks = this.picks().filter((pick) => pick.ownerId === ownerId);
    const hasDestinationData = ownerPicks.some((pick) => !!pick.rosterArea);

    if (hasDestinationData) {
      return ownerPicks.filter((pick) => pick.rosterArea === 'bench').length;
    }

    const starterCount = this.rosterPositions.reduce(
      (total, position) => total + this.getStarterCount(ownerId, position),
      0,
    );

    return Math.max(0, ownerPicks.length - starterCount);
  }

  getMyBenchCount(): number {
    return this.getBenchCount(this.userId);
  }

  getBenchRequirement(): number {
    return this.draft()?.benchSlots ?? 3;
  }

  getOpenBenchSlotCount(ownerId: string): number {
    return Math.max(0, this.getBenchRequirement() - this.getBenchCount(ownerId));
  }

  isStartingPositionFilled(ownerId: string, position: DraftPosition): boolean {
    return this.getStarterCount(ownerId, position) >= this.getPositionRequirement(position);
  }

  private isBenchSelectionReservedForStarters(
    ownerId: string,
    asset: DraftableAsset,
  ): boolean {
    if (!this.isStartingPositionFilled(ownerId, asset.position)) {
      return false;
    }

    const requirement = this.getPositionRequirement(asset.position);
    const missingStartingAssets = this.teams().reduce(
      (total, team) =>
        total + Math.max(0, requirement - this.getStarterCount(team.ownerId, asset.position)),
      0,
    );

    if (missingStartingAssets <= 0) {
      return false;
    }

    const draftedAssetKeys = new Set(this.picks().map((pick) => pick.asset.assetKey));
    const undraftedAtPosition = this.playerPool().filter(
      (candidate) =>
        candidate.position === asset.position && !draftedAssetKeys.has(candidate.assetKey),
    );

    // The full draft pool is normally available here. Keep a stable goalie-unit
    // fallback so the scarce position remains protected during a transient pool load.
    const availableBeforePick =
      undraftedAtPosition.length > 0
        ? undraftedAtPosition.length
        : asset.position === 'G'
          ? Math.max(
              0,
              32 - this.picks().filter((pick) => pick.asset.position === 'G').length,
            )
          : Number.POSITIVE_INFINITY;
    const candidateIsAvailable =
      availableBeforePick === Number.POSITIVE_INFINITY ||
      undraftedAtPosition.some((candidate) => candidate.assetKey === asset.assetKey) ||
      asset.position === 'G';
    const remainingAfterPick = candidateIsAvailable
      ? Math.max(0, availableBeforePick - 1)
      : availableBeforePick;

    return remainingAfterPick < missingStartingAssets;
  }

  getDraftDestinationForAsset(
    ownerId: string,
    asset: DraftableAsset,
  ): 'active' | 'bench' | null {
    if (!this.isStartingPositionFilled(ownerId, asset.position)) {
      return 'active';
    }

    if (this.getOpenBenchSlotCount(ownerId) <= 0) {
      return null;
    }

    if (this.isBenchSelectionReservedForStarters(ownerId, asset)) {
      return null;
    }

    return 'bench';
  }

  getRosterNeedClass(position: DraftPosition): string {
    if (!this.isStartingPositionFilled(this.userId, position)) {
      return 'need-open';
    }

    return this.getOpenBenchSlotCount(this.userId) > 0 ? 'need-bench' : 'need-full';
  }

  getRosterNeedLabel(position: DraftPosition): string {
    const starterCount = this.getStarterCount(this.userId, position);
    const requirement = this.getPositionRequirement(position);

    if (starterCount < requirement) {
      return `${starterCount}/${requirement} · ${requirement - starterCount} needed`;
    }

    return this.getOpenBenchSlotCount(this.userId) > 0
      ? `${starterCount}/${requirement} · next goes to bench`
      : `${starterCount}/${requirement} · bench full`;
  }

  canDraftAsset(asset: DraftableAsset): boolean {
    const draft = this.draft();

    if (
      !draft ||
      draft.status !== 'live' ||
      draft.clockStatus !== 'running' ||
      isDraftClockExpired(draft, new Date(this.now())) ||
      !this.isMyTurn()
    ) {
      return false;
    }

    return this.getDraftDestinationForAsset(this.userId, asset) !== null;
  }

  getDraftButtonLabel(asset: DraftableAsset): string {
    if (this.makingPickAssetKey() === asset.assetKey) {
      return 'Drafting...';
    }

    if (this.draft()?.clockStatus === 'stopped') {
      return this.isMyTurn() ? 'Start Clock First' : 'Waiting';
    }

    if (this.draft()?.clockStatus === 'paused') {
      return 'Paused';
    }

    if (this.draft() && isDraftClockExpired(this.draft(), new Date(this.now()))) {
      return 'Time Expired';
    }

    if (!this.isMyTurn()) {
      return 'Waiting';
    }

    const destination = this.getDraftDestinationForAsset(this.userId, asset);

    if (destination === 'bench') {
      return 'Draft to Bench';
    }

    if (!destination && this.isBenchSelectionReservedForStarters(this.userId, asset)) {
      return 'Reserved for Starter';
    }

    if (!destination) {
      return 'Position + Bench Full';
    }

    return 'Draft';
  }

  async selectAsset(asset: DraftableAsset): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    if (!this.canDraftAsset(asset)) {
      return;
    }

    this.makingPickAssetKey.set(asset.assetKey);

    try {
      const pick = await makeDraftPick(this.leagueId, this.userId, asset);

      this.successMessage.set(
        `${this.getAssetName(pick.asset)} was drafted at pick #${pick.overallPick}${pick.rosterArea === 'bench' ? ' to your bench' : ''}.`,
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to make this draft pick.',
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
      timeStyle: 'short',
    });
  }

  getCountdownText(): string {
    const startDate = this.draftStartDate();

    if (!startDate) {
      return 'Waiting for a scheduled start time.';
    }

    const millisecondsRemaining = startDate.getTime() - this.now();

    if (millisecondsRemaining <= 0) {
      return 'Opening the draft...';
    }

    const totalSeconds = Math.floor(millisecondsRemaining / 1000);

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m remaining`;
    }

    return `${hours}h ${minutes}m ${seconds}s remaining`;
  }
}
