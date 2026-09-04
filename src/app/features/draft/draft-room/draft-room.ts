import { Component, computed, ElementRef, HostListener, OnDestroy, signal, ViewChild } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';
import {
  isOperationDeadlineError,
  settleOperationWithin,
  withOperationDeadline,
} from '../../../core/async/bounded-operation.util';
import { getFantasyTeamProfileIconId } from '../../../core/team/team.service';
import { ReleaseUpdateService } from '../../../core/release/release-update.service';
import { auth } from '../../../core/firebase';
import {
  CompetitiveActionMonitorService,
  type CompetitiveActionHandle,
} from '../../../core/observability/competitive-action-monitor.service';

import { repairDraftTurnHandoff } from '../../../core/draft/draft-authority.service';
import {
  getDraftLobbyOpenDate,
  getDraftLobbyState,
} from '../../../core/draft/draft-lobby.util';

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
  getDraftPickFromServer,
  getDraftTotalPickCount,
  getFantasyDraftFromServer,
  getScheduledStartDate,
  isDraftClockExpired,
  isDraftStartTimeReached,
  listenToDraftPicks,
  listenToDraftQueue,
  listenToDraftQueues,
  listenToFantasyDraft,
  makeDraftPick,
  pauseDraftClock,
  resumeDraftClock,
  saveDraftQueue,
  setDraftAutoDraftEnabled,
  startDraftClock,
  DraftRealtimeSnapshotState,
} from '../../../core/draft/draft.service';

import {
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotById,
  PRE_DRAFT_PROJECTION_WARMUP_MINUTES,
  PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
  SHARED_PROJECTION_VERSION,
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
  startPlayerAvailabilityListenerForLeague,
} from '../../../core/player/player-availability.service';

import {
  listenToPlayerAvailabilitySyncState,
} from '../../../core/player/player-availability-sync.service';

import { getLeagueById, League } from '../../../core/league/league.service';
import { shareLeagueDraftCard } from '../../../core/league/league-draft-share-card.service';

import { FantasyTeam, getFantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

import {
  DraftAutoPickExplanation,
  DraftMobilePanel,
  DraftRealtimeConnectionState,
  getDraftAutoPickExplanation,
  getLatestUndismissedAutoPick,
  getDraftConnectionStatusDetail,
  getDraftConnectionStatusLabel,
  resolveDraftRealtimeConnectionState,
} from './draft-mobile-resilience.util';

import {
  assessDraftTurnHandoff,
  type DraftTurnHandoffAssessment,
} from './draft-turn-handoff.util';
import {
  resolveDraftAssetPortrait,
  type DraftAssetPortrait,
} from './draft-asset-portrait.util';

import {
  draftPickMatchesPending,
  draftStateShowsPendingPickCommitted,
  mergeConfirmedDraftPick,
  type PendingDraftPickIdentity,
} from './draft-pick-confirmation.util';
import {
  DraftPlayerAvailabilityDisplay,
  getDraftPlayerAvailabilityDisplay,
} from './draft-player-availability.util';
import { matchesDraftPlayerSearch } from './draft-player-search.util';

const DRAFT_INITIAL_LOAD_RECOVERY_DELAY_MILLISECONDS = 8_000;
const DRAFT_PROJECTION_LOAD_SLOW_DELAY_MILLISECONDS = 4_000;

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
  | 'PROJECTED_CYCLE'
  | 'PROJECTED_SEASON'
  | 'NAME'
  | 'POSITION'
  | 'TEAM';

interface DraftTimelineEntry {
  preview: DraftPickPreview;
  pick: DraftPick | null;
}

interface DraftQueueEntryView {
  assetKey: string;
  asset: DraftableAsset | null;
  index: number;
  unavailableReason: string | null;
  available: boolean;
}

interface PendingPickConfirmation extends PendingDraftPickIdentity {
  submissionId: string;
  requestId: number;
  assetName: string;
  startedAt: number;
}

@Component({
  selector: 'app-draft-room',
  imports: [FormsModule, RouterLink, ManagerAvatar],
  templateUrl: './draft-room.html',
  styleUrls: ['./draft-room.css', './draft-room-recovery.css'],
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
  draftLoadRecoveryVisible = signal(false);
  playerPoolLoading = signal(false);
  projectionLoadSlow = signal(false);
  makingPickAssetKey = signal<string | null>(null);
  isCommissioner = signal(false);
  queueSaving = signal(false);
  clockActionInProgress = signal(false);

  errorMessage = signal('');
  successMessage = signal('');
  playerPoolError = signal('');

  draftShareInProgress = signal(false);
  draftShareStatusMessage = signal('');
  draftShareErrorMessage = signal('');

  searchTerm = signal('');
  positionFilter = signal<DraftFilter>('ALL');
  sortMode = signal<PlayerPoolSort>('DRAFT_VALUE');
  now = signal(Date.now());

  mobilePanel = signal<DraftMobilePanel>('players');
  selectedAssetKey = signal<string | null>(null);
  pickSubmissionPhase = signal<'idle' | 'submitting' | 'confirming'>('idle');
  browserOnline = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  draftServerSyncAt = signal<number | null>(null);
  picksServerSyncAt = signal<number | null>(null);
  queueServerSyncAt = signal<number | null>(null);
  realtimeConfirmationStartedAt = signal<number | null>(Date.now());
  realtimeReconnectReason = signal<
    'initial' | 'online' | 'resume' | 'listener-error' | 'manual' | null
  >('initial');
  realtimeListenerError = signal<string | null>(null);
  dismissedAutoPickOverall = signal(0);
  autoPickNoticePick = signal<DraftPick | null>(null);
  draftBoardListenerError = signal<string | null>(null);
  draftQueueListenerError = signal<string | null>(null);
  draftHandoffRepairInProgress = signal(false);
  draftHandoffMessage = signal('');
  draftHandoffError = signal('');
  failedDraftImageUrls = signal<ReadonlySet<string>>(new Set());

  readonly rosterPositions: DraftPosition[] = ['LW', 'C', 'RW', 'D', 'G'];
  setSortMode(value: string): void {
    const validSorts: PlayerPoolSort[] = [
      'DRAFT_VALUE',
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
  private hiddenAt: number | null = null;
  private pendingPickConfirmation: PendingPickConfirmation | null = null;
  private pendingPickConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPickProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPickServerProbeInProgress = false;
  private pendingPickRequestCounter = 0;
  private pendingPickAction: CompetitiveActionHandle | null = null;
  private realtimeRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private draftHandoffCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private initialLoadRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private projectionLoadSlowTimer: ReturnType<typeof setTimeout> | null = null;
  private playerPoolRequestId = 0;
  private draftHandoffAttemptedAt = 0;
  private lastDraftHandoffAttemptKey = '';
  private readonly handleBrowserOnline = () => {
    this.browserOnline.set(true);
    this.requestRealtimeConfirmation('online');
  };
  private readonly handleBrowserOffline = () => {
    this.browserOnline.set(false);
    this.draftBoardListenerError.set(null);
    this.draftQueueListenerError.set(null);
    this.realtimeListenerError.set(null);
  };
  private readonly handleVisibilityChange = () => {
    if (typeof document === 'undefined') {
      return;
    }

    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      return;
    }

    const hiddenDuration = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;

    if (hiddenDuration >= 10_000) {
      this.requestRealtimeConfirmation('resume');
    }
  };
  private scheduledDraftCheckInProgress = false;
  private destroyed = false;
  private activationFailureCount = 0;
  private activationRetryNotBefore = 0;
  private lastObservedDraftStatus: FantasyDraft['status'] | null = null;

  private readonly clockTimer = setInterval(() => {
    if (this.destroyed) {
      return;
    }

    this.now.set(Date.now());
  }, 1000);

  private readonly scheduledDraftCheckTimer = setInterval(() => {
    void this.runScheduledDraftChecks();
  }, 5000);

  readonly currentPick = computed<DraftPickPreview | null>(() => getCurrentDraftPick(this.draft()));

  readonly myQueue = computed<DraftQueue>(() => this.getQueueForOwner(this.userId));

  readonly queueEntries = computed<DraftQueueEntryView[]>(() => {
    const draftedAssetKeys = new Set(this.draft()?.draftedAssetKeys ?? []);
    const assetsByKey = new Map(this.playerPool().map((asset) => [asset.assetKey, asset]));

    return this.myQueue().assetKeys.map((assetKey, index) => {
      const asset = assetsByKey.get(assetKey) ?? null;
      const unavailableReason = asset
        ? this.getQueueEntryUnavailableReason(asset, draftedAssetKeys.has(assetKey))
        : 'Player data is unavailable. Remove this entry and add it again.';

      return {
        assetKey,
        asset,
        index,
        unavailableReason,
        available: unavailableReason === null,
      };
    });
  });

  readonly queueAssets = computed(() =>
    this.queueEntries()
      .filter((entry) => entry.available && entry.asset !== null)
      .map((entry) => entry.asset as DraftableAsset),
  );

  readonly selectedAsset = computed(() => {
    const assetKey = this.selectedAssetKey();

    if (!assetKey) {
      return null;
    }

    const draftedAssetKeys = new Set(this.draft()?.draftedAssetKeys ?? []);

    if (draftedAssetKeys.has(assetKey)) {
      return null;
    }

    return this.playerPool().find((asset) => asset.assetKey === assetKey) ?? null;
  });

  readonly draftTurnHandoff = computed<DraftTurnHandoffAssessment>(() =>
    assessDraftTurnHandoff(
      this.draft(),
      this.picks(),
      this.teams().map((team) => team.ownerId),
    ),
  );

  readonly draftBoardConnectionState = computed<DraftRealtimeConnectionState>(() =>
    resolveDraftRealtimeConnectionState({
      online: this.browserOnline(),
      confirmationStartedAt: this.realtimeConfirmationStartedAt(),
      criticalServerSyncTimes: [
        this.draftServerSyncAt(),
        this.picksServerSyncAt(),
      ],
      listenerError: this.draftBoardListenerError(),
      reconnectReason: this.realtimeReconnectReason(),
      now: this.now(),
    }),
  );

  readonly realtimeConnectionState = computed<DraftRealtimeConnectionState>(() =>
    resolveDraftRealtimeConnectionState({
      online: this.browserOnline(),
      confirmationStartedAt: this.realtimeConfirmationStartedAt(),
      criticalServerSyncTimes: [
        this.draftServerSyncAt(),
        this.picksServerSyncAt(),
        this.queueServerSyncAt(),
      ],
      listenerError: this.realtimeListenerError(),
      reconnectReason: this.realtimeReconnectReason(),
      now: this.now(),
    }),
  );

  readonly canUseDraftBoardActions = computed(
    () =>
      this.draftBoardConnectionState() === 'connected' &&
      this.pickSubmissionPhase() === 'idle' &&
      !this.releaseUpdate.updateAvailable() &&
      !this.draftHandoffRepairInProgress() &&
      this.draftTurnHandoff().status === 'healthy',
  );

  readonly draftLobbyState = computed(() =>
    getDraftLobbyState({
      draftStatus: this.draft()?.status,
      scheduledStart: getScheduledStartDate(this.draft()),
      now: new Date(this.now()),
    }),
  );

  readonly isDraftLobbyOpen = computed(() => this.draftLobbyState() === 'open');

  readonly canUseDraftQueueActions = computed(
    () => {
      const draft = this.draft();
      const queuePhaseAllowsWrites = draft?.status === 'live' || this.isDraftLobbyOpen();
      const liveTurnIsReady =
        draft?.status !== 'live' || this.draftTurnHandoff().status === 'healthy';

      return (
        queuePhaseAllowsWrites &&
        this.realtimeConnectionState() === 'connected' &&
        this.pickSubmissionPhase() === 'idle' &&
        !this.releaseUpdate.updateAvailable() &&
        !this.draftHandoffRepairInProgress() &&
        liveTurnIsReady
      );
    },
  );

  // Existing templates and draft-button helpers use this name. Drafting now
  // depends only on the authoritative board listeners; a slow private queue
  // listener cannot freeze the next manager's turn.
  readonly canUseLiveDraftActions = computed(() => this.canUseDraftBoardActions());

  readonly latestAutoPickNotice = computed<DraftAutoPickExplanation | null>(() => {
    const latestPick = this.autoPickNoticePick();

    if (!latestPick) {
      return null;
    }

    return getDraftAutoPickExplanation(
      latestPick,
      this.getAssetName(latestPick.asset),
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

  readonly draftLobbyOpenDate = computed(() =>
    getDraftLobbyOpenDate(this.draftStartDate()),
  );

  readonly startTimeReached = computed(() =>
    isDraftStartTimeReached(this.draft(), new Date(this.now())),
  );

  readonly isMyTurn = computed(() => this.currentPick()?.ownerId === this.userId);

  readonly totalPickCount = computed(() => getDraftTotalPickCount(this.draft()));

  readonly myCompletedDraftPicks = computed(() =>
    [...this.picks()]
      .filter((pick) => pick.ownerId === this.userId)
      .sort((first, second) => first.overallPick - second.overallPick),
  );

  readonly canShareCompletedDraft = computed(() =>
    this.draft()?.status === 'complete' &&
    this.myCompletedDraftPicks().length > 0 &&
    Boolean(this.teams().find((team) => team.ownerId === this.userId)),
  );

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
    const search = this.searchTerm();
    const positionFilter = this.positionFilter();

    return this.playerPool()
      .filter((asset) => !draftedAssetKeys.has(asset.assetKey))
      .filter((asset) => (positionFilter === 'ALL' ? true : asset.position === positionFilter))
      .filter((asset) => matchesDraftPlayerSearch(search, [
        this.getAssetName(asset),
        this.getAssetTeamLabel(asset),
        this.getPreviousTeamAbbreviation(asset),
        this.getNewsNewTeamAbbreviation(asset),
      ]))
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
    private readonly actionMonitor: CompetitiveActionMonitorService,
    private readonly releaseUpdate: ReleaseUpdateService,
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleBrowserOnline);
      window.addEventListener('offline', this.handleBrowserOffline);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.initialLoadRecoveryTimer = setTimeout(() => {
      this.initialLoadRecoveryTimer = null;

      if (!this.destroyed && this.loading()) {
        this.draftLoadRecoveryVisible.set(true);
      }
    }, DRAFT_INITIAL_LOAD_RECOVERY_DELAY_MILLISECONDS);

    void this.loadDraftRoom();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.clockTimer);
    clearInterval(this.scheduledDraftCheckTimer);

    if (this.pendingPickConfirmationTimer) {
      clearTimeout(this.pendingPickConfirmationTimer);
    }

    if (this.pendingPickProbeTimer) {
      clearTimeout(this.pendingPickProbeTimer);
    }

    this.pendingPickAction?.finish('cancelled');
    this.pendingPickAction = null;

    if (this.realtimeRestartTimer) {
      clearTimeout(this.realtimeRestartTimer);
    }

    if (this.draftHandoffCheckTimer) {
      clearTimeout(this.draftHandoffCheckTimer);
    }

    if (this.initialLoadRecoveryTimer) {
      clearTimeout(this.initialLoadRecoveryTimer);
      this.initialLoadRecoveryTimer = null;
    }

    this.playerPoolRequestId += 1;

    if (this.projectionLoadSlowTimer) {
      clearTimeout(this.projectionLoadSlowTimer);
      this.projectionLoadSlowTimer = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleBrowserOnline);
      window.removeEventListener('offline', this.handleBrowserOffline);
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.stopDraftListener?.();
    this.stopPickListener?.();
    this.stopInjurySyncListener?.();
    this.stopQueueListener?.();
  }

  reloadDraftRoom(): void {
    if (typeof window !== 'undefined') {
      window.location.reload();
      return;
    }

    this.draftLoadRecoveryVisible.set(false);
    void this.loadDraftRoom();
  }

  canLeaveDraftRoom(): boolean {
    // Once the secure callable has accepted the pick, only the local board is
    // catching up. Leaving at that point cannot duplicate or undo the server
    // transaction, so only the actual submission phase blocks navigation.
    return this.pickSubmissionPhase() !== 'submitting';
  }

  @HostListener('window:beforeunload', ['$event'])
  preventWindowExitDuringPick(event: BeforeUnloadEvent): void {
    if (this.canLeaveDraftRoom()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  }

  getMyDraftedCount(): number {
    return this.picks().filter((pick) => pick.ownerId === this.userId).length;
  }

  getMyRosterSlotTotal(): number {
    const starterTotal = this.rosterPositions.reduce(
      (total, position) => total + this.getPositionRequirement(position),
      0,
    );

    return starterTotal + this.getBenchRequirement();
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

      this.stopInjurySyncListener?.();
      this.stopInjurySyncListener = listenToPlayerAvailabilitySyncState(leagueId, (state) => {
        if (!this.destroyed) {
          this.injurySyncState.set(state);
        }
      });

      this.startRealtimeDraftListeners();

      // The board, clock, teams, queue, and live Draft listeners are useful
      // without rankings. Release the page as soon as those core systems are
      // connected, then let the immutable projection snapshot load inside its
      // own panel.
      this.finishInitialDraftRoomLoading();
      void this.loadPlayerPool();
      void this.runScheduledDraftChecks();
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.errorMessage.set(
          error instanceof Error ? error.message : 'Unable to load the draft room.',
        );
      }
    } finally {
      this.finishInitialDraftRoomLoading();
    }
  }

  private finishInitialDraftRoomLoading(): void {
    if (this.initialLoadRecoveryTimer) {
      clearTimeout(this.initialLoadRecoveryTimer);
      this.initialLoadRecoveryTimer = null;
    }

    if (this.destroyed) {
      return;
    }

    this.loading.set(false);
    this.draftLoadRecoveryVisible.set(false);
    this.scheduleDraftTimelineScroll();
  }

  private startRealtimeDraftListeners(): void {
    if (!this.leagueId || !this.userId || this.destroyed) {
      return;
    }

    this.stopDraftListener?.();
    this.stopPickListener?.();
    this.stopQueueListener?.();

    const leagueId = this.leagueId;
    const userId = this.userId;

    if (this.isCommissioner()) {
      this.stopQueueListener = listenToDraftQueues(
        leagueId,
        (queues) => {
          if (!this.destroyed) {
            this.draftQueues.set(queues);
          }
        },
        (error) => this.handleRealtimeListenerError('queue', error),
        (state) => this.handleRealtimeSnapshotState('queue', state),
      );
    } else {
      this.stopQueueListener = listenToDraftQueue(
        leagueId,
        userId,
        (queue) => {
          if (!this.destroyed) {
            this.draftQueues.set([queue]);
          }
        },
        (error) => this.handleRealtimeListenerError('queue', error),
        (state) => this.handleRealtimeSnapshotState('queue', state),
      );
    }

    this.stopDraftListener = listenToFantasyDraft(
      leagueId,
      (draft) => {
        if (this.destroyed) {
          return;
        }

        const previousStatus = this.lastObservedDraftStatus;
        this.lastObservedDraftStatus = draft?.status ?? null;
        this.draft.set(draft);
        this.scheduleDraftTurnHandoffCheck();
        this.confirmPendingPickIfObserved();
        this.clearSelectedAssetIfUnavailable();
        this.scheduleDraftTimelineScroll();

        if (draft?.status === 'live' && previousStatus !== null && previousStatus !== 'live') {
          // The commissioner creates the final frozen snapshot immediately
          // before activating the draft. Reload once on the scheduled-to-live
          // transition so managers who entered early do not keep an older
          // pre-draft snapshot.
          void this.loadPlayerPool();
        }

        void this.runScheduledDraftChecks();
      },
      (error) => this.handleRealtimeListenerError('draft', error),
      (state) => this.handleRealtimeSnapshotState('draft', state),
    );

    this.stopPickListener = listenToDraftPicks(
      leagueId,
      (picks) => {
        if (!this.destroyed) {
          this.picks.set(picks);
          this.scheduleDraftTurnHandoffCheck();
          this.updateAutoPickNotice(picks);
          this.confirmPendingPickIfObserved();
          this.clearSelectedAssetIfUnavailable();
          this.scheduleDraftTimelineScroll();
        }
      },
      (error) => this.handleRealtimeListenerError('picks', error),
      (state) => this.handleRealtimeSnapshotState('picks', state),
    );
  }

  private handleRealtimeSnapshotState(
    source: 'draft' | 'picks' | 'queue',
    state: DraftRealtimeSnapshotState,
  ): void {
    if (this.destroyed || state.fromCache || state.hasPendingWrites) {
      return;
    }

    if (source === 'draft') {
      this.draftServerSyncAt.set(state.receivedAt);
    } else if (source === 'picks') {
      this.picksServerSyncAt.set(state.receivedAt);
    } else {
      this.queueServerSyncAt.set(state.receivedAt);
      this.draftQueueListenerError.set(null);
    }

    const confirmationStartedAt = this.realtimeConfirmationStartedAt();
    const boardConfirmed = [
      this.draftServerSyncAt(),
      this.picksServerSyncAt(),
    ].every(
      (syncedAt) =>
        syncedAt !== null &&
        (confirmationStartedAt === null || syncedAt >= confirmationStartedAt),
    );

    if (boardConfirmed) {
      this.draftBoardListenerError.set(null);
    }

    const allConfirmed = boardConfirmed && [this.queueServerSyncAt()].every(
      (syncedAt) =>
        syncedAt !== null &&
        (confirmationStartedAt === null || syncedAt >= confirmationStartedAt),
    );

    this.refreshRealtimeListenerErrorState();

    if (allConfirmed) {
      this.realtimeReconnectReason.set(null);
    }
  }

  private refreshRealtimeListenerErrorState(): void {
    this.realtimeListenerError.set(
      this.draftBoardListenerError() ?? this.draftQueueListenerError(),
    );
  }

  private handleRealtimeListenerError(
    source: 'draft' | 'picks' | 'queue',
    error: Error,
  ): void {
    if (this.destroyed) {
      return;
    }

    const message =
      `${source === 'draft' ? 'Draft' : source === 'picks' ? 'Pick' : 'Queue'} connection: ${error.message}`;

    if (source === 'queue') {
      this.draftQueueListenerError.set(message);
    } else {
      this.draftBoardListenerError.set(message);
    }

    this.refreshRealtimeListenerErrorState();
    this.realtimeConfirmationStartedAt.set(Date.now());
    this.realtimeReconnectReason.set('listener-error');

    if (this.browserOnline()) {
      this.scheduleRealtimeListenerRestart(1800);
    }
  }

  private scheduleRealtimeListenerRestart(delayMilliseconds: number): void {
    if (this.realtimeRestartTimer) {
      clearTimeout(this.realtimeRestartTimer);
    }

    this.realtimeRestartTimer = setTimeout(() => {
      this.realtimeRestartTimer = null;

      if (!this.destroyed && this.browserOnline()) {
        this.startRealtimeDraftListeners();
      }
    }, delayMilliseconds);
  }

  private requestRealtimeConfirmation(
    reason: 'online' | 'resume' | 'manual',
  ): void {
    if (this.destroyed || !this.leagueId || !this.userId) {
      return;
    }

    this.realtimeConfirmationStartedAt.set(Date.now());
    this.realtimeReconnectReason.set(reason);
    this.draftBoardListenerError.set(null);
    this.draftQueueListenerError.set(null);
    this.realtimeListenerError.set(null);

    if (this.browserOnline()) {
      this.scheduleRealtimeListenerRestart(60);
      this.scheduleDraftTurnHandoffCheck(500);
    }
  }

  retryRealtimeConnection(): void {
    if (typeof navigator !== 'undefined') {
      this.browserOnline.set(navigator.onLine);
    }

    if (!this.browserOnline()) {
      return;
    }

    this.requestRealtimeConfirmation('manual');
  }

  getRealtimeConnectionLabel(): string {
    if (
      this.draftBoardConnectionState() === 'connected' &&
      this.realtimeConnectionState() !== 'connected'
    ) {
      return 'Draft Board Connected';
    }

    return getDraftConnectionStatusLabel(this.realtimeConnectionState());
  }

  getRealtimeConnectionDetail(): string {
    if (
      this.draftBoardConnectionState() === 'connected' &&
      this.realtimeConnectionState() !== 'connected'
    ) {
      if (this.isDraftLobbyOpen()) {
        return 'The Draft board is current. Your private queue is still syncing; picks and the draft clock remain locked until the scheduled start.';
      }

      return 'The live turn and picks are current. Your private queue is still syncing; drafting remains available.';
    }

    return this.realtimeListenerError() ||
      getDraftConnectionStatusDetail(
        this.realtimeConnectionState(),
        this.isDraftLobbyOpen() ? 'lobby' : 'live',
      );
  }

  getRealtimeConnectionClass(): string {
    if (this.draftBoardConnectionState() === 'connected') {
      return 'draft-connection-connected';
    }

    return `draft-connection-${this.realtimeConnectionState()}`;
  }

  getLastServerConfirmationLabel(): string {
    const boardSyncTimes = [
      this.draftServerSyncAt(),
      this.picksServerSyncAt(),
    ].filter((value): value is number => value !== null);

    if (boardSyncTimes.length < 2) {
      return 'Waiting for draft-board confirmation';
    }

    const secondsAgo = Math.max(
      0,
      Math.floor((this.now() - Math.min(...boardSyncTimes)) / 1000),
    );
    const freshness = secondsAgo < 2
      ? 'Draft board confirmed now'
      : secondsAgo < 60
        ? `Draft board confirmed ${secondsAgo}s ago`
        : `Draft board confirmed ${Math.floor(secondsAgo / 60)}m ago`;

    return this.realtimeConnectionState() === 'connected'
      ? freshness
      : `${freshness} · queue syncing`;
  }

  shouldShowDraftHandoffNotice(): boolean {
    const assessment = this.draftTurnHandoff();

    return (
      this.draftHandoffRepairInProgress() ||
      Boolean(this.draftHandoffError()) ||
      (
        this.draft()?.status === 'live' &&
        assessment.status !== 'healthy' &&
        assessment.status !== 'inactive' &&
        !(assessment.status === 'complete' && !assessment.requiresServerRepair)
      )
    );
  }

  getDraftHandoffTitle(): string {
    if (this.draftHandoffError()) {
      return 'Draft turn needs attention';
    }

    if (this.draftTurnHandoff().status === 'draft-ahead') {
      return 'Refreshing the completed pick';
    }

    return 'Opening the next pick';
  }

  getDraftHandoffDetail(): string {
    return this.draftHandoffError() ||
      this.draftHandoffMessage() ||
      this.draftTurnHandoff().message;
  }

  private scheduleDraftTurnHandoffCheck(delayMilliseconds = 850): void {
    if (this.draftHandoffCheckTimer) {
      clearTimeout(this.draftHandoffCheckTimer);
      this.draftHandoffCheckTimer = null;
    }

    const assessment = this.draftTurnHandoff();

    if (
      assessment.status === 'healthy' ||
      assessment.status === 'inactive' ||
      (assessment.status === 'complete' && !assessment.requiresServerRepair)
    ) {
      this.draftHandoffMessage.set('');
      this.draftHandoffError.set('');
      this.lastDraftHandoffAttemptKey = '';
      return;
    }

    this.draftHandoffMessage.set(assessment.message);

    if (
      this.destroyed ||
      !this.browserOnline() ||
      !this.leagueId ||
      this.pickSubmissionPhase() !== 'idle' ||
      this.draftHandoffRepairInProgress()
    ) {
      return;
    }

    this.draftHandoffCheckTimer = setTimeout(() => {
      this.draftHandoffCheckTimer = null;
      void this.reconcileDraftTurnHandoff();
    }, Math.max(250, delayMilliseconds));
  }

  async retryDraftTurnHandoff(): Promise<void> {
    await this.reconcileDraftTurnHandoff(true);
  }

  private getDraftHandoffAttemptKey(assessment: DraftTurnHandoffAssessment): string {
    const draft = this.draft();

    return [
      assessment.status,
      assessment.expectedNextOverallPick,
      assessment.lastContiguousOverallPick,
      draft?.nextOverallPick ?? 0,
      draft?.clockStatus ?? 'none',
    ].join(':');
  }

  private async reconcileDraftTurnHandoff(force = false): Promise<void> {
    if (
      this.destroyed ||
      !this.browserOnline() ||
      !this.leagueId ||
      this.pickSubmissionPhase() !== 'idle' ||
      this.draftHandoffRepairInProgress()
    ) {
      return;
    }

    let assessment = this.draftTurnHandoff();

    if (
      assessment.status === 'healthy' ||
      assessment.status === 'inactive' ||
      (assessment.status === 'complete' && !assessment.requiresServerRepair)
    ) {
      this.draftHandoffMessage.set('');
      this.draftHandoffError.set('');
      return;
    }

    const attemptKey = this.getDraftHandoffAttemptKey(assessment);
    const now = Date.now();

    if (
      !force &&
      attemptKey === this.lastDraftHandoffAttemptKey &&
      now - this.draftHandoffAttemptedAt < 10_000
    ) {
      return;
    }

    this.lastDraftHandoffAttemptKey = attemptKey;
    this.draftHandoffAttemptedAt = now;
    this.draftHandoffRepairInProgress.set(true);
    this.draftHandoffError.set('');
    this.draftHandoffMessage.set(assessment.message);

    try {
      const serverDraftResult = await settleOperationWithin(
        getFantasyDraftFromServer(this.leagueId),
        7_000,
      );

      if (serverDraftResult.status === 'fulfilled' && serverDraftResult.value) {
        this.draft.set(serverDraftResult.value);
      }

      if (assessment.status === 'owner-missing') {
        const teamsResult = await settleOperationWithin(
          getLeagueTeams(this.leagueId),
          7_000,
        );

        if (teamsResult.status === 'fulfilled') {
          this.teams.set(teamsResult.value);
        }
      }

      assessment = this.draftTurnHandoff();

      if (assessment.status === 'draft-ahead') {
        this.draftHandoffMessage.set(
          'The server already opened the next turn. RinkRat is refreshing the ordered pick list before enabling another selection.',
        );
        this.requestRealtimeConfirmation('manual');
        return;
      }

      if (assessment.requiresServerRepair) {
        const repairResult = await settleOperationWithin(
          repairDraftTurnHandoff(this.leagueId),
          22_000,
        );

        if (repairResult.status === 'timed-out') {
          throw new Error(
            'The turn-repair request is still reconciling. Use Retry Turn Sync if the next manager is not opened shortly.',
          );
        }

        if (repairResult.status === 'rejected') {
          throw repairResult.error;
        }

        this.draftHandoffMessage.set(repairResult.value.message);
      }

      const refreshedDraftResult = await settleOperationWithin(
        getFantasyDraftFromServer(this.leagueId),
        7_000,
      );

      if (refreshedDraftResult.status === 'fulfilled' && refreshedDraftResult.value) {
        this.draft.set(refreshedDraftResult.value);
      }

      this.requestRealtimeConfirmation('manual');
      assessment = this.draftTurnHandoff();

      if (
        assessment.status === 'healthy' ||
        (assessment.status === 'complete' && !assessment.requiresServerRepair)
      ) {
        this.draftHandoffError.set('');
        this.draftHandoffMessage.set('The next draft turn is open.');
      } else {
        this.draftHandoffMessage.set(assessment.message);
      }
    } catch (error: unknown) {
      this.draftHandoffError.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not verify the next draft turn.',
      );
      this.requestRealtimeConfirmation('manual');
    } finally {
      this.draftHandoffRepairInProgress.set(false);
    }
  }

  setMobilePanel(panel: DraftMobilePanel): void {
    this.mobilePanel.set(panel);
  }

  selectAssetForMobile(asset: DraftableAsset): void {
    if ((this.draft()?.draftedAssetKeys ?? []).includes(asset.assetKey)) {
      return;
    }

    this.selectedAssetKey.set(
      this.selectedAssetKey() === asset.assetKey ? null : asset.assetKey,
    );
  }

  clearSelectedAsset(): void {
    this.selectedAssetKey.set(null);
  }

  private clearSelectedAssetIfUnavailable(): void {
    const selectedAssetKey = this.selectedAssetKey();

    if (!selectedAssetKey) {
      return;
    }

    if ((this.draft()?.draftedAssetKeys ?? []).includes(selectedAssetKey)) {
      this.selectedAssetKey.set(null);
    }
  }

  getSelectedAssetDestinationLabel(): string {
    const asset = this.selectedAsset();

    if (!asset) {
      return '';
    }

    const destination = this.getDraftDestinationForAsset(this.userId, asset);

    if (destination === 'bench') {
      return 'Will fill an open bench spot';
    }

    if (destination === 'active') {
      return `Will fill an open ${asset.position} starter spot`;
    }

    return this.getDraftButtonLabel(asset);
  }

  async draftSelectedAsset(): Promise<void> {
    const asset = this.selectedAsset();

    if (asset) {
      await this.selectAsset(asset);
    }
  }

  dismissLatestAutoPickNotice(): void {
    const latestPick = this.autoPickNoticePick();

    if (!latestPick) {
      return;
    }

    this.dismissedAutoPickOverall.set(latestPick.overallPick);
    this.autoPickNoticePick.set(null);
    this.writeDismissedAutoPickOverall(latestPick.overallPick);
  }

  private updateAutoPickNotice(picks: DraftPick[]): void {
    let dismissedOverall = this.readDismissedAutoPickOverall();
    const highestOverallPick = picks.reduce(
      (highest, pick) => Math.max(highest, pick.overallPick),
      0,
    );

    // A commissioner may reset a test draft in the same league. When the new
    // pick collection starts below the old dismissed pick number, discard the
    // previous draft's local notice state so a new automatic selection is not hidden.
    if (picks.length > 0 && highestOverallPick < dismissedOverall) {
      dismissedOverall = 0;
      this.writeDismissedAutoPickOverall(0);
    }

    this.dismissedAutoPickOverall.set(dismissedOverall);
    this.autoPickNoticePick.set(
      getLatestUndismissedAutoPick(picks, this.userId, dismissedOverall),
    );
  }

  private getAutoPickDismissalStorageKey(): string {
    return `rinkrat:draft-auto-pick-dismissed:${this.leagueId}:${this.userId}`;
  }

  private readDismissedAutoPickOverall(): number {
    if (typeof localStorage === 'undefined' || !this.leagueId || !this.userId) {
      return this.dismissedAutoPickOverall();
    }

    try {
      const parsed = Number(localStorage.getItem(this.getAutoPickDismissalStorageKey()));
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return this.dismissedAutoPickOverall();
    }
  }

  private writeDismissedAutoPickOverall(overallPick: number): void {
    if (typeof localStorage === 'undefined' || !this.leagueId || !this.userId) {
      return;
    }

    const storageKey = this.getAutoPickDismissalStorageKey();

    try {
      if (overallPick > 0) {
        localStorage.setItem(storageKey, String(overallPick));
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      // Storage may be unavailable in hardened/private browser contexts. The
      // in-memory dismissal still keeps the current Draft Room session calm.
    }
  }

  getQueueEntryStatusLabel(entry: DraftQueueEntryView): string {
    return entry.unavailableReason ?? 'Ready for Auto-Draft';
  }

  private getQueueEntryUnavailableReason(
    asset: DraftableAsset,
    alreadyDrafted: boolean,
  ): string | null {
    if (alreadyDrafted) {
      return 'Already drafted';
    }

    if (this.getDraftDestinationForAsset(this.userId, asset)) {
      return null;
    }

    if (this.isBenchSelectionReservedForStarters(this.userId, asset)) {
      return 'Bench spot reserved until your starting lineup is complete';
    }

    const starterCount = this.getStarterCount(this.userId, asset.position);
    const requiredCount = this.getPositionRequirement(asset.position);

    if (starterCount >= requiredCount && this.getOpenBenchSlotCount(this.userId) <= 0) {
      return `${asset.position} starters and bench are full`;
    }

    return 'No legal roster spot is available';
  }

  private isPendingPickRequestActive(requestId: number): boolean {
    return this.pendingPickConfirmation?.requestId === requestId && !this.destroyed;
  }

  private clearPendingPickTimers(): void {
    if (this.pendingPickConfirmationTimer) {
      clearTimeout(this.pendingPickConfirmationTimer);
      this.pendingPickConfirmationTimer = null;
    }

    if (this.pendingPickProbeTimer) {
      clearTimeout(this.pendingPickProbeTimer);
      this.pendingPickProbeTimer = null;
    }
  }

  private finishPendingPickConfirmation(pending: PendingPickConfirmation): void {
    if (!this.isPendingPickRequestActive(pending.requestId)) {
      return;
    }

    this.pendingPickConfirmation = null;
    this.clearPendingPickTimers();
    this.pickSubmissionPhase.set('idle');
    this.makingPickAssetKey.set(null);
    this.selectedAssetKey.set(null);
    this.successMessage.set(
      `${pending.assetName} was confirmed at pick #${pending.overallPick}.`,
    );
    this.pendingPickAction?.finish('success');
    this.pendingPickAction = null;

    // A pick document can arrive before the draft and queue listeners. Force
    // one fresh three-listener handshake before another competitive action is
    // allowed, preventing a duplicate click against an old current-pick view.
    this.requestRealtimeConfirmation('manual');
  }

  private finishPendingPickConflict(
    pending: PendingPickConfirmation,
    observedPick: DraftPick,
  ): void {
    if (!this.isPendingPickRequestActive(pending.requestId)) {
      return;
    }

    this.pendingPickConfirmation = null;
    this.clearPendingPickTimers();
    this.pickSubmissionPhase.set('idle');
    this.makingPickAssetKey.set(null);
    this.selectedAssetKey.set(null);
    this.errorMessage.set(
      `Pick #${pending.overallPick} was completed with ${this.getAssetName(observedPick.asset)} before ${pending.assetName} could be confirmed. RinkRat is refreshing the live board.`,
    );
    this.pendingPickAction?.finish('error');
    this.pendingPickAction = null;
    this.requestRealtimeConfirmation('manual');
  }

  private finishPendingPickError(
    pending: PendingPickConfirmation,
    message: string,
  ): void {
    if (!this.isPendingPickRequestActive(pending.requestId)) {
      return;
    }

    this.pendingPickConfirmation = null;
    this.clearPendingPickTimers();
    this.pickSubmissionPhase.set('idle');
    this.makingPickAssetKey.set(null);
    this.errorMessage.set(message);
    this.pendingPickAction?.finish('error');
    this.pendingPickAction = null;
  }

  private finishPendingPickUncertain(pending: PendingPickConfirmation): void {
    if (!this.isPendingPickRequestActive(pending.requestId)) {
      return;
    }

    this.pendingPickConfirmation = null;
    this.clearPendingPickTimers();
    this.pickSubmissionPhase.set('idle');
    this.makingPickAssetKey.set(null);
    this.selectedAssetKey.set(null);
    this.draftBoardListenerError.set(
      `RinkRat could not verify pick #${pending.overallPick} in this tab. The pending state has been released; refresh the live board before attempting another pick.`,
    );
    this.refreshRealtimeListenerErrorState();
    this.realtimeConfirmationStartedAt.set(Date.now());
    this.realtimeReconnectReason.set('listener-error');
    this.pendingPickAction?.finish('uncertain');
    this.pendingPickAction = null;

    if (this.browserOnline()) {
      this.scheduleRealtimeListenerRestart(60);
    }
  }

  private confirmPendingPickIfObserved(): void {
    const pending = this.pendingPickConfirmation;

    if (!pending) {
      return;
    }

    const observedPick = this.picks().find(
      (pick) => pick.overallPick === pending.overallPick,
    );

    if (observedPick) {
      if (draftPickMatchesPending(observedPick, pending)) {
        this.finishPendingPickConfirmation(pending);
      } else {
        this.finishPendingPickConflict(pending, observedPick);
      }
      return;
    }

    const draftConfirmed = draftStateShowsPendingPickCommitted(
      this.draft(),
      pending,
    );

    if (!draftConfirmed) {
      return;
    }

    this.finishPendingPickConfirmation(pending);
  }

  private async reconcilePendingPickFromServer(requestId: number): Promise<boolean> {
    if (
      !this.isPendingPickRequestActive(requestId) ||
      this.pendingPickServerProbeInProgress ||
      !this.leagueId
    ) {
      return !this.isPendingPickRequestActive(requestId);
    }

    const pending = this.pendingPickConfirmation;

    if (!pending) {
      return true;
    }

    this.pendingPickServerProbeInProgress = true;

    try {
      const [serverDraftResult, serverPickResult] = await Promise.all([
        settleOperationWithin(
          getFantasyDraftFromServer(this.leagueId),
          6_000,
        ),
        settleOperationWithin(
          getDraftPickFromServer(this.leagueId, pending.overallPick),
          6_000,
        ),
      ]);

      if (!this.isPendingPickRequestActive(requestId)) {
        return true;
      }

      const serverDraft = serverDraftResult.status === 'fulfilled'
        ? serverDraftResult.value
        : null;
      const serverPick = serverPickResult.status === 'fulfilled'
        ? serverPickResult.value
        : null;

      if (serverDraft) {
        this.draft.set(serverDraft);
      }

      if (serverPick) {
        if (draftPickMatchesPending(serverPick, pending)) {
          this.picks.update((currentPicks) =>
            mergeConfirmedDraftPick(currentPicks, serverPick),
          );
        } else {
          this.finishPendingPickConflict(pending, serverPick);
          return true;
        }
      }

      this.confirmPendingPickIfObserved();
      return !this.isPendingPickRequestActive(requestId);
    } catch {
      // The live listeners remain the primary path. A one-off server read can
      // fail during a reconnect without turning a committed pick into an error.
      return false;
    } finally {
      this.pendingPickServerProbeInProgress = false;
    }
  }

  private armPendingPickReconciliationLoop(requestId: number): void {
    if (this.pendingPickProbeTimer) {
      clearTimeout(this.pendingPickProbeTimer);
    }

    const scheduleProbe = (delayMilliseconds: number): void => {
      this.pendingPickProbeTimer = setTimeout(async () => {
        this.pendingPickProbeTimer = null;

        if (!this.isPendingPickRequestActive(requestId)) {
          return;
        }

        if (this.pickSubmissionPhase() === 'submitting') {
          // The browser transport can remain open after Firestore commits.
          // Move immediately into a non-blocking reconciliation state instead
          // of leaving the manager behind a full-screen spinner.
          this.pickSubmissionPhase.set('confirming');
          this.successMessage.set(
            'RinkRat is checking the authoritative draft record. You can keep reading the Draft Room while the live board catches up.',
          );
        }

        await this.reconcilePendingPickFromServer(requestId);

        if (this.isPendingPickRequestActive(requestId)) {
          scheduleProbe(4_000);
        }
      }, Math.max(0, delayMilliseconds));
    };

    scheduleProbe(2_500);
  }

  private armPendingPickConfirmationTimeout(requestId: number): void {
    if (this.pendingPickConfirmationTimer) {
      clearTimeout(this.pendingPickConfirmationTimer);
    }

    // This safety release must never await Firebase, a listener restart, or a
    // direct document read. Those paths continue independently, but the
    // browser-side pending state is guaranteed to end even when Safari leaves
    // a network promise unresolved after the pick has committed.
    this.pendingPickConfirmationTimer = setTimeout(() => {
      if (!this.isPendingPickRequestActive(requestId)) {
        return;
      }

      const pending = this.pendingPickConfirmation;

      if (pending) {
        this.finishPendingPickUncertain(pending);
      }
    }, 45_000);
  }

  async checkPendingPickNow(): Promise<void> {
    const pending = this.pendingPickConfirmation;

    if (!pending || this.pendingPickServerProbeInProgress) {
      return;
    }

    this.successMessage.set('Checking the live draft record now…');
    this.requestRealtimeConfirmation('manual');
    await this.reconcilePendingPickFromServer(pending.requestId);
  }

  private isPossiblyCommittedDraftPickError(error: unknown): boolean {
    const rawCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const code = rawCode.toLowerCase();

    return [
      'deadline-exceeded',
      'unavailable',
      'internal',
      'unknown',
      'cancelled',
      'network-request-failed',
    ].some((candidate) => code.includes(candidate));
  }

  async loadPlayerPool(): Promise<void> {
    const requestId = ++this.playerPoolRequestId;

    if (this.projectionLoadSlowTimer) {
      clearTimeout(this.projectionLoadSlowTimer);
      this.projectionLoadSlowTimer = null;
    }

    this.playerPoolLoading.set(true);
    this.projectionLoadSlow.set(false);
    this.playerPoolError.set('');

    this.projectionLoadSlowTimer = setTimeout(() => {
      this.projectionLoadSlowTimer = null;

      if (this.isPlayerPoolRequestActive(requestId) && this.playerPoolLoading()) {
        this.projectionLoadSlow.set(true);
      }
    }, DRAFT_PROJECTION_LOAD_SLOW_DELAY_MILLISECONDS);

    try {
      const pinnedSnapshotId = this.draft()?.serverDraftProjectionSnapshotId;
      const snapshot = pinnedSnapshotId
        ? await loadSharedProjectionSnapshotById(this.leagueId, pinnedSnapshotId)
        : await loadSharedProjectionSnapshot(this.leagueId);

      if (!this.isPlayerPoolRequestActive(requestId)) {
        return;
      }

      if (!snapshot) {
        this.playerPool.set([]);
        throw new Error(
          'Shared projections are not ready. The commissioner must refresh them before the draft can use rankings or auto-draft.',
        );
      }

      if (snapshot.metadata.generationReason === 'server-emergency') {
        this.playerPool.set([]);
        throw new Error(
          `The saved player pool contains temporary emergency rankings and cannot be used for this draft. The commissioner must return to Draft Setup and save the schedule again to build verified Projection V${SHARED_PROJECTION_VERSION} rankings.`,
        );
      }

      const draft = this.draft();
      const expectedSnapshotHash = draft?.serverDraftProjectionSnapshotHash;
      const verifiedAuthority =
        snapshot.metadata.generatedByAuthority === 'server' &&
        snapshot.metadata.authoritySchemaVersion ===
          PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION &&
        snapshot.metadata.snapshotHashSchemaVersion ===
          PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION &&
        snapshot.metadata.snapshotHashAlgorithm === 'sha256' &&
        snapshot.metadata.snapshotIntegrityStatus === 'verified' &&
        /^[a-f0-9]{64}$/.test(snapshot.metadata.snapshotContentHash ?? '');

      if (
        !verifiedAuthority ||
        (pinnedSnapshotId && snapshot.metadata.activeSnapshotId !== pinnedSnapshotId) ||
        (expectedSnapshotHash && snapshot.metadata.snapshotContentHash !== expectedSnapshotHash)
      ) {
        this.playerPool.set([]);
        throw new Error(
          'The Draft pool did not match its verified server content hash. Refresh the Draft Room or ask the commissioner to verify the projection snapshot.',
        );
      }

      this.playerPool.set(snapshot.assets);
    } catch (error: unknown) {
      if (this.isPlayerPoolRequestActive(requestId)) {
        this.playerPoolError.set(
          error instanceof Error ? error.message : 'Unable to load the shared NHL player pool.',
        );
      }
    } finally {
      if (this.isPlayerPoolRequestActive(requestId)) {
        if (this.projectionLoadSlowTimer) {
          clearTimeout(this.projectionLoadSlowTimer);
          this.projectionLoadSlowTimer = null;
        }

        this.projectionLoadSlow.set(false);
        this.playerPoolLoading.set(false);
      }
    }
  }

  retryPlayerPool(): void {
    void this.loadPlayerPool();
  }

  private isPlayerPoolRequestActive(requestId: number): boolean {
    return !this.destroyed && requestId === this.playerPoolRequestId;
  }

  getDraftInjurySyncStatusLabel(): string {
    if (this.injurySyncState()?.status === 'running') {
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
    if (this.injurySyncState()?.status === 'running') {
      return 'The server is preparing today’s shared injury report before it seals the Draft board.';
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

    return `The server begins preparing the injury report and rankings ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before the scheduled start.`;
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

  private getMillisecondsUntilDraftStart(): number | null {
    const startDate = this.draftStartDate();

    if (!startDate) {
      return null;
    }

    return startDate.getTime() - this.now();
  }

  getPreDraftPreparationStatusLabel(): string {
    const serverStatus = this.draft()?.serverDraftReadinessStatus;

    if (serverStatus === 'ready') {
      return 'Server Draft Data Ready';
    }

    if (serverStatus === 'preparing-projection') {
      return 'Server Preparing Draft Data';
    }

    if (serverStatus === 'waiting-injury') {
      return 'Waiting for Injury Report';
    }

    if (serverStatus === 'error') {
      return 'Preparation Retry Scheduled';
    }

    const millisecondsRemaining = this.getMillisecondsUntilDraftStart();

    if (
      typeof millisecondsRemaining === 'number' &&
      millisecondsRemaining > PRE_DRAFT_PROJECTION_WARMUP_MINUTES * 60 * 1000
    ) {
      return `Preload begins ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before start`;
    }

    return 'Waiting for server preparation';
  }

  getPreDraftPreparationDescription(): string {
    const serverMessage = this.draft()?.serverDraftReadinessMessage;

    if (serverMessage) {
      return serverMessage;
    }

    return 'The server will prepare the verified Draft board and open the clock at the scheduled time. This page may stay closed.';
  }

  isPreDraftPreparationReady(): boolean {
    const serverStatus = this.draft()?.serverDraftReadinessStatus;

    return serverStatus === 'ready';
  }

  isPreDraftPreparationRunning(): boolean {
    const serverStatus = this.draft()?.serverDraftReadinessStatus;

    return serverStatus === 'preparing-projection';
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
      return;
    }

    if (draft.serverDraftReadinessStatus !== 'ready') {
      return;
    }

    if (this.activationInProgress) {
      return;
    }

    this.activationInProgress = true;

    try {
      const activatedDraft = await activateScheduledDraftIfReady(this.leagueId, this.userId);

      if (this.destroyed) {
        return;
      }

      this.clearFirestoreRetry();
      this.errorMessage.set('');

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

  private ensureRealtimeActionReady(scope: 'board' | 'queue' = 'board'): boolean {
    if (this.releaseUpdate.updateAvailable()) {
      this.errorMessage.set(
        'A different RinkRat build is now live. Reload this tab before changing the queue, clock, Auto-Draft, or making another pick.',
      );
      return false;
    }

    if (this.pickSubmissionPhase() !== 'idle') {
      this.errorMessage.set(
        'RinkRat is still confirming your previous pick. Wait for the live board to refresh before changing another draft setting.',
      );
      return false;
    }

    const draftIsLive = this.draft()?.status === 'live';

    if (
      this.draftHandoffRepairInProgress() ||
      (draftIsLive && this.draftTurnHandoff().status !== 'healthy')
    ) {
      this.errorMessage.set(
        'RinkRat is opening the next live draft turn. Wait for the next manager and clock to be confirmed before submitting another action.',
      );
      this.scheduleDraftTurnHandoffCheck(250);
      return false;
    }

    const ready = scope === 'queue'
      ? this.canUseDraftQueueActions()
      : this.canUseDraftBoardActions();

    if (ready) {
      return true;
    }

    this.errorMessage.set(
      scope === 'queue'
        ? 'Queue and Auto-Draft changes are paused until your private queue receives a fresh server confirmation.'
        : 'Draft-board actions are paused until RinkRat confirms the live turn and ordered picks. Use Retry Connection if this message remains.',
    );
    return false;
  }

  private getBoundedDraftActionError(
    error: unknown,
    fallbackMessage: string,
  ): { message: string; outcome: 'error' | 'uncertain' } {
    if (isOperationDeadlineError(error)) {
      return {
        message: error.message,
        outcome: 'uncertain',
      };
    }

    return {
      message: error instanceof Error ? error.message : fallbackMessage,
      outcome: 'error',
    };
  }

  async toggleMyAutoDraft(): Promise<void> {
    if (
      this.draft()?.status !== 'live' ||
      this.queueSaving() ||
      !this.ensureRealtimeActionReady('queue')
    ) {
      return;
    }

    this.queueSaving.set(true);
    this.errorMessage.set('');
    const actionHandle = this.actionMonitor.begin('draft-auto');

    try {
      await withOperationDeadline(
        setDraftAutoDraftEnabled(this.leagueId, this.userId, !this.myQueue().autoDraftEnabled),
        20_000,
        'RinkRat stopped waiting for the Auto-Draft response. Refresh the live Draft Room before trying again because the setting may still have saved.',
      );
      actionHandle.finish('success');
    } catch (error: unknown) {
      const result = this.getBoundedDraftActionError(
        error,
        'Unable to update your auto-draft preference.',
      );
      actionHandle.finish(result.outcome);
      this.errorMessage.set(result.message);
    } finally {
      this.queueSaving.set(false);
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
      Boolean(this.playerPoolError()) ||
      !this.ensureRealtimeActionReady()
    ) {
      return;
    }

    this.clockActionInProgress.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    const actionHandle = this.actionMonitor.begin('draft-clock');

    try {
      await withOperationDeadline(
        startDraftClock(this.leagueId, this.userId),
        20_000,
        'RinkRat stopped waiting for the draft-clock response. Check the live clock before trying again because it may already have started.',
      );
      actionHandle.finish('success');
      this.successMessage.set('The draft clock has started. You are on the clock.');
    } catch (error: unknown) {
      const result = this.getBoundedDraftActionError(
        error,
        'Unable to start the draft clock.',
      );
      actionHandle.finish(result.outcome);
      this.errorMessage.set(result.message);
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
      this.clockActionInProgress() ||
      !this.ensureRealtimeActionReady()
    ) {
      return;
    }

    this.clockActionInProgress.set(true);
    this.errorMessage.set('');
    const actionHandle = this.actionMonitor.begin('draft-clock');

    try {
      if (draft.clockStatus === 'paused') {
        await withOperationDeadline(
          resumeDraftClock(this.leagueId, this.userId),
          20_000,
          'RinkRat stopped waiting for the draft-clock response. Check the live board before trying again.',
        );
      } else {
        await withOperationDeadline(
          pauseDraftClock(this.leagueId, this.userId),
          20_000,
          'RinkRat stopped waiting for the draft-clock response. Check the live board before trying again.',
        );
      }
      actionHandle.finish('success');
    } catch (error: unknown) {
      const result = this.getBoundedDraftActionError(
        error,
        'Unable to change the draft clock.',
      );
      actionHandle.finish(result.outcome);
      this.errorMessage.set(result.message);
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

    if (
      this.draftHandoffRepairInProgress() ||
      (draft?.status === 'live' && this.draftTurnHandoff().status !== 'healthy')
    ) {
      return 'Opening Next Pick';
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
    if (!this.ensureRealtimeActionReady('queue')) {
      return;
    }

    this.queueSaving.set(true);
    this.errorMessage.set('');
    const actionHandle = this.actionMonitor.begin('draft-queue');

    try {
      await withOperationDeadline(
        saveDraftQueue(this.leagueId, this.userId, assetKeys, this.myQueue().autoDraftEnabled),
        20_000,
        'RinkRat stopped waiting for the queue response. Refresh the Draft Room before changing the queue again because the update may still have saved.',
      );
      actionHandle.finish('success');
    } catch (error: unknown) {
      const result = this.getBoundedDraftActionError(
        error,
        'Unable to update your draft queue.',
      );
      actionHandle.finish(result.outcome);
      this.errorMessage.set(result.message);
    } finally {
      this.queueSaving.set(false);
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

  async shareMyDraft(): Promise<void> {
    if (!this.canShareCompletedDraft() || this.draftShareInProgress()) {
      return;
    }

    const draft = this.draft();
    const league = this.league();
    const team = this.teams().find((candidate) => candidate.ownerId === this.userId);

    if (!draft || !league || !team) {
      this.draftShareErrorMessage.set('Your completed Draft card is not ready yet.');
      return;
    }

    this.draftShareInProgress.set(true);
    this.draftShareStatusMessage.set('');
    this.draftShareErrorMessage.set('');

    try {
      const draftSlotIndex = draft.roundOneOrder.indexOf(this.userId);
      const result = await shareLeagueDraftCard({
        leagueName: league.name,
        teamName: team.teamName,
        draftSlot: draftSlotIndex >= 0 ? draftSlotIndex + 1 : 1,
        totalTeams: Math.max(2, this.teams().length, draft.roundOneOrder.length),
        totalPicks: this.myCompletedDraftPicks().length,
        picks: this.myCompletedDraftPicks().map((pick) => ({
          name: this.getAssetName(pick.asset),
          position: pick.asset.position,
          round: pick.round,
          overallPick: pick.overallPick,
        })),
      });

      if (result.outcome !== 'cancelled') {
        this.draftShareStatusMessage.set(result.message);
      }
    } catch (error) {
      this.draftShareErrorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to prepare your Draft card right now.',
      );
    } finally {
      this.draftShareInProgress.set(false);
    }
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

  getDraftAssetPortrait(asset: DraftableAsset): DraftAssetPortrait {
    return resolveDraftAssetPortrait(asset, {
      currentTeamLogoUrl: this.hasOffseasonTeamChange(asset)
        ? this.getNewTeamLogoUrl(asset)
        : this.getAssetLogoUrl(asset),
      currentTeamLabel: this.hasOffseasonTeamChange(asset)
        ? this.getNewsNewTeamAbbreviation(asset)
        : this.getAssetTeamLabel(asset),
      failedImageUrls: this.failedDraftImageUrls(),
    });
  }

  markDraftImageUnavailable(imageUrl: string): void {
    this.failedDraftImageUrls.update((failedUrls) => {
      if (failedUrls.has(imageUrl)) {
        return failedUrls;
      }

      const nextFailedUrls = new Set(failedUrls);
      nextFailedUrls.add(imageUrl);
      return nextFailedUrls;
    });
  }

  getAssetIdentityTeamLabel(asset: DraftableAsset): string {
    if (!this.hasOffseasonTeamChange(asset)) {
      return this.getAssetTeamLabel(asset);
    }

    return `${this.getPreviousTeamAbbreviation(asset)} → ${this.getNewsNewTeamAbbreviation(asset)}`;
  }

  getAssetIdentityAriaLabel(asset: DraftableAsset): string {
    if (!this.hasOffseasonTeamChange(asset)) {
      return `${asset.position}, ${this.getAssetTeamLabel(asset)}`;
    }

    return `${asset.position}, ${this.getPreviousTeamAbbreviation(asset)} to ${this.getNewsNewTeamAbbreviation(asset)}`;
  }

  getDraftNews(asset: DraftableAsset): DraftPlayerNewsOverride | null {
    return getDraftNewsOverrideForAsset(asset);
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

  getDraftPlayerAvailabilityDisplay(
    asset: DraftableAsset,
  ): DraftPlayerAvailabilityDisplay | null {
    const availability = this.getPlayerAvailability(asset);

    return availability ? getDraftPlayerAvailabilityDisplay(availability) : null;
  }

  getPlayerAvailabilityNote(asset: DraftableAsset): string {
    return this.getPlayerAvailability(asset)?.note ?? '';
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
      !this.isMyTurn() ||
      !this.canUseLiveDraftActions()
    ) {
      return false;
    }

    return this.getDraftDestinationForAsset(this.userId, asset) !== null;
  }

  getDraftButtonLabel(asset: DraftableAsset): string {
    if (this.makingPickAssetKey() === asset.assetKey) {
      return this.pickSubmissionPhase() === 'confirming' ? 'Confirming...' : 'Drafting...';
    }

    if (this.releaseUpdate.updateAvailable()) {
      return 'Reload RinkRat';
    }

    if (
      this.draftHandoffRepairInProgress() ||
      (this.draft()?.status === 'live' && this.draftTurnHandoff().status !== 'healthy')
    ) {
      return 'Opening Next Pick';
    }

    if (this.draftBoardConnectionState() !== 'connected') {
      return this.draftBoardConnectionState() === 'offline' ? 'Offline' : 'Reconnecting';
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

  private createDraftPickSubmissionId(overallPick: number): string {
    const randomPart =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replaceAll('-', '')
        : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

    return `pick_${overallPick}_${Date.now().toString(36)}_${randomPart}`.slice(0, 120);
  }

  async selectAsset(asset: DraftableAsset): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    if (!this.ensureRealtimeActionReady() || !this.canDraftAsset(asset)) {
      return;
    }

    const currentPick = this.currentPick();

    if (!currentPick) {
      return;
    }

    const requestId = ++this.pendingPickRequestCounter;
    const submissionId = this.createDraftPickSubmissionId(currentPick.overallPick);

    this.makingPickAssetKey.set(asset.assetKey);
    this.pickSubmissionPhase.set('submitting');
    this.pendingPickAction?.finish('cancelled');
    this.pendingPickAction = this.actionMonitor.begin('draft-pick');
    this.pendingPickConfirmation = {
      submissionId,
      requestId,
      overallPick: currentPick.overallPick,
      assetKey: asset.assetKey,
      assetName: this.getAssetName(asset),
      ownerId: this.userId,
      startedAt: Date.now(),
    };
    this.armPendingPickReconciliationLoop(requestId);
    this.armPendingPickConfirmationTimeout(requestId);

    try {
      const pick = await makeDraftPick(
        this.leagueId,
        this.userId,
        asset,
        submissionId,
        currentPick.overallPick,
      );

      if (!this.isPendingPickRequestActive(requestId)) {
        return;
      }

      const pending = this.pendingPickConfirmation;

      if (!pending || !draftPickMatchesPending(pick, pending)) {
        if (pending) {
          this.finishPendingPickError(
            pending,
            'The draft server returned a different pick than this tab submitted. RinkRat is refreshing the live board before another action is allowed.',
          );
          this.requestRealtimeConfirmation('manual');
        }
        return;
      }

      // A successful callable response is authoritative: the atomic Firestore
      // transaction committed. Merge the returned pick immediately, then force
      // the normal live listeners through one fresh handshake before another
      // competitive action can begin.
      this.picks.update((currentPicks) =>
        mergeConfirmedDraftPick(currentPicks, pick),
      );
      this.pickSubmissionPhase.set('confirming');
      this.confirmPendingPickIfObserved();
    } catch (error: unknown) {
      // A mobile or browser transport can fail after Firestore committed the
      // pick. Check the authoritative draft and pick documents before showing
      // an error or allowing a retry.
      const reconciled = await this.reconcilePendingPickFromServer(requestId);

      if (reconciled || !this.isPendingPickRequestActive(requestId)) {
        return;
      }

      const pending = this.pendingPickConfirmation;

      if (!pending) {
        return;
      }

      if (this.isPossiblyCommittedDraftPickError(error)) {
        this.pickSubmissionPhase.set('confirming');
        this.successMessage.set(
          'The network response ended before the pick could be verified. RinkRat is still checking the authoritative draft record, so do not retry yet.',
        );
        this.requestRealtimeConfirmation('manual');
        return;
      }

      this.finishPendingPickError(
        pending,
        error instanceof Error ? error.message : 'Unable to make this draft pick.',
      );
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

  formatDraftLobbyOpen(): string {
    const openDate = this.draftLobbyOpenDate();

    if (!openDate) {
      return 'after the commissioner schedules the Draft';
    }

    return openDate.toLocaleString(undefined, {
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
