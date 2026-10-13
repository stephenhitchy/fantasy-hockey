import { Component, computed, HostListener, OnDestroy, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';
import { Subscription } from 'rxjs';

import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';
import {
  isOperationDeadlineError,
  waitForOperationDelay,
  waitForOperationCondition,
  withOperationDeadline,
} from '../../../core/async/bounded-operation.util';
import { getFantasyTeamProfileIconId } from '../../../core/team/team.service';
import { auth } from '../../../core/firebase';

import {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyMatchup,
} from '../../../core/cycle/cycle.models';

import {
  CycleAssetScoreSummary,
  CycleScoringResult,
} from '../../../core/cycle/cycle-scoring.service';
import {
  buildReconciledInjuryReplacementPresentation,
  resolveCycleSlotScoreSummary,
  type InjuryReplacementPresentation,
} from '../../../core/cycle/injury-replacement-presentation.util';

import { defaultScoringRules } from '../../../core/scoring/scoring-rules';

import {
  CycleSchedulePreviewCycle,
  getCycleOwnerRosterPicksOnce,
  listenToCycleMatchups,
  listenToCycleRosterPicks,
  listenToEarliestUnfinishedOwnerMatchup,
  listenToLatestCycle,
} from '../../../core/cycle/cycle.service';

import {
  DraftableAsset,
  DraftPick,
  DraftPosition,
  FantasyDraft,
} from '../../../core/draft/draft.models';
import {
  buildProjectionProgressMarkers,
  type LeaguePlayerProgressMarker,
} from '../../../core/player/league-player-window-progress.util';

import {
  activateIrRosterAsset,
  activateIrRosterAssetToBench,
  dropRosterAssetToWaivers,
  FantasyTransaction,
  listenToDraftPicks,
  listenToOwnerTransactions,
  moveBenchRosterAssetToIr,
  moveRosterAssetToIr,
  queueActiveBenchSwap,
  replaceInjuredRosterAsset,
  type RosterDropSource,
} from '../../../core/draft/draft.service';
import { previewActiveBenchSwapTiming } from '../../../core/transactions/active-bench-swap-timing.service';
import type { ActiveBenchSwapTimingPreview } from '../../../core/transactions/active-bench-swap-timing.util';

import { loadDraftPlayerPool } from '../../../core/draft/draft-player-pool.service';
import type { NhlTeamSeasonGame } from '../../../core/nhl/nhl-api.service';

import { getLeagueById, League } from '../../../core/league/league.service';
import { buildFantasyStandings } from '../../../core/league/standings.util';

import {
  FantasyTeam,
  getFantasyTeam,
  listenToLeagueTeams,
  updateTeamName,
} from '../../../core/team/team.service';

import {
  ActiveRosterSlot,
  BenchRosterSlot,
  FantasyRoster,
  IrRosterSlot,
  RosterAsset,
  SkaterRosterAsset,
} from '../../../core/team/roster.models';

import { NHLPlayer } from '../../../core/player/player.models';

import { PlayerAvailability } from '../../../core/player/player-availability.models';

import {
  getPlayerAvailabilityForPlayer,
  getPlayerAvailabilityStatusClass,
  getPlayerIrIneligibleReason,
  isPlayerIrEligible,
  shouldDisplayPlayerAvailability,
  startPlayerAvailabilityListenerForLeague,
} from '../../../core/player/player-availability.service';
import { isImmediateInjuryMoveStatus } from '../../../core/player/player-injury-move-eligibility.util';

import { getOrCreateFantasyRoster, listenToFantasyRoster } from '../../../core/team/roster.service';
import {
  type FutureMatchupLineupPlanView,
  type SwapFutureMatchupLineupRequest,
  type FutureMatchupLineupSlotInput,
  type FutureMatchupLineupSlotView,
} from '../../../core/team/future-matchup-lineup.models';
import {
  clearFutureMatchupLineupPlan,
  createFutureMatchupLineupRequestId,
  isFutureMatchupLineupRevisionConflict,
  isFutureMatchupLineupSwapTimingConflict,
  listFutureMatchupLineupPlans,
  loadFutureMatchupLineupOptionContext,
  loadFutureMatchupNhlSchedules,
  loadFutureMatchupOwnerWindows,
  normalizeFutureMatchupLineupError,
  saveFutureMatchupLineupPlan,
  swapFutureMatchupLineup,
} from '../../../core/team/future-matchup-lineup.service';
import {
  buildFutureMatchupLineupCandidates,
  buildFutureMatchupLineupOptions,
  buildFutureMatchupProjectedLineup,
  getFutureMatchupSwapIntentKey,
  hasFutureMatchupWindowStarted,
  isFutureMatchupCandidateCompatible,
  resolveFutureMatchupSwapEffectiveCycle,
  resolveFutureMatchupSlotDateState,
  resolveFutureMatchupSourceEvidence,
  resolveSelectedMatchupAssignmentIdentity,
  resolveSelectedMatchupSlotExpectation,
  resolveSelectedMatchupSlotScoreState,
  selectFutureMatchupProjectedGames,
  selectRelevantFutureMatchupAuthorityPlans,
  shouldUseLiveSelectedMatchupScoring,
  shouldUseSelectedMatchupRosterAuthority,
  type FutureMatchupLineupOption,
  type FutureMatchupSwapEffectiveCycleOverride,
  type FutureMatchupSwapIntent,
  validateFutureMatchupLineupDraft,
} from '../../../core/team/future-matchup-lineup.util';
import { getUserProfile, UserProfile } from '../../../core/user/user.service';
import { getPixelTeamTheme } from '../../../shared/pixel-theme/pixel-theme.data';
import { DialogFocusTrapDirective } from '../../../shared/accessibility/dialog-focus-trap.directive';
import {
  repairViewportOverlayLock,
  ViewportOverlayPortalDirective,
} from '../../../shared/accessibility/viewport-overlay-portal.directive';
import { ActionSheet } from '../../../shared/action-sheet/action-sheet';
import { AssetPortrait } from '../../../shared/asset-portrait/asset-portrait';
import type { AssetPortraitSource } from '../../../shared/asset-portrait/asset-portrait.util';
import { LeagueQuickNavigation } from '../../../shared/league-quick-navigation/league-quick-navigation';
import { InjuryReplacementScoreBreakdown } from '../../../shared/injury-replacement-score-breakdown/injury-replacement-score-breakdown';
import {
  getRosterDisplayMetric,
  getRosterDisplayMetricLabel,
  getRosterDisplayPhase as resolveRosterDisplayPhase,
  orderRosterEntriesForDisplay,
} from '../../../shared/roster-display-order/roster-display-order.util';
import { ClientHealthService } from '../../../core/observability/client-health.service';
import { CompetitiveActionMonitorService } from '../../../core/observability/competitive-action-monitor.service';
import {
  buildFreeAgentRosterTargetQuery,
  buildRosterManagementActions,
  isExactQueuedBenchSwapPromotion,
  isImmediateActiveBenchSwapObserved,
  type ActiveBenchSwapRosterObservation,
  type ImmediateActiveBenchSwapExpectation,
  type RosterManagementAction,
  type RosterManagementActionId,
  type RosterManagementArea,
} from './roster-mobile-management.util';
import {
  isRosterRemovalObserved,
  type RosterRemovalExpectation,
  type RosterRemovalObservation,
} from './roster-operation-confirmation.util';
import {
  buildTransactionLedgerPreview,
  TEAM_TRANSACTION_EXPANDED_LIMIT,
} from './transaction-ledger-preview.util';
import {
  buildActiveBenchSwapTimingMessage,
  type ActiveBenchSwapTimingMessage,
} from './active-bench-swap-timing.util';
import { resolveCycleWindowGameMarkerState } from '../../cycles/cycle-one/cycle-window-game-marker.util';

import { listenToSharedCycleScoring } from '../../../core/live-scoring/live-scoring.service';

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

interface RosterPositionGroup {
  position: DraftPosition;
  label: string;
}

interface PendingRosterDrop {
  sourceRosterArea: RosterDropSource;
  slotId: string;
  slotLabel: string;
  asset: RosterAsset;
}

interface RosterSlotGameMarker {
  index: number;
  status: 'played' | 'missed' | 'live' | 'upcoming' | 'unavailable';
  title: string;
  ariaLabel: string;
  replacementBoundary: boolean;
  currentOwner: boolean;
}

interface ActiveRosterDisplaySlot extends ActiveRosterSlot {
  assignmentPending: boolean;
  displayCycleNumber: number | null;
  futureStartDate: FutureLineupStartDatePresentation | null;
  gameMarkers: RosterSlotGameMarker[];
  injuryReplacementPresentation: InjuryReplacementPresentation | null;
  nextPlannedAssetLabel: string;
  selectedPick: DraftPick | null;
  selectedWindow: FantasyAssetCycleWindow | null;
  useLiveCurrentScoring: boolean;
  windowLabel: string;
}

interface FutureLineupStartDatePresentation {
  confidence: 'saved' | 'projected' | 'pending';
  eyebrow: string;
  label: string;
  dateTime: string | null;
}

interface FutureLineupEditorCandidate {
  asset: RosterAsset;
  assignedElsewhere: boolean;
  key: string;
}

interface FutureLineupEditorRow {
  candidates: FutureLineupEditorCandidate[];
  lockReason: string;
  locked: boolean;
  showFallback: boolean;
  slot: ActiveRosterSlot;
  startDate: FutureLineupStartDatePresentation | null;
}

interface PendingFutureLineupMutation {
  operation: 'save' | 'clear' | 'swap';
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
  slotsKey: string;
  swapRequest?: Readonly<SwapFutureMatchupLineupRequest>;
}

import { getHistoricalScoringTestDate } from '../../../core/cycle/cycle-runtime.config';

@Component({
  selector: 'app-team-settings',
  imports: [
    FormsModule,
    RouterLink,
    ManagerAvatar,
    DialogFocusTrapDirective,
    ViewportOverlayPortalDirective,
    ActionSheet,
    AssetPortrait,
    LeagueQuickNavigation,
    InjuryReplacementScoreBreakdown,
  ],
  templateUrl: './team-settings.html',
  styleUrl: './team-settings.css',
})
export class TeamSettings implements OnDestroy {
  leagueId = '';
  userId = '';
  viewedOwnerId = signal('');
  viewerUserId = signal('');

  league = signal<League | null>(null);
  team = signal<FantasyTeam | null>(null);
  profile = signal<UserProfile | null>(null);
  teams = signal<FantasyTeam[]>([]);
  roster = signal<FantasyRoster | null>(null);
  picks = signal<DraftPick[]>([]);
  cycleRosterPicks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);
  transactions = signal<FantasyTransaction[]>([]);
  latestCycle = signal<FantasyCycle | null>(null);
  latestMatchups = signal<FantasyMatchup[]>([]);
  currentNavigationMatchup = signal<FantasyMatchup | null>(null);
  cycleScoring = signal<CycleScoringResult | null>(null);
  futureLineupPlans = signal<FutureMatchupLineupPlanView[]>([]);
  futureLineupOptionDraft = signal<FantasyDraft | null>(null);
  futureLineupOptionCycles = signal<FantasyCycle[]>([]);
  futureLineupSchedulePreview = signal<CycleSchedulePreviewCycle[]>([]);
  futureLineupNhlSeason = signal('');
  futureLineupWindows = signal<FantasyAssetCycleWindow[]>([]);
  futureLineupRosterPicks = signal<DraftPick[]>([]);
  futureLineupSchedulesByTeam = signal<Readonly<Record<string, NhlTeamSeasonGame[]>>>({});
  futureLineupSourceNhlBlockNumber = signal<number | null>(null);
  futureLineupTargetGameIdsByTeam = signal<Readonly<Record<string, number[]>>>({});
  futureLineupWindowsConfirmed = signal(false);
  futureLineupTimingLoading = signal(false);
  futureLineupTimingError = signal('');
  selectedFutureLineupCycleNumber = signal<number | null>(null);
  futureLineupDraftAssignments = signal<Record<string, string | null>>({});
  futureLineupBaselineAssignments = signal<Record<string, string | null>>({});
  futureLineupLoading = signal(false);
  futureLineupSaving = signal(false);
  futureLineupError = signal('');
  futureLineupMessage = signal('');
  futureLineupStale = signal(false);

  teamName = '';
  loading = signal(true);
  saving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  liveDataWarnings = signal<string[]>([]);
  scoringLoading = signal(false);
  scoringError = signal('');
  transactionsLoading = signal(true);
  transactionsUnavailable = signal(false);
  transactionHistoryExpanded = signal(false);
  rosterMoveLoading = signal(false);
  rosterMoveMessage = signal('');
  rosterMoveError = signal('');
  irActivationSlotId = signal('');
  irActivationTargetSlotId = signal('');
  irActivationBenchSlotId = signal('');
  irBenchActivationSlotId = signal('');
  irBenchActivationTargetSlotId = signal('');
  benchSwapSlotId = signal('');
  benchSwapTargetSlotId = signal('');
  benchSwapRestrictedTargetSlotId = signal('');
  benchSwapTimingPreview = signal<ActiveBenchSwapTimingPreview | null>(null);
  benchSwapTimingLoading = signal(false);
  benchSwapTimingError = signal('');
  activeBenchPickerSlotId = signal('');
  rosterDropSource = signal<RosterDropSource | null>(null);
  rosterDropSlotId = signal('');
  rosterManagerArea = signal<RosterManagementArea | null>(null);
  rosterManagerSlotId = signal('');
  rosterActionCycleNumber = signal<number | null>(null);
  rosterActionUsesSelectedMatchupAuthority = signal(false);

  readonly rosterPositions: RosterPositionGroup[] = [
    { position: 'LW', label: 'Left Wing' },
    { position: 'C', label: 'Center' },
    { position: 'RW', label: 'Right Wing' },
    { position: 'D', label: 'Defense' },
    { position: 'G', label: 'Goalie Unit' },
  ];

  private stopRosterListener: (() => void) | null = null;
  private stopTeamListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private stopTransactionsListener: (() => void) | null = null;
  private stopCycleRosterPicksListener: (() => void) | null = null;
  private stopLatestCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private stopCurrentNavigationMatchupListener: (() => void) | null = null;
  private stopSharedScoringListener: (() => void) | null = null;
  private rosterOperationGeneration = 0;
  private benchSwapTimingGeneration = 0;
  private benchSwapReopenBlockedUntil = 0;
  private loadGeneration = 0;
  private futureLineupLoadGeneration = 0;
  private futureLineupMutationGeneration = 0;
  private futureLineupTimingGeneration = 0;
  private futureLineupAuthorityRefreshGeneration = 0;
  private futureLineupLatestCycleAuthoritySignature = '';
  private futureLineupAuthorityRefreshPromise: Promise<void> | null = null;
  private futureLineupAuthorityRefreshKey = '';
  private futureLineupSelectionTouched = false;
  private futureLineupInitialLoadStarted = false;
  private pendingFutureLineupMutation: PendingFutureLineupMutation | null = null;
  private readonly futureSwapEffectiveCycleOverride =
    signal<FutureMatchupSwapEffectiveCycleOverride | null>(null);
  private readonly routeSubscription: Subscription;

  readonly isOwnTeam = computed(() => {
    const viewerUserId = this.viewerUserId();
    return Boolean(viewerUserId && viewerUserId === this.viewedOwnerId());
  });

  readonly currentMatchup = computed(() => {
    return this.currentNavigationMatchup();
  });

  readonly selectedFutureLineupPlan = computed(() => {
    const cycleNumber = this.selectedFutureLineupCycleNumber();

    if (!cycleNumber) {
      return null;
    }

    return this.futureLineupPlans().find((plan) => plan.cycleNumber === cycleNumber) ?? null;
  });

  readonly futureLineupDirty = computed(() => {
    const draftAssignments = this.futureLineupDraftAssignments();
    const baselineAssignments = this.futureLineupBaselineAssignments();
    const slotIds = this.roster()?.activeSlots.map((slot) => slot.slotId) ?? [];

    return slotIds.some(
      (slotId) => (draftAssignments[slotId] ?? null) !== (baselineAssignments[slotId] ?? null),
    );
  });

  readonly currentOpponentOwnerId = computed(() => {
    const matchup = this.currentMatchup();

    if (!matchup) {
      return null;
    }

    if (matchup.teamAOwnerId === this.viewedOwnerId()) {
      return matchup.teamBOwnerId;
    }

    return matchup.teamAOwnerId;
  });

  readonly rosterFilledCount = computed(() => {
    const roster = this.roster();

    if (!roster) {
      return 0;
    }

    return roster.activeSlots.filter((slot) => slot.asset !== null).length;
  });

  readonly displayedRosterFilledCount = computed(() => {
    if (!this.getSelectedFutureLineupMatchupOption()) {
      return this.rosterFilledCount();
    }

    return this.getFutureRosterDisplaySlots().filter((slot) => slot.asset !== null).length;
  });

  readonly rosterTotalCount = computed(() => this.roster()?.activeSlots.length ?? 0);

  readonly benchFilledCount = computed(
    () => this.roster()?.benchSlots.filter((slot) => slot.asset !== null).length ?? 0,
  );

  readonly benchTotalCount = computed(() => this.roster()?.benchSlots.length ?? 0);

  readonly irFilledCount = computed(
    () => this.roster()?.irSlots.filter((slot) => slot.asset !== null).length ?? 0,
  );

  readonly irTotalCount = computed(() => this.roster()?.irSlots.length ?? 0);

  readonly rosterDisplayPhase = computed(() => {
    const pool = this.playerPool();
    const referenceAssets = pool.length > 0 ? pool : this.picks().map((pick) => pick.asset);

    return resolveRosterDisplayPhase(referenceAssets);
  });

  readonly teamPointDifferential = computed(() => {
    const team = this.team();

    if (!team) {
      return 0;
    }

    return (team.pointsFor ?? 0) - (team.pointsAgainst ?? 0);
  });

  readonly leagueRank = computed(() => {
    const ownerId = this.viewedOwnerId();

    if (!ownerId) {
      return null;
    }

    const rankIndex = buildFantasyStandings(this.teams()).findIndex(
      (standing) => standing.ownerId === ownerId,
    );

    return rankIndex >= 0 ? rankIndex + 1 : null;
  });

  readonly completedTransactions = computed(() =>
    this.transactions().filter((transaction) => this.shouldShowTransactionInLedger(transaction)),
  );

  readonly recentTransactionPreview = computed(() =>
    buildTransactionLedgerPreview(this.completedTransactions()),
  );

  readonly recentTransactions = computed(() => this.recentTransactionPreview().visible);

  readonly expandedTransactionPreview = computed(() =>
    buildTransactionLedgerPreview(this.completedTransactions(), TEAM_TRANSACTION_EXPANDED_LIMIT),
  );

  readonly hiddenRecentTransactionCount = computed(
    () => this.expandedTransactionPreview().visible.length - this.recentTransactions().length,
  );

  readonly displayedTransactions = computed(() =>
    this.transactionHistoryExpanded()
      ? this.expandedTransactionPreview().visible
      : this.recentTransactions(),
  );

  readonly transactionHistorySummary = computed(() => {
    const count = this.displayedTransactions().length;
    return count === 1 ? 'Latest completed move' : `${count} latest completed moves`;
  });

  readonly transactionHistoryToggleLabel = computed(() =>
    this.transactionHistoryExpanded()
      ? 'Show latest 3 moves'
      : `Show ${this.hiddenRecentTransactionCount()} more moves`,
  );

  readonly rosterManagerOpen = computed(() =>
    Boolean(this.rosterManagerArea() && this.rosterManagerSlotId()),
  );

  readonly activeBenchPickerOpen = computed(() => Boolean(this.activeBenchPickerSlotId()));

  readonly benchSwapTimingMessage = computed((): ActiveBenchSwapTimingMessage | null => {
    const preview = this.benchSwapTimingPreview();
    const benchAsset = this.getPendingBenchSwapSlot()?.asset ?? null;
    const activeAsset =
      this.getBenchSwapTargetSlots().find((slot) => slot.slotId === this.benchSwapTargetSlotId())
        ?.asset ?? null;

    if (!benchAsset) {
      return null;
    }

    if (this.isFutureRosterAction()) {
      const requestedCycleNumber = this.rosterActionCycleNumber();
      const effectiveCycleNumber = this.getExpectedFutureSwapCycleNumber();
      const activeName = activeAsset ? this.getRosterAssetName(activeAsset) : 'the open slot';

      if (!requestedCycleNumber || !effectiveCycleNumber) {
        return null;
      }

      const appliesToSelected = requestedCycleNumber === effectiveCycleNumber;
      return {
        tone: appliesToSelected ? 'ready' : 'waiting',
        matchupLabel: `Matchup ${effectiveCycleNumber}`,
        headline: appliesToSelected
          ? activeAsset
            ? `Both players are still untouched in Matchup ${requestedCycleNumber}`
            : `This open-slot start is ready for Matchup ${requestedCycleNumber}`
          : `This lineup change starts in the next fair matchup window`,
        detail: appliesToSelected
          ? activeAsset
            ? `${this.getRosterAssetName(benchAsset)} can replace ${activeName} in the selected matchup. The server verifies both exact game windows again before applying it.`
            : `${this.getRosterAssetName(benchAsset)} can fill the open slot in the selected matchup. The server verifies the incoming game window again before applying it.`
          : `${activeAsset ? `${activeName} or ` : ''}${this.getRosterAssetName(benchAsset)} has already crossed the selected matchup boundary. Matchup ${requestedCycleNumber} stays unchanged, and the incoming player’s expected start moves to Matchup ${effectiveCycleNumber}.`,
      };
    }

    if (this.isPendingBenchSwapInjuryReplacement()) {
      const activeName = activeAsset ? this.getRosterAssetName(activeAsset) : 'The injured starter';
      const currentCycleNumber = this.latestCycle()?.cycleNumber;
      const matchupLabel = currentCycleNumber
        ? `Matchup ${currentCycleNumber}`
        : 'the current matchup';

      return {
        tone: 'ready',
        matchupLabel,
        headline: `This injury replacement takes effect now in ${matchupLabel}`,
        detail: `${activeName} keeps every game and point already started. ${this.getRosterAssetName(benchAsset)} receives only the slot’s remaining future games; earlier bench points never transfer.`,
      };
    }

    if (!preview) {
      return null;
    }

    return buildActiveBenchSwapTimingMessage(
      preview,
      activeAsset ? this.getRosterAssetName(activeAsset) : null,
      this.getRosterAssetName(benchAsset),
    );
  });

  readonly rosterManagerAsset = computed(() => {
    const area = this.rosterManagerArea();
    const slotId = this.rosterManagerSlotId();
    const roster = this.roster();

    if (!area || !slotId || !roster) {
      return null;
    }

    if (area === 'active') {
      return this.isFutureRosterAction()
        ? this.getSelectedRosterDisplaySlot(slotId)?.asset ?? null
        : roster.activeSlots.find((slot) => slot.slotId === slotId)?.asset ?? null;
    }

    if (area === 'bench') {
      return roster.benchSlots.find((slot) => slot.slotId === slotId)?.asset ?? null;
    }

    return roster.irSlots.find((slot) => slot.slotId === slotId)?.asset ?? null;
  });

  readonly rosterManagerActions = computed((): RosterManagementAction[] => {
    if (!this.isOwnTeam()) {
      return [];
    }

    const area = this.rosterManagerArea();
    const slotId = this.rosterManagerSlotId();
    const asset = this.rosterManagerAsset();

    if (!area || !slotId) {
      return [];
    }

    if (this.isFutureRosterAction()) {
      const busy = this.isRosterOperationPending();
      const lineupBlockReason = this.getFutureLineupEditBlockReason();
      const actions: RosterManagementAction[] = asset
        ? [{
            id: 'view',
            label: this.hasSelectedMatchupScoringDetail(slotId)
              ? 'View Scoring Detail'
              : 'View Player Detail',
            detail: this.hasSelectedMatchupScoringDetail(slotId)
              ? 'Open this player’s scoring detail for the selected matchup.'
              : 'Open player information while this matchup assignment is still projected.',
            tone: 'secondary',
            enabled: !busy,
            disabledReason: busy ? 'Wait for the current roster action to finish.' : null,
          }]
        : [];

      if (area === 'active' && asset) {
        const compatibleBenchPlayers = this.getFutureSwapBenchCandidates(
          asset.position,
          slotId,
        );
        actions.push({
          id: 'swap-with-bench',
          label: 'Change Matchup Starter',
          detail: 'Choose a matching lineup option for this matchup. Untouched players change here; otherwise the move starts in the next fair matchup window.',
          tone: 'primary',
          enabled: !busy && !lineupBlockReason && compatibleBenchPlayers.length > 0,
          disabledReason: busy
            ? 'Wait for the current roster action to finish.'
            : lineupBlockReason ||
              (compatibleBenchPlayers.length === 0
                ? `No compatible ${asset.position} bench player is available.`
                : null),
        });
        if (this.isFuturePlannedOpenSlotAssignment(slotId)) {
          actions.push({
            id: 'keep-open',
            label: 'Leave This Slot Open',
            detail: 'Remove this planned starter while preserving every other saved matchup assignment.',
            tone: 'secondary',
            enabled: !busy && !lineupBlockReason,
            disabledReason: busy
              ? 'Wait for the current roster action to finish.'
              : lineupBlockReason,
          });
        }
      } else if (area === 'bench' && asset) {
        const alreadyPlannedToStart = this.isFutureLineupProjectedStarter(asset);
        const matchingSlots = this.getFutureSwapActiveTargets(asset);
        actions.push({
          id: 'start',
          label: 'Move into Starting Lineup',
          detail: 'Choose a matching active slot in this matchup. Started assignments remain unchanged and move the expected start to the next fair matchup.',
          tone: 'primary',
          enabled: !busy && !lineupBlockReason && matchingSlots.length > 0,
          disabledReason: busy
            ? 'Wait for the current roster action to finish.'
            : lineupBlockReason ||
              (alreadyPlannedToStart
                ? `${this.getRosterAssetName(asset)} is already scheduled to start in the selected matchup.`
                : matchingSlots.length === 0
                  ? `No ${asset.position} starting slot is available.`
                  : null),
        });
      }

      return actions;
    }

    const activeSlot =
      area === 'active'
        ? (this.roster()?.activeSlots.find((slot) => slot.slotId === slotId) ?? null)
        : null;
    const benchSlot =
      area === 'bench'
        ? (this.roster()?.benchSlots.find((slot) => slot.slotId === slotId) ?? null)
        : null;
    const irSlot =
      area === 'ir'
        ? (this.roster()?.irSlots.find((slot) => slot.slotId === slotId) ?? null)
        : null;
    const benchReservedForActiveSwap = Boolean(
      benchSlot && this.isBenchSlotReservedForActiveSwap(benchSlot),
    );
    const benchStartTargets = benchSlot?.asset
      ? this.getPositionSlots(benchSlot.asset.position).filter((slot) => !slot.pendingMove)
      : [];
    const canReplaceInjuredPlayerNow = Boolean(
      activeSlot && this.getImmediateInjuryReplacementBenchSlots(activeSlot).length > 0,
    );
    const irBenchTargets = irSlot?.asset
      ? this.getIrBenchActivationTargets().filter(
          (slot) => !this.isBenchSlotReservedForActiveSwap(slot),
        )
      : [];
    const availability = asset?.assetType === 'skater' ? this.getPlayerAvailability(asset) : null;
    const moveToIrDisabledReason = activeSlot
      ? this.getMoveToIrDisabledText(activeSlot)
      : benchSlot && this.getOpenIrSlotCount() <= 0
        ? 'No Injured Reserve (IR) slots are open.'
        : availability
          ? getPlayerIrIneligibleReason(availability)
          : 'Only skaters with a verified Out, IR, or LTIR status can use Injured Reserve.';

    return buildRosterManagementActions({
      area,
      hasAsset: Boolean(asset),
      assetIsSkater: asset?.assetType === 'skater',
      hasPendingMove: Boolean(activeSlot?.pendingMove) || benchReservedForActiveSwap,
      busy: this.rosterMoveLoading(),
      showMoveToIr: Boolean(asset && this.shouldShowMoveToIrAction(asset)),
      canMoveToIr: activeSlot
        ? this.canMoveSlotToIr(activeSlot)
        : benchSlot
          ? this.canMoveBenchSlotToIr(benchSlot)
          : false,
      moveToIrDisabledReason,
      canReplaceInjuredPlayerNow,
      canStartFromBench: benchStartTargets.length > 0,
      startDisabledReason:
        benchSlot?.asset && benchStartTargets.length === 0
          ? `Every ${benchSlot.asset.position} starting slot already has a scheduled move.`
          : null,
      canActivateFromIr: irSlot ? this.canActivateIrSlot(irSlot) : false,
      activateDisabledReason: irSlot ? this.getIrActivationHelp(irSlot) : null,
      canMoveIrToBench: irBenchTargets.length > 0,
      moveIrToBenchDisabledReason:
        irSlot?.asset && irBenchTargets.length === 0
          ? 'Every bench spot is reserved for another scheduled lineup move.'
          : null,
    });
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    readonly clientHealth: ClientHealthService,
    private readonly actionMonitor: CompetitiveActionMonitorService,
  ) {
    this.routeSubscription = this.route.paramMap.subscribe(() => {
      void this.loadTeam();
    });
  }

  ngOnDestroy(): void {
    this.loadGeneration += 1;
    this.rosterOperationGeneration += 1;
    this.futureLineupLoadGeneration += 1;
    this.futureLineupMutationGeneration += 1;
    this.futureLineupTimingGeneration += 1;
    this.futureLineupAuthorityRefreshGeneration += 1;
    this.futureLineupAuthorityRefreshPromise = null;
    this.futureLineupAuthorityRefreshKey = '';
    this.routeSubscription.unsubscribe();
    this.stopLiveListeners();
  }

  canLeaveRosterPage(): boolean {
    return !this.isRosterOperationPending() && !this.futureLineupDirty();
  }

  @HostListener('window:beforeunload', ['$event'])
  protectPendingRosterOperation(event: BeforeUnloadEvent): void {
    if (this.canLeaveRosterPage()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  }

  isRosterOperationPending(): boolean {
    return this.rosterMoveLoading() || this.saving() || this.futureLineupSaving();
  }

  getCompetitiveActionBlockReason(): string {
    return this.clientHealth.competitiveActionBlockReason();
  }

  getCompetitiveActionButtonBlockLabel(): string {
    if (this.clientHealth.competitiveActionNeedsReload()) {
      return 'Reload RinkRat';
    }

    return this.clientHealth.online() ? 'Reconnecting…' : 'Reconnect to Continue';
  }

  private ensureCompetitiveActionReady(): boolean {
    if (!this.isOwnTeam()) {
      this.rosterMoveError.set('This roster is read-only. Only its manager can make changes.');
      return false;
    }

    if (this.clientHealth.competitiveActionsReady()) {
      return true;
    }

    this.rosterMoveError.set(this.getCompetitiveActionBlockReason());
    return false;
  }

  async loadTeam(): Promise<void> {
    const loadGeneration = ++this.loadGeneration;
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (loadGeneration !== this.loadGeneration) {
      return;
    }

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    const viewedOwnerId = this.route.snapshot.paramMap.get('ownerId')?.trim() || user.uid;

    this.stopLiveListeners();
    this.leagueId = leagueId;
    this.userId = user.uid;
    this.viewerUserId.set(user.uid);
    this.viewedOwnerId.set(viewedOwnerId);
    this.loading.set(true);
    this.league.set(null);
    this.team.set(null);
    this.profile.set(null);
    this.teams.set([]);
    this.roster.set(null);
    this.picks.set([]);
    this.transactions.set([]);
    this.transactionsLoading.set(true);
    this.transactionsUnavailable.set(false);
    this.transactionHistoryExpanded.set(false);
    this.latestCycle.set(null);
    this.latestMatchups.set([]);
    this.currentNavigationMatchup.set(null);
    this.cycleScoring.set(null);
    this.futureLineupPlans.set([]);
    this.futureLineupOptionDraft.set(null);
    this.futureLineupOptionCycles.set([]);
    this.futureLineupSchedulePreview.set([]);
    this.futureLineupNhlSeason.set('');
    this.futureLineupWindows.set([]);
    this.futureLineupRosterPicks.set([]);
    this.futureLineupSchedulesByTeam.set({});
    this.futureLineupSourceNhlBlockNumber.set(null);
    this.futureLineupTargetGameIdsByTeam.set({});
    this.futureLineupWindowsConfirmed.set(false);
    this.futureLineupTimingLoading.set(false);
    this.futureLineupTimingError.set('');
    this.selectedFutureLineupCycleNumber.set(null);
    this.futureLineupDraftAssignments.set({});
    this.futureLineupBaselineAssignments.set({});
    this.futureLineupLoading.set(false);
    this.futureLineupSaving.set(false);
    this.futureLineupError.set('');
    this.futureLineupMessage.set('');
    this.futureLineupStale.set(false);
    this.futureLineupSelectionTouched = false;
    this.futureLineupInitialLoadStarted = false;
    this.pendingFutureLineupMutation = null;
    this.clearFutureSwapEffectiveCycleOverride();
    this.futureLineupLoadGeneration += 1;
    this.futureLineupMutationGeneration += 1;
    this.futureLineupTimingGeneration += 1;
    this.futureLineupAuthorityRefreshGeneration += 1;
    this.futureLineupLatestCycleAuthoritySignature = '';
    this.futureLineupAuthorityRefreshPromise = null;
    this.futureLineupAuthorityRefreshKey = '';
    this.closeAllRosterManagementState();
    this.errorMessage.set('');
    this.liveDataWarnings.set([]);

    try {
      const [league, team, profile] = await Promise.all([
        getLeagueById(leagueId),
        getFantasyTeam(leagueId, viewedOwnerId),
        viewedOwnerId === user.uid ? getUserProfile(user.uid).catch(() => null) : null,
      ]);

      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      if (!team) {
        this.team.set(null);
        return;
      }

      this.league.set(league);
      this.team.set(team);
      this.profile.set(profile);
      this.teamName = team.teamName;

      startPlayerAvailabilityListenerForLeague(leagueId);

      if (viewedOwnerId === user.uid) {
        await getOrCreateFantasyRoster(leagueId, user.uid);

        if (loadGeneration !== this.loadGeneration) {
          return;
        }
      }

      this.startLiveListeners(leagueId, viewedOwnerId, viewedOwnerId === user.uid);
      void this.loadPlayerPoolForProjectionFallback();
    } catch (error: unknown) {
      if (loadGeneration === this.loadGeneration) {
        this.errorMessage.set(error instanceof Error ? error.message : 'Unable to load this team.');
      }
    } finally {
      if (loadGeneration === this.loadGeneration) {
        this.loading.set(false);
      }
    }
  }

  getFutureLineupMatchupOptions(): FutureMatchupLineupOption[] {
    const draft = this.futureLineupOptionDraft();
    const options = buildFutureMatchupLineupOptions({
      ownerId: this.viewedOwnerId(),
      teams: this.teams(),
      cycles: this.futureLineupOptionCycles(),
      schedulePreview: this.futureLineupSchedulePreview(),
      currentMatchup: this.currentMatchup(),
      initialNhlBlockNumber: draft?.initialNhlBlockNumber,
    });

    if (options.length > 0) {
      return options;
    }

    const currentMatchup = this.currentMatchup();
    if (!currentMatchup) {
      return [];
    }

    const opponentOwnerId = this.currentOpponentOwnerId();
    const opponentTeamName = opponentOwnerId ? this.getTeamName(opponentOwnerId) : null;

    return [
      {
        cycleNumber: currentMatchup.cycleNumber,
        matchupId: currentMatchup.id,
        opponentOwnerId,
        opponentTeamName,
        phase: currentMatchup.phase,
        timing: 'current',
        materialized: true,
        isBye: opponentOwnerId === null,
        sourceNhlBlockNumber:
          this.latestCycle()?.sourceNhlBlockNumber ?? currentMatchup.cycleNumber,
        label: `Matchup ${currentMatchup.cycleNumber} · ${
          opponentTeamName ? `vs ${opponentTeamName}` : 'Bye'
        } · Current`,
      },
    ];
  }

  getFutureLineupMatchupOptionLabel(option: FutureMatchupLineupOption): string {
    return option.label;
  }

  get futureLineupMatchupOptions(): FutureMatchupLineupOption[] {
    return this.getFutureLineupMatchupOptions();
  }

  get futureLineupInitialLoadingState(): boolean {
    return this.futureLineupLoading() && this.futureLineupPlans().length === 0;
  }

  get futureLineupErrorText(): string {
    return this.futureLineupError();
  }

  get futureLineupSuccessText(): string {
    return this.futureLineupMessage();
  }

  get selectedFutureLineupOption(): FutureMatchupLineupOption | null {
    return this.getSelectedFutureLineupMatchupOption();
  }

  get selectedFutureLineupIsCurrent(): boolean {
    return this.isSelectedFutureLineupCurrent();
  }

  get currentFutureLineupMatchup(): FantasyMatchup | null {
    const selectedCycleNumber = this.selectedFutureLineupCycleNumber();
    const navigationMatchup = this.currentMatchup();

    if (navigationMatchup?.cycleNumber === selectedCycleNumber) {
      return navigationMatchup;
    }

    return this.latestMatchups().find(
      (matchup) =>
        matchup.cycleNumber === selectedCycleNumber &&
        (matchup.teamAOwnerId === this.viewedOwnerId() ||
          matchup.teamBOwnerId === this.viewedOwnerId()),
    ) ?? null;
  }

  get selectedFutureLineupOpponentOwnerId(): string | null {
    return this.getSelectedFutureLineupMatchupOption()?.opponentOwnerId ?? null;
  }

  get futureLineupEditorVisible(): boolean {
    return this.shouldShowFutureLineupEditor();
  }

  get futureLineupTimingLoadingState(): boolean {
    return this.futureLineupTimingLoading();
  }

  get futureLineupTimingErrorText(): string {
    return this.futureLineupTimingError();
  }

  get futureLineupEditBlockText(): string {
    return this.getFutureLineupEditBlockReason();
  }

  get futureLineupValidationText(): string {
    return this.getFutureLineupValidationMessage();
  }

  get futureLineupRoster(): FantasyRoster | null {
    return this.roster();
  }

  get futureLineupOwned(): boolean {
    return this.isOwnTeam();
  }

  get futureLineupHasChanges(): boolean {
    return this.futureLineupDirty();
  }

  get futureLineupEditorRows(): FutureLineupEditorRow[] {
    const roster = this.roster();

    if (!roster) {
      return [];
    }

    return roster.activeSlots.map((slot) => {
      const candidates = this.getFutureLineupCandidates(slot).map((asset) => ({
        asset,
        assignedElsewhere: this.isFutureLineupCandidateAssignedElsewhere(slot, asset),
        key: this.getFutureLineupCandidateKey(asset),
      }));

      return {
        candidates,
        lockReason: this.getFutureLineupSlotLockReason(slot),
        locked: this.isFutureLineupSlotLocked(slot),
        showFallback: !this.hasResolvedFutureLineupAsset(slot),
        slot,
        startDate: this.getFutureLineupStartDate(slot),
      };
    });
  }

  getSelectedFutureLineupMatchupOption(): FutureMatchupLineupOption | null {
    const selectedCycleNumber = this.selectedFutureLineupCycleNumber();

    return (
      this.getFutureLineupMatchupOptions().find(
        (option) => option.cycleNumber === selectedCycleNumber,
      ) ?? null
    );
  }

  getFutureLineupPlanStatusLabel(): string {
    const selectedCycleNumber = this.selectedFutureLineupCycleNumber();
    const selectedOption = this.getSelectedFutureLineupMatchupOption();
    const plan = this.selectedFutureLineupPlan();

    if (!selectedCycleNumber) {
      return 'Matchup pending';
    }

    if (selectedOption?.timing === 'current') {
      return 'Current lineup';
    }

    if (!plan) {
      if (selectedOption?.timing === 'open') {
        return this.isOwnTeam() ? 'In-progress lineup' : 'Read-only lineup';
      }

      return this.isOwnTeam() ? 'Projected lineup' : 'Read-only preview';
    }

    switch (plan.status) {
      case 'partially-applied':
        return 'Partially locked';
      case 'applied':
        return 'Lineup locked';
      case 'conflicted':
        return 'Needs attention';
      case 'planned':
      default:
        return plan.revision > 0 ? 'Saved plan' : 'Current roster preview';
    }
  }

  isSelectedFutureLineupCurrent(): boolean {
    return this.getSelectedFutureLineupMatchupOption()?.timing === 'current';
  }

  getFutureLineupSummaryText(): string {
    const option = this.getSelectedFutureLineupMatchupOption();

    if (!option) {
      return 'Choose a matchup to view its active-slot lineup.';
    }

    const opponentName = option.opponentTeamName ?? 'Bye';

    if (option.timing === 'current') {
      return `Your active lineup for Matchup ${option.cycleNumber} against ${opponentName}. Use the roster board below for legal current-matchup moves.`;
    }

    if (!this.isOwnTeam()) {
      return `Read-only preview for Matchup ${option.cycleNumber} against ${opponentName}. Private future changes are not shown before they take effect.`;
    }

    return `Manage the active lineup for Matchup ${option.cycleNumber} against ${opponentName}. The server rechecks both players, exact NHL puck-drop times, and every six-game boundary when you confirm a move.`;
  }

  selectFutureLineupCycle(value: number | string | null): void {
    const cycleNumber = typeof value === 'number' ? value : Number(value);
    const validOption = this.getFutureLineupMatchupOptions().some(
      (option) => option.cycleNumber === cycleNumber,
    );

    if (!Number.isInteger(cycleNumber) || cycleNumber <= 0 || !validOption) {
      return;
    }

    if (
      cycleNumber === this.selectedFutureLineupCycleNumber() ||
      this.futureLineupDirty() ||
      this.futureLineupLoading() ||
      this.futureLineupSaving() ||
      this.hasPendingFutureLineupSwap() ||
      this.isRosterOperationPending()
    ) {
      return;
    }

    this.futureLineupSelectionTouched = true;
    this.closeAllRosterManagementState();
    this.clearFutureSwapEffectiveCycleOverride();
    this.selectedFutureLineupCycleNumber.set(cycleNumber);
    this.futureLineupMessage.set('');
    this.futureLineupError.set('');
    this.pendingFutureLineupMutation = null;
    this.futureLineupTimingGeneration += 1;
    this.futureLineupWindows.set([]);
    this.futureLineupRosterPicks.set([]);
    this.futureLineupSchedulesByTeam.set({});
    this.futureLineupSourceNhlBlockNumber.set(null);
    this.futureLineupTargetGameIdsByTeam.set({});
    this.futureLineupWindowsConfirmed.set(false);
    this.futureLineupTimingError.set('');
    this.resetFutureLineupDraftFromServer();
    void this.loadFutureLineupTimingEvidence();
  }

  async loadFutureMatchupLineupPlans(): Promise<void> {
    if (this.futureLineupDirty()) {
      return;
    }

    const loadGeneration = ++this.futureLineupLoadGeneration;
    const leagueId = this.leagueId;
    const viewedOwnerId = this.viewedOwnerId();

    this.futureLineupLoading.set(true);
    this.futureLineupError.set('');
    this.futureLineupMessage.set('');

    try {
      const [context, plans] = await withOperationDeadline(
        Promise.all([
          loadFutureMatchupLineupOptionContext(leagueId, this.teams()),
          this.isOwnTeam()
            ? listFutureMatchupLineupPlans(leagueId)
            : Promise.resolve([] as FutureMatchupLineupPlanView[]),
        ]),
        45_000,
        'The matchup lineup refresh was not confirmed within the safety window. Retry when the connection is stable.',
      );

      if (
        loadGeneration !== this.futureLineupLoadGeneration ||
        !this.isCurrentTeamContext(leagueId, viewedOwnerId)
      ) {
        return;
      }

      this.futureLineupOptionDraft.set(context.draft);
      this.futureLineupOptionCycles.set(context.cycles);
      this.futureLineupSchedulePreview.set(context.schedulePreview);
      this.futureLineupNhlSeason.set(context.nhlSeason);
      this.futureLineupPlans.set(
        [...plans].sort((first, second) => first.cycleNumber - second.cycleNumber),
      );
      this.futureLineupStale.set(false);
      this.pendingFutureLineupMutation = null;
      this.syncDefaultFutureLineupSelection();
      this.resetFutureLineupDraftFromServer();
      void this.loadFutureLineupTimingEvidence();
    } catch (error: unknown) {
      if (
        loadGeneration === this.futureLineupLoadGeneration &&
        this.isCurrentTeamContext(leagueId, viewedOwnerId)
      ) {
        this.futureLineupError.set(
          error instanceof Error
            ? error.message
            : 'Future matchup lineups are unavailable right now.',
        );
      }
    } finally {
      if (loadGeneration === this.futureLineupLoadGeneration) {
        this.futureLineupLoading.set(false);
      }
    }
  }

  resetFutureLineupDraft(): void {
    this.futureLineupMessage.set('');
    this.futureLineupError.set('');
    this.pendingFutureLineupMutation = null;
    this.resetFutureLineupDraftFromServer();
  }

  getFutureLineupAssignment(slotId: string): string {
    return this.futureLineupDraftAssignments()[slotId] ?? '';
  }

  getFutureLineupCandidateKey(asset: RosterAsset): string {
    return this.getRosterAssetKey(asset);
  }

  getFutureLineupSlotSelectId(slot: ActiveRosterSlot): string {
    return `future-lineup-${slot.slotId.replace(/[^a-z0-9_-]/gi, '-')}`;
  }

  hasResolvedFutureLineupAsset(slot: ActiveRosterSlot): boolean {
    const assignment = this.getFutureLineupAssignment(slot.slotId);
    return (
      !assignment ||
      this.getFutureLineupCandidates(slot).some(
        (asset) => this.getRosterAssetKey(asset) === assignment,
      )
    );
  }

  getFutureLineupFallbackAssetLabel(slot: ActiveRosterSlot): string {
    const assignment = this.getFutureLineupAssignment(slot.slotId);
    if (!assignment) {
      return 'Open slot';
    }

    const materializedAsset = this.futureLineupWindows().find(
      (window) => window.rosterSlotId === slot.slotId && window.assetKey === assignment,
    )?.asset;
    const asset = materializedAsset ?? this.getFutureLineupAssetByKey(assignment);

    return asset
      ? `${this.getRosterAssetName(asset)} · ${this.getRosterAssetTeamLabel(asset)} · saved`
      : 'Saved roster asset';
  }

  setFutureLineupAssignment(slot: ActiveRosterSlot, value: string | null): void {
    if (
      this.isFutureLineupSlotLocked(slot) ||
      this.futureLineupLoading() ||
      this.futureLineupSaving()
    ) {
      return;
    }

    const nextAssetKey = value?.trim() || null;
    const candidates = this.getFutureLineupCandidates(slot);

    if (!nextAssetKey && slot.asset) {
      this.futureLineupError.set(
        'An occupied active slot cannot be cleared in a future lineup plan.',
      );
      return;
    }

    if (
      nextAssetKey &&
      !candidates.some((asset) => this.getRosterAssetKey(asset) === nextAssetKey)
    ) {
      this.futureLineupError.set('That roster asset is no longer available for this slot.');
      return;
    }

    if (
      nextAssetKey &&
      this.roster()?.activeSlots.some(
        (candidate) =>
          candidate.slotId !== slot.slotId &&
          (this.futureLineupDraftAssignments()[candidate.slotId] ?? null) === nextAssetKey,
      )
    ) {
      this.futureLineupError.set(
        'That player or goalie unit is already planned in another active slot.',
      );
      return;
    }

    this.futureLineupDraftAssignments.update((assignments) => {
      return { ...assignments, [slot.slotId]: nextAssetKey };
    });

    this.futureLineupSelectionTouched = true;
    this.futureLineupMessage.set('');
    this.futureLineupError.set('');
    this.pendingFutureLineupMutation = null;
    void this.loadFutureLineupTimingEvidence(true);
  }

  getFutureLineupCandidates(slot: ActiveRosterSlot): RosterAsset[] {
    const roster = this.roster();
    const cycleNumber = this.selectedFutureLineupCycleNumber();

    if (!roster || !cycleNumber) {
      return [];
    }

    return buildFutureMatchupLineupCandidates(roster, cycleNumber)
      .filter((candidate) =>
        isFutureMatchupCandidateCompatible(candidate, slot.position, slot.slotId),
      )
      .map((candidate) => candidate.asset)
      .sort((first, second) =>
        this.getRosterAssetName(first).localeCompare(this.getRosterAssetName(second)),
      );
  }

  isFutureLineupCandidateAssignedElsewhere(slot: ActiveRosterSlot, asset: RosterAsset): boolean {
    const assetKey = this.getRosterAssetKey(asset);

    return Boolean(
      assetKey &&
      this.roster()?.activeSlots.some(
        (candidate) =>
          candidate.slotId !== slot.slotId &&
          (this.futureLineupDraftAssignments()[candidate.slotId] ?? null) === assetKey,
      ),
    );
  }

  getFutureLineupSelectedAsset(slot: ActiveRosterSlot): RosterAsset | null {
    const assetKey = this.futureLineupDraftAssignments()[slot.slotId] ?? null;

    return assetKey ? this.getFutureLineupAssetByKey(assetKey) : null;
  }

  getFutureLineupSlotResolution(slot: ActiveRosterSlot): FutureMatchupLineupSlotView | null {
    return (
      this.selectedFutureLineupPlan()?.slots.find(
        (plannedSlot) => plannedSlot.rosterSlotId === slot.slotId,
      ) ?? null
    );
  }

  isFutureLineupSlotLocked(slot: ActiveRosterSlot): boolean {
    if (this.getFutureLineupEditBlockReason()) {
      return true;
    }

    if (
      this.futureLineupWindows().some(
        (window) =>
          window.rosterSlotId === slot.slotId && hasFutureMatchupWindowStarted(window),
      )
    ) {
      return true;
    }

    const projectedSlot = this.getFutureLineupProjectedSlot(slot.slotId);
    if (projectedSlot?.locked) {
      return true;
    }

    return false;
  }

  shouldShowFutureLineupEditor(): boolean {
    const option = this.getSelectedFutureLineupMatchupOption();

    if (!option) {
      return false;
    }

    return option.timing !== 'current';
  }

  getFutureLineupSlotLockReason(slot: ActiveRosterSlot): string {
    const globalReason = this.getFutureLineupEditBlockReason();
    if (globalReason) {
      return globalReason;
    }

    if (
      this.futureLineupWindows().some(
        (window) =>
          window.rosterSlotId === slot.slotId && hasFutureMatchupWindowStarted(window),
      )
    ) {
      return 'At least one game in this slot has started. This matchup stays fixed, and a new move begins in the next fair matchup window.';
    }

    const projectedSlot = this.getFutureLineupProjectedSlot(slot.slotId);
    if (projectedSlot?.locked) {
      return (
        projectedSlot.lockReason ??
        'This slot has already materialized for the selected matchup and cannot be changed.'
      );
    }

    return '';
  }

  private getFutureLineupProjectedSlot(slotId: string) {
    const roster = this.roster();
    const cycleNumber = this.selectedFutureLineupCycleNumber();

    if (!roster || !cycleNumber) {
      return null;
    }

    return (
      buildFutureMatchupProjectedLineup({
        cycleNumber,
        roster,
        plan: this.selectedFutureLineupPlan(),
        plans: this.futureLineupPlans(),
        baseCycleNumber: this.getCurrentFutureLineupCycleNumber(),
        windows: this.futureLineupWindows(),
      }).find((slot) => slot.rosterSlotId === slotId) ?? null
    );
  }

  getFutureLineupStartDate(
    slot: ActiveRosterSlot,
    displayedAsset?: RosterAsset | null,
  ): FutureLineupStartDatePresentation {
    const savedWindowCandidate =
      this.futureLineupWindows().find((window) => window.rosterSlotId === slot.slotId) ?? null;
    const selectedOption = this.getSelectedFutureLineupMatchupOption();
    const plannedSlot = this.selectedFutureLineupPlan()?.slots.find(
      (candidate) => candidate.rosterSlotId === slot.slotId,
    ) ?? null;
    const projectedAsset = this.getFutureLineupProjectedSlot(slot.slotId)?.asset ?? null;
    const projectedAssetKey = this.getRosterAssetKey(projectedAsset) || null;
    const displayedAssetKey =
      displayedAsset === undefined ? null : this.getRosterAssetKey(displayedAsset) || null;
    const savedWindow =
      displayedAsset === undefined || savedWindowCandidate?.assetKey === displayedAssetKey
        ? savedWindowCandidate
        : null;
    const assetKey = displayedAsset === undefined
      ? selectedOption?.materialized
        ? savedWindow?.assetKey ??
          (plannedSlot?.resolution === 'planned'
            ? this.futureLineupDraftAssignments()[slot.slotId] ?? projectedAssetKey
            : projectedAssetKey)
        : this.futureLineupDraftAssignments()[slot.slotId] ?? projectedAssetKey
      : displayedAssetKey;
    const asset = displayedAsset === undefined
      ? savedWindow?.asset ?? (assetKey
        ? this.getFutureLineupAssetByKey(assetKey) ?? projectedAsset
        : null)
      : displayedAsset;
    const teamAbbreviation = asset ? this.getFutureLineupScheduleTeam(asset) : null;
    let projectedGames: NhlTeamSeasonGame[] = [];

    if (teamAbbreviation) {
      const schedule = this.futureLineupSchedulesByTeam()[teamAbbreviation] ?? [];
      const sourceNhlBlockNumber = this.futureLineupSourceNhlBlockNumber();

      if (schedule.length > 0 && sourceNhlBlockNumber) {
        try {
          projectedGames = selectFutureMatchupProjectedGames({
            schedule,
            targetGameIds: this.futureLineupTargetGameIdsByTeam()[teamAbbreviation],
            sourceNhlBlockNumber,
            requiredGamesPerCycle:
              this.league()?.scoringRules?.requiredGamesPerCycle ??
              defaultScoringRules.requiredGamesPerCycle,
          });
        } catch {
          projectedGames = [];
        }
      }
    }

    const dateState = resolveFutureMatchupSlotDateState({
      assetKey,
      savedWindow,
      projectedGames,
    });

    if (dateState.source === 'pending' && this.futureLineupTimingLoading()) {
      return {
        confidence: 'pending',
        eyebrow: 'Start date',
        label: 'Calculating…',
        dateTime: null,
      };
    }

    return {
      confidence: dateState.source,
      eyebrow:
        dateState.source === 'saved'
          ? 'Exact start'
          : dateState.source === 'projected'
            ? 'Nominal NHL block'
            : 'Start date',
      label: dateState.label,
      dateTime: dateState.startDate,
    };
  }

  getFutureLineupStartAriaLabel(slot: ActiveRosterSlot): string {
    const startDate = this.isFutureDisplaySlot(slot)
      ? slot.futureStartDate ?? this.getFutureLineupStartDate(slot, slot.asset)
      : this.getFutureLineupStartDate(slot);
    return `${startDate.eyebrow}: ${startDate.label}.`;
  }

  getFutureLineupEditBlockReason(): string {
    if (!this.isOwnTeam()) {
      return 'This future lineup is read-only. Only its manager can make changes.';
    }

    const selectedCycleNumber = this.selectedFutureLineupCycleNumber();
    if (!selectedCycleNumber) {
      return 'Choose a matchup before editing its lineup.';
    }

    const selectedOption = this.getSelectedFutureLineupMatchupOption();
    if (
      selectedCycleNumber === 1 &&
      selectedOption &&
      !selectedOption.materialized
    ) {
      return 'Matchup 1 lineup changes become available when the season matchup starts.';
    }

    if (
      this.isSelectedFutureLineupCurrent() &&
      !this.rosterActionUsesSelectedMatchupAuthority()
    ) {
      return 'The current matchup is managed through the roster board below. Choose a future matchup to plan ahead.';
    }

    if (this.futureLineupTimingLoading() && !this.futureLineupWindowsConfirmed()) {
      return 'Checking lineup boundaries and player dates before edits are enabled.';
    }

    if (!this.futureLineupWindowsConfirmed()) {
      return 'Lineup timing could not be confirmed. Retry the date check before editing.';
    }

    if (this.latestCycle()?.phase === 'playoffs') {
      return 'Future regular-season lineup plans are unavailable after the playoffs begin.';
    }

    if (this.futureLineupStale()) {
      return 'This plan changed on the server. Refresh it before editing.';
    }

    if (!this.clientHealth.competitiveActionsReady()) {
      return this.getCompetitiveActionBlockReason();
    }

    if (this.roster()?.activeSlots.some((slot) => Boolean(slot.pendingMove))) {
      return 'Finish or cancel the pending roster move before saving a future matchup lineup.';
    }

    return '';
  }

  getFutureLineupValidationMessage(): string {
    const roster = this.roster();
    const cycleNumber = this.selectedFutureLineupCycleNumber();

    if (!roster || !cycleNumber) {
      return '';
    }

    return (
      validateFutureMatchupLineupDraft({
        roster,
        cycleNumber,
        slots: this.buildFutureLineupSlotInputs(),
        plan: this.selectedFutureLineupPlan(),
        windows: this.futureLineupWindows(),
      }).issues[0] ?? ''
    );
  }

  canSaveFutureLineup(): boolean {
    return Boolean(
      (this.futureLineupDirty() || !this.selectedFutureLineupPlan()) &&
      !this.futureLineupLoading() &&
      !this.futureLineupSaving() &&
      !this.hasPendingFutureLineupSwap() &&
      !this.getFutureLineupEditBlockReason() &&
      !this.getFutureLineupValidationMessage(),
    );
  }

  canResetFutureLineup(): boolean {
    return (
      this.futureLineupDirty() &&
      !this.futureLineupTimingLoading() &&
      !this.futureLineupSaving() &&
      !this.hasPendingFutureLineupSwap()
    );
  }

  canClearFutureLineup(): boolean {
    const plan = this.selectedFutureLineupPlan();

    return Boolean(
      this.isOwnTeam() &&
      plan &&
      plan.revision > 0 &&
      plan.materializedSlotCount === 0 &&
      plan.status === 'planned' &&
      !this.futureLineupLoading() &&
      !this.futureLineupSaving() &&
      !this.hasPendingFutureLineupSwap() &&
      !this.getFutureLineupEditBlockReason(),
    );
  }

  getFutureLineupSaveLabel(): string {
    return this.futureLineupSaving() && this.pendingFutureLineupMutation?.operation === 'save'
      ? 'Saving lineup…'
      : this.pendingFutureLineupMutation?.operation === 'save'
        ? 'Retry save'
        : this.selectedFutureLineupPlan()
          ? 'Save lineup'
          : 'Save full lineup';
  }

  getFutureLineupErrorRetryLabel(): string {
    if (this.hasPendingFutureLineupSwap() && !this.futureLineupStale()) {
      return 'Retry move';
    }

    if (this.pendingFutureLineupMutation?.operation === 'save' && !this.futureLineupStale()) {
      return 'Retry save';
    }

    if (this.pendingFutureLineupMutation?.operation === 'clear' && !this.futureLineupStale()) {
      return 'Retry clear';
    }

    return 'Retry refresh';
  }

  async retryFutureLineupError(): Promise<void> {
    if (this.hasPendingFutureLineupSwap() && !this.futureLineupStale()) {
      await this.retryPendingFutureLineupSwap();
      return;
    }

    if (this.pendingFutureLineupMutation?.operation === 'save' && !this.futureLineupStale()) {
      await this.saveFutureLineup();
      return;
    }

    if (this.pendingFutureLineupMutation?.operation === 'clear' && !this.futureLineupStale()) {
      await this.clearFutureLineup();
      return;
    }

    await this.loadFutureMatchupLineupPlans();
  }

  hasPendingFutureLineupSwap(): boolean {
    return Boolean(
      this.pendingFutureLineupMutation?.operation === 'swap' &&
      this.pendingFutureLineupMutation.swapRequest,
    );
  }

  getFutureLineupClearLabel(): string {
    return this.futureLineupSaving() && this.pendingFutureLineupMutation?.operation === 'clear'
      ? 'Clearing plan…'
      : this.pendingFutureLineupMutation?.operation === 'clear'
        ? 'Retry clear'
        : 'Clear saved plan';
  }

  async saveFutureLineup(): Promise<void> {
    if (!this.canSaveFutureLineup()) {
      return;
    }

    const cycleNumber = this.selectedFutureLineupCycleNumber();
    if (!cycleNumber) {
      return;
    }

    this.futureLineupSaving.set(true);
    this.futureLineupError.set('');
    this.futureLineupMessage.set('');
    const mutationGeneration = ++this.futureLineupMutationGeneration;
    const actionHandle = this.actionMonitor.begin('lineup-swap');
    let outcome: 'success' | 'error' | 'uncertain' | 'cancelled' = 'error';

    try {
      const authoritySignatureBeforeSave = this.getFutureLineupAuthoritySignature(
        this.futureLineupPlans(),
        this.futureLineupWindows(),
        cycleNumber,
      );
      const freshAuthority = await this.loadFreshFutureLineupAuthority(cycleNumber);

      if (
        mutationGeneration !== this.futureLineupMutationGeneration ||
        cycleNumber !== this.selectedFutureLineupCycleNumber()
      ) {
        outcome = 'cancelled';
        return;
      }

      const authorityChanged =
        authoritySignatureBeforeSave !==
        this.getFutureLineupAuthoritySignature(
          freshAuthority.plans,
          freshAuthority.windows,
          cycleNumber,
        );
      this.applyFreshFutureLineupAuthority(freshAuthority, true);

      if (authorityChanged) {
        this.pendingFutureLineupMutation = null;
        this.futureLineupError.set(
          'The saved plans or lineup boundaries changed while this page was open. Review the refreshed assignments and dates, then save again.',
        );
        void this.loadFutureLineupTimingEvidence(true);
        outcome = 'cancelled';
        return;
      }

      const validationMessage = this.getFutureLineupValidationMessage();
      if (validationMessage) {
        this.pendingFutureLineupMutation = null;
        this.futureLineupError.set(validationMessage);
        outcome = 'cancelled';
        return;
      }

      const slots = this.buildFutureLineupSlotInputs();
      const slotsKey = JSON.stringify(slots);
      const expectedRevision = this.selectedFutureLineupPlan()?.revision ?? 0;
      const pendingMutation = this.pendingFutureLineupMutation;
      const requestId =
        pendingMutation?.operation === 'save' &&
        pendingMutation.cycleNumber === cycleNumber &&
        pendingMutation.expectedRevision === expectedRevision &&
        pendingMutation.slotsKey === slotsKey
          ? pendingMutation.requestId
          : createFutureMatchupLineupRequestId();

      this.pendingFutureLineupMutation = {
        operation: 'save',
        cycleNumber,
        expectedRevision,
        requestId,
        slotsKey,
      };

      const plan = await this.runBoundedRosterOperation(
        saveFutureMatchupLineupPlan({
          leagueId: this.leagueId,
          cycleNumber,
          expectedRevision,
          requestId,
          slots,
        }),
        'The future lineup save',
      );

      if (mutationGeneration !== this.futureLineupMutationGeneration) {
        outcome = 'cancelled';
        return;
      }

      this.replaceFutureLineupPlan(plan);
      this.pendingFutureLineupMutation = null;
      this.futureLineupStale.set(false);
      this.resetFutureLineupDraftFromServer();
      let authorityRefreshConfirmed = true;

      try {
        const refreshedAuthority = await this.loadFreshFutureLineupAuthority(cycleNumber);

        if (
          mutationGeneration !== this.futureLineupMutationGeneration ||
          cycleNumber !== this.selectedFutureLineupCycleNumber()
        ) {
          outcome = 'cancelled';
          return;
        }

        this.applyFreshFutureLineupAuthority(refreshedAuthority, false);
        void this.loadFutureLineupTimingEvidence(true);
      } catch {
        authorityRefreshConfirmed = false;
        this.futureLineupTimingError.set(
          'The lineup was saved, but its latest lock and timing state could not be confirmed. Use Refresh before making another change.',
        );
      }

      this.futureLineupMessage.set(
        authorityRefreshConfirmed
          ? `Matchup ${cycleNumber} lineup saved. The latest slot authority was confirmed.`
          : `Matchup ${cycleNumber} lineup saved. Latest timing confirmation is still pending.`,
      );
      outcome = 'success';
    } catch (error: unknown) {
      if (mutationGeneration !== this.futureLineupMutationGeneration) {
        outcome = 'cancelled';
        return;
      }

      const failure = this.getRosterOperationError(
        error,
        'Unable to save this future matchup lineup.',
      );
      this.futureLineupError.set(failure.message);
      this.futureLineupStale.set(isFutureMatchupLineupRevisionConflict(error));
      outcome = failure.outcome;
    } finally {
      if (mutationGeneration === this.futureLineupMutationGeneration) {
        this.futureLineupSaving.set(false);
      }
      actionHandle.finish(outcome);
    }
  }

  async clearFutureLineup(): Promise<void> {
    if (!this.canClearFutureLineup()) {
      return;
    }

    const plan = this.selectedFutureLineupPlan();
    if (!plan) {
      return;
    }

    const pendingMutation = this.pendingFutureLineupMutation;
    const requestId =
      pendingMutation?.operation === 'clear' &&
      pendingMutation.cycleNumber === plan.cycleNumber &&
      pendingMutation.expectedRevision === plan.revision
        ? pendingMutation.requestId
        : createFutureMatchupLineupRequestId();

    this.pendingFutureLineupMutation = {
      operation: 'clear',
      cycleNumber: plan.cycleNumber,
      expectedRevision: plan.revision,
      requestId,
      slotsKey: '',
    };
    this.futureLineupSaving.set(true);
    this.futureLineupError.set('');
    this.futureLineupMessage.set('');
    const mutationGeneration = ++this.futureLineupMutationGeneration;
    const actionHandle = this.actionMonitor.begin('lineup-swap');
    let outcome: 'success' | 'error' | 'uncertain' | 'cancelled' = 'error';

    try {
      await this.runBoundedRosterOperation(
        clearFutureMatchupLineupPlan({
          leagueId: this.leagueId,
          cycleNumber: plan.cycleNumber,
          expectedRevision: plan.revision,
          requestId,
        }),
        'The future lineup clear',
      );

      if (mutationGeneration !== this.futureLineupMutationGeneration) {
        outcome = 'cancelled';
        return;
      }

      this.futureLineupPlans.update((plans) =>
        plans.filter((candidate) => candidate.cycleNumber !== plan.cycleNumber),
      );
      this.pendingFutureLineupMutation = null;
      this.futureLineupStale.set(false);
      this.resetFutureLineupDraftFromServer();
      let authorityRefreshConfirmed = true;

      try {
        const refreshedAuthority = await this.loadFreshFutureLineupAuthority(plan.cycleNumber);

        if (
          mutationGeneration !== this.futureLineupMutationGeneration ||
          plan.cycleNumber !== this.selectedFutureLineupCycleNumber()
        ) {
          outcome = 'cancelled';
          return;
        }

        this.applyFreshFutureLineupAuthority(refreshedAuthority, false);
        void this.loadFutureLineupTimingEvidence(true);
      } catch {
        authorityRefreshConfirmed = false;
        this.futureLineupTimingError.set(
          'The plan was cleared, but its latest lock and timing state could not be confirmed. Use Refresh before making another change.',
        );
      }

      this.futureLineupMessage.set(
        authorityRefreshConfirmed
          ? `Matchup ${plan.cycleNumber} plan cleared. The latest slot authority was confirmed.`
          : `Matchup ${plan.cycleNumber} plan cleared. Latest timing confirmation is still pending.`,
      );
      outcome = 'success';
    } catch (error: unknown) {
      if (mutationGeneration !== this.futureLineupMutationGeneration) {
        outcome = 'cancelled';
        return;
      }

      const failure = this.getRosterOperationError(
        error,
        'Unable to clear this future matchup lineup.',
      );
      this.futureLineupError.set(failure.message);
      this.futureLineupStale.set(isFutureMatchupLineupRevisionConflict(error));
      outcome = failure.outcome;
    } finally {
      if (mutationGeneration === this.futureLineupMutationGeneration) {
        this.futureLineupSaving.set(false);
      }
      actionHandle.finish(outcome);
    }
  }

  async loadFutureLineupTimingEvidence(reuseLoadedWindows = false): Promise<void> {
    const timingGeneration = ++this.futureLineupTimingGeneration;
    const cycleNumber = this.selectedFutureLineupCycleNumber();
    const ownerId = this.viewedOwnerId();
    const draft = this.futureLineupOptionDraft();
    const season = this.futureLineupNhlSeason();

    this.futureLineupTimingError.set('');

    if (!cycleNumber || !ownerId || !draft || !season) {
      this.futureLineupWindows.set([]);
      this.futureLineupRosterPicks.set([]);
      this.futureLineupWindowsConfirmed.set(false);
      this.futureLineupSchedulesByTeam.set({});
      this.futureLineupSourceNhlBlockNumber.set(null);
      this.futureLineupTargetGameIdsByTeam.set({});
      this.futureLineupTimingLoading.set(false);
      return;
    }

    this.futureLineupTimingLoading.set(true);
    if (!reuseLoadedWindows) {
      this.futureLineupWindowsConfirmed.set(false);
    }

    try {
      let windows = reuseLoadedWindows ? this.futureLineupWindows() : [];

      if (!reuseLoadedWindows) {
        const [ownerWindows, ownerRosterPicks] = await withOperationDeadline(
          Promise.all([
            loadFutureMatchupOwnerWindows(this.leagueId, cycleNumber, ownerId),
            getCycleOwnerRosterPicksOnce(this.leagueId, cycleNumber, ownerId),
          ]),
          30_000,
          'The selected matchup assignments and player dates were not confirmed within the safety window. Retry the date check.',
        );

        if (
          timingGeneration !== this.futureLineupTimingGeneration ||
          cycleNumber !== this.selectedFutureLineupCycleNumber()
        ) {
          return;
        }

        windows = ownerWindows?.windows ?? [];
        this.futureLineupWindows.set(windows);
        this.futureLineupRosterPicks.set(ownerRosterPicks);
        this.futureLineupWindowsConfirmed.set(true);
        this.resetFutureLineupDraftFromServer({ preserveDirty: true });
        this.clearFutureSwapEffectiveCycleOverrideIfIntentChanged();
      }

      const cycle =
        this.futureLineupOptionCycles().find(
          (candidate) => candidate.cycleNumber === cycleNumber,
        ) ?? null;
      const sourceEvidence = resolveFutureMatchupSourceEvidence({
        cycleNumber,
        cycle,
        draft,
        requiredGamesPerCycle:
          this.league()?.scoringRules?.requiredGamesPerCycle ??
          defaultScoringRules.requiredGamesPerCycle,
      });

      this.futureLineupSourceNhlBlockNumber.set(sourceEvidence.sourceNhlBlockNumber);
      this.futureLineupTargetGameIdsByTeam.set(sourceEvidence.targetGameIdsByTeam);

      const assignmentAssets = Object.values(this.futureLineupDraftAssignments())
        .map((assetKey) => (assetKey ? this.getFutureLineupAssetByKey(assetKey) : null))
        .filter((asset): asset is RosterAsset => Boolean(asset));
      const selectedPickAssets = this.futureLineupRosterPicks()
        .map((pick) => pick.asset)
        .filter((asset): asset is DraftableAsset => Boolean(asset));
      const eligibleBenchAssets = (this.roster()?.benchSlots ?? [])
        .map((slot) => slot.asset)
        .filter(
          (asset): asset is RosterAsset =>
            Boolean(asset) && (asset?.eligibleFromCycleNumber ?? 1) <= cycleNumber,
        );
      const eligibleActiveAssets = (this.roster()?.activeSlots ?? [])
        .map((slot) => slot.asset)
        .filter(
          (asset): asset is RosterAsset =>
            Boolean(asset) && (asset?.eligibleFromCycleNumber ?? 1) <= cycleNumber,
        );
      const teamAbbreviations = [
        ...new Set(
          [
            ...selectedPickAssets,
            ...assignmentAssets,
            ...eligibleActiveAssets,
            ...eligibleBenchAssets,
          ]
            .map((asset) => this.getFutureLineupScheduleTeam(asset))
            .filter((team): team is string => Boolean(team)),
        ),
      ];
      const scheduleResult = await withOperationDeadline(
        loadFutureMatchupNhlSchedules(teamAbbreviations, season),
        30_000,
        'The projected player dates were not confirmed within the safety window. Retry the date check.',
      );

      if (
        timingGeneration !== this.futureLineupTimingGeneration ||
        cycleNumber !== this.selectedFutureLineupCycleNumber()
      ) {
        return;
      }

      this.futureLineupSchedulesByTeam.set(scheduleResult.schedulesByTeam);
      const failedTeams = new Set(scheduleResult.failedTeamAbbreviations);
      const incompleteScheduleTeams = teamAbbreviations.filter((teamAbbreviation) => {
        if (failedTeams.has(teamAbbreviation)) {
          return false;
        }

        try {
          selectFutureMatchupProjectedGames({
            schedule: scheduleResult.schedulesByTeam[teamAbbreviation] ?? [],
            targetGameIds: sourceEvidence.targetGameIdsByTeam[teamAbbreviation],
            sourceNhlBlockNumber: sourceEvidence.sourceNhlBlockNumber,
            requiredGamesPerCycle:
              this.league()?.scoringRules?.requiredGamesPerCycle ??
              defaultScoringRules.requiredGamesPerCycle,
          });
          return false;
        } catch {
          return true;
        }
      });
      const timingWarnings = [
        scheduleResult.failedTeamAbbreviations.length > 0
          ? `Schedule data is unavailable for ${scheduleResult.failedTeamAbbreviations.join(', ')}.`
          : '',
        incompleteScheduleTeams.length > 0
          ? `The stable NHL game schedule is incomplete for ${incompleteScheduleTeams.join(', ')}.`
          : '',
      ].filter(Boolean);

      if (timingWarnings.length > 0) {
        this.futureLineupTimingError.set(
          `${timingWarnings.join(' ')} Nominal timing is pending; retry the schedule check.`,
        );
      }
    } catch (error: unknown) {
      if (
        timingGeneration === this.futureLineupTimingGeneration &&
        cycleNumber === this.selectedFutureLineupCycleNumber()
      ) {
        this.futureLineupSchedulesByTeam.set({});
        this.futureLineupTimingError.set(
          error instanceof Error ? error.message : 'Player start dates are unavailable right now.',
        );
      }
    } finally {
      if (timingGeneration === this.futureLineupTimingGeneration) {
        this.futureLineupTimingLoading.set(false);
      }
    }
  }

  private getCurrentFutureLineupCycleNumber(): number {
    return this.latestCycle()?.cycleNumber ?? this.currentNavigationMatchup()?.cycleNumber ?? 1;
  }

  private syncDefaultFutureLineupSelection(): boolean {
    const options = this.getFutureLineupMatchupOptions();
    const selectedCycleNumber = this.selectedFutureLineupCycleNumber();

    if (this.isRosterOperationPending() || this.hasPendingFutureLineupSwap()) {
      return false;
    }

    if (
      this.futureLineupSelectionTouched &&
      options.some((option) => option.cycleNumber === selectedCycleNumber)
    ) {
      return false;
    }

    const defaultCycleNumber =
      options.find((option) => option.cycleNumber === this.getCurrentFutureLineupCycleNumber())
        ?.cycleNumber ??
      options[0]?.cycleNumber ??
      null;

    if (defaultCycleNumber !== selectedCycleNumber) {
      this.closeAllRosterManagementState();
      this.futureLineupTimingGeneration += 1;
      this.clearFutureSwapEffectiveCycleOverride();
      this.selectedFutureLineupCycleNumber.set(defaultCycleNumber);
      this.futureLineupWindows.set([]);
      this.futureLineupRosterPicks.set([]);
      this.futureLineupSchedulesByTeam.set({});
      this.futureLineupSourceNhlBlockNumber.set(null);
      this.futureLineupTargetGameIdsByTeam.set({});
      this.futureLineupWindowsConfirmed.set(false);
      this.futureLineupTimingError.set('');
      this.resetFutureLineupDraftFromServer();
      return true;
    }

    return false;
  }

  private resetFutureLineupDraftFromServer(options?: { preserveDirty?: boolean }): void {
    const cycleNumber = this.selectedFutureLineupCycleNumber();
    const roster = this.roster();

    if (!cycleNumber || !roster) {
      this.futureLineupBaselineAssignments.set({});
      this.futureLineupDraftAssignments.set({});
      return;
    }

    const previousDraft = this.futureLineupDraftAssignments();
    const previousBaseline = this.futureLineupBaselineAssignments();
    const projectedSlots = buildFutureMatchupProjectedLineup({
      cycleNumber,
      roster,
      plan: this.selectedFutureLineupPlan(),
      plans: this.futureLineupPlans(),
      baseCycleNumber: this.getCurrentFutureLineupCycleNumber(),
      windows: this.futureLineupWindows(),
    });
    const assignments = Object.fromEntries(
      projectedSlots.map((slot) => [slot.rosterSlotId, slot.assetKey]),
    ) as Record<string, string | null>;
    const nextDraft = { ...assignments };

    if (options?.preserveDirty) {
      const candidateByAssetKey = new Map(
        buildFutureMatchupLineupCandidates(roster, cycleNumber).map(
          (candidate) => [candidate.assetKey, candidate] as const,
        ),
      );
      const claimedAssetKeys = new Set(
        projectedSlots
          .filter((slot) => slot.locked && slot.assetKey)
          .map((slot) => slot.assetKey as string),
      );
      const authoritativeSlotByAssetKey = new Map(
        projectedSlots.flatMap((slot) =>
          slot.assetKey ? [[slot.assetKey, slot.rosterSlotId] as const] : [],
        ),
      );

      for (const projectedSlot of projectedSlots) {
        if (projectedSlot.locked) {
          continue;
        }

        const slotId = projectedSlot.rosterSlotId;
        const priorDraftAssetKey = previousDraft[slotId] ?? null;
        const priorBaselineAssetKey = previousBaseline[slotId] ?? null;
        const wasDirty =
          Object.hasOwn(previousDraft, slotId) && priorDraftAssetKey !== priorBaselineAssetKey;

        if (!wasDirty) {
          continue;
        }

        if (priorDraftAssetKey === null) {
          const activeSlot = roster.activeSlots.find((slot) => slot.slotId === slotId) ?? null;
          if (!activeSlot?.asset) {
            nextDraft[slotId] = null;
          }
          continue;
        }

        const candidate = candidateByAssetKey.get(priorDraftAssetKey) ?? null;
        if (
          !candidate ||
          claimedAssetKeys.has(priorDraftAssetKey) ||
          (authoritativeSlotByAssetKey.has(priorDraftAssetKey) &&
            authoritativeSlotByAssetKey.get(priorDraftAssetKey) !== slotId) ||
          !isFutureMatchupCandidateCompatible(
            candidate,
            projectedSlot.position,
            projectedSlot.rosterSlotId,
          )
        ) {
          continue;
        }

        nextDraft[slotId] = priorDraftAssetKey;
        claimedAssetKeys.add(priorDraftAssetKey);
      }
    }

    this.futureLineupBaselineAssignments.set(assignments);
    this.futureLineupDraftAssignments.set(nextDraft);
  }

  private getFutureLineupAuthoritySignature(
    plans: readonly FutureMatchupLineupPlanView[],
    windows: readonly FantasyAssetCycleWindow[],
    cycleNumber: number,
  ): string {
    const baseCycleNumber = this.getCurrentFutureLineupCycleNumber();
    const relevantPlans = selectRelevantFutureMatchupAuthorityPlans(
      plans,
      baseCycleNumber,
      cycleNumber,
    )
      .map((plan) => ({
        cycleNumber: plan.cycleNumber,
        revision: plan.revision,
        status: plan.status,
        materializedSlotCount: plan.materializedSlotCount,
        slots: [...plan.slots]
          .sort((first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId))
          .map((slot) => ({
            rosterSlotId: slot.rosterSlotId,
            assetKey: slot.assetKey,
            resolvedAssetKey: slot.resolvedAssetKey ?? null,
            hasResolvedAssetKey: slot.resolvedAssetKey !== undefined,
            resolution: slot.resolution,
            reason: slot.reason ?? null,
          })),
      }));
    const relevantWindows = [...windows]
      .sort((first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId))
      .map((window) => ({
        rosterSlotId: window.rosterSlotId,
        assetKey: window.assetKey,
        status: window.status,
        scheduledGameIds: [...window.scheduledGameIds].sort((first, second) => first - second),
        scheduledGameDates: [...window.scheduledGameDates].sort(),
        firstScheduledGameDate: window.firstScheduledGameDate,
        lastScheduledGameDate: window.lastScheduledGameDate,
        startedAt: window.startedAt,
        completedAt: window.completedAt,
      }));

    return JSON.stringify({ plans: relevantPlans, windows: relevantWindows });
  }

  private async loadFreshFutureLineupAuthority(cycleNumber: number): Promise<{
    plans: FutureMatchupLineupPlanView[];
    windows: FantasyAssetCycleWindow[];
    rosterPicks: DraftPick[];
  }> {
    const ownerId = this.viewedOwnerId();
    const [plans, ownerWindows, rosterPicks] = await withOperationDeadline(
      Promise.all([
        listFutureMatchupLineupPlans(this.leagueId),
        loadFutureMatchupOwnerWindows(this.leagueId, cycleNumber, ownerId),
        getCycleOwnerRosterPicksOnce(this.leagueId, cycleNumber, ownerId),
      ]),
      45_000,
      'The latest lineup authority was not confirmed within the safety window. Retry when the connection is stable.',
    );

    return {
      plans: [...plans].sort((first, second) => first.cycleNumber - second.cycleNumber),
      windows: ownerWindows?.windows ?? [],
      rosterPicks,
    };
  }

  private applyFreshFutureLineupAuthority(
    authority: {
      plans: FutureMatchupLineupPlanView[];
      windows: FantasyAssetCycleWindow[];
      rosterPicks: DraftPick[];
    },
    preserveDirty: boolean,
  ): void {
    this.futureLineupPlans.set(authority.plans);
    this.futureLineupWindows.set(authority.windows);
    this.futureLineupRosterPicks.set(authority.rosterPicks);
    this.futureLineupWindowsConfirmed.set(true);
    this.futureLineupStale.set(false);
    this.resetFutureLineupDraftFromServer({ preserveDirty });
    this.clearFutureSwapEffectiveCycleOverrideIfIntentChanged();
  }

  private getFutureLineupCycleAuthoritySignature(cycle: FantasyCycle | null): string {
    if (!cycle) {
      return 'none';
    }

    const ownerSlotIds = [
      ...(cycle.expectedRosterSlotIdsByOwner?.[this.viewedOwnerId()] ?? []),
    ].sort();
    const sourceTargets = Object.entries(cycle.sourceNhlTargetGameIdsByTeam ?? {})
      .sort(([firstTeam], [secondTeam]) => firstTeam.localeCompare(secondTeam))
      .map(([team, gameIds]) => [
        team,
        [...gameIds].filter(Number.isSafeInteger).sort((first, second) => first - second),
      ]);

    // Deliberately exclude scoring progress and updatedAt. Those fields can
    // change throughout every live game without changing future-lineup authority.
    return JSON.stringify({
      cycleNumber: cycle.cycleNumber,
      status: cycle.status,
      phase: cycle.phase,
      playoffRoundNumber: cycle.playoffRoundNumber ?? null,
      sourceNhlBlockNumber: cycle.sourceNhlBlockNumber ?? null,
      sourceTargets,
      windowSchemaVersion: cycle.windowSchemaVersion ?? 0,
      playerWindowContinuitySchemaVersion: cycle.playerWindowContinuitySchemaVersion ?? 0,
      parentCycleNumber: cycle.parentCycleNumber ?? null,
      overlapsPreviousCycle: cycle.overlapsPreviousCycle === true,
      totalExpectedWindowCount: cycle.totalExpectedWindowCount ?? 0,
      activeWindowCount: cycle.activeWindowCount ?? 0,
      ownerSlotIds,
    });
  }

  private refreshFutureLineupAuthorityFromLiveChange(): Promise<void> {
    const cycleNumber = this.selectedFutureLineupCycleNumber();
    const leagueId = this.leagueId;
    const ownerId = this.viewedOwnerId();

    if (
      !this.isOwnTeam() ||
      !cycleNumber ||
      this.isSelectedFutureLineupCurrent() ||
      !this.futureLineupOptionDraft() ||
      this.futureLineupSaving()
    ) {
      return Promise.resolve();
    }

    const refreshKey = `${leagueId}::${ownerId}::${cycleNumber}`;
    if (
      this.futureLineupAuthorityRefreshPromise &&
      this.futureLineupAuthorityRefreshKey === refreshKey
    ) {
      return this.futureLineupAuthorityRefreshPromise;
    }

    const refreshGeneration = ++this.futureLineupAuthorityRefreshGeneration;
    const refreshPromise = (async () => {
      try {
        const authority = await this.loadFreshFutureLineupAuthority(cycleNumber);

        if (
          refreshGeneration !== this.futureLineupAuthorityRefreshGeneration ||
          cycleNumber !== this.selectedFutureLineupCycleNumber() ||
          !this.isCurrentTeamContext(leagueId, ownerId)
        ) {
          return;
        }

        this.applyFreshFutureLineupAuthority(authority, true);
        void this.loadFutureLineupTimingEvidence(true);
      } catch (error: unknown) {
        if (
          refreshGeneration === this.futureLineupAuthorityRefreshGeneration &&
          cycleNumber === this.selectedFutureLineupCycleNumber() &&
          this.isCurrentTeamContext(leagueId, ownerId)
        ) {
          this.futureLineupTimingError.set(
            error instanceof Error
              ? error.message
              : 'The latest lineup authority could not be confirmed. Use Refresh before saving.',
          );
        }
      }
    })();

    this.futureLineupAuthorityRefreshKey = refreshKey;
    this.futureLineupAuthorityRefreshPromise = refreshPromise;
    void refreshPromise.finally(() => {
      if (this.futureLineupAuthorityRefreshPromise === refreshPromise) {
        this.futureLineupAuthorityRefreshPromise = null;
        this.futureLineupAuthorityRefreshKey = '';
      }
    });
    return refreshPromise;
  }

  private getFutureLineupAssetByKey(assetKey: string): RosterAsset | null {
    const roster = this.roster();
    if (!roster) {
      return null;
    }

    const assets = [
      ...roster.activeSlots.flatMap((slot) =>
        [slot.asset, slot.pendingMove?.incomingAsset ?? null].filter(
          (asset): asset is RosterAsset => Boolean(asset),
        ),
      ),
      ...roster.benchSlots.flatMap((slot) => (slot.asset ? [slot.asset] : [])),
      ...roster.irSlots.flatMap((slot) => (slot.asset ? [slot.asset] : [])),
    ];

    return assets.find((asset) => this.getRosterAssetKey(asset) === assetKey) ?? null;
  }

  private getFutureLineupScheduleTeam(asset: RosterAsset | DraftableAsset): string | null {
    const teamAbbreviation = this.getRosterAssetTeamLabel(asset).trim().toUpperCase();
    return /^[A-Z0-9]{2,4}$/.test(teamAbbreviation) ? teamAbbreviation : null;
  }

  private buildFutureLineupSlotInputs(): FutureMatchupLineupSlotInput[] {
    const assignments = this.futureLineupDraftAssignments();

    return (this.roster()?.activeSlots ?? []).map((slot) => ({
      rosterSlotId: slot.slotId,
      assetKey: assignments[slot.slotId] ?? null,
    }));
  }

  private replaceFutureLineupPlan(plan: FutureMatchupLineupPlanView): void {
    this.futureLineupPlans.update((plans) =>
      [...plans.filter((candidate) => candidate.cycleNumber !== plan.cycleNumber), plan].sort(
        (first, second) => first.cycleNumber - second.cycleNumber,
      ),
    );
  }

  private closeAllRosterManagementState(): void {
    this.rosterManagerArea.set(null);
    this.rosterManagerSlotId.set('');
    this.clearFutureSwapEffectiveCycleOverride();
    this.rosterActionCycleNumber.set(null);
    this.rosterActionUsesSelectedMatchupAuthority.set(false);
    this.irActivationSlotId.set('');
    this.irActivationTargetSlotId.set('');
    this.irActivationBenchSlotId.set('');
    this.irBenchActivationSlotId.set('');
    this.irBenchActivationTargetSlotId.set('');
    this.benchSwapSlotId.set('');
    this.benchSwapTargetSlotId.set('');
    this.benchSwapRestrictedTargetSlotId.set('');
    this.activeBenchPickerSlotId.set('');
    this.rosterDropSource.set(null);
    this.rosterDropSlotId.set('');
  }

  private stopLiveListeners(): void {
    this.stopRosterListener?.();
    this.stopTeamListener?.();
    this.stopPicksListener?.();
    this.stopTransactionsListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopLatestCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopCurrentNavigationMatchupListener?.();
    this.stopSharedScoringListener?.();
    this.stopRosterListener = null;
    this.stopTeamListener = null;
    this.stopPicksListener = null;
    this.stopTransactionsListener = null;
    this.stopCycleRosterPicksListener = null;
    this.stopLatestCycleListener = null;
    this.stopMatchupsListener = null;
    this.stopCurrentNavigationMatchupListener = null;
    this.stopSharedScoringListener = null;
  }

  private recordLiveDataWarning(label: string, error: Error): void {
    const message = `${label}: ${error.message}`;

    this.liveDataWarnings.update((warnings) => [
      ...warnings.filter((warning) => !warning.startsWith(`${label}:`)),
      message,
    ]);
  }

  private clearLiveDataWarning(label: string): void {
    this.liveDataWarnings.update((warnings) =>
      warnings.filter((warning) => !warning.startsWith(`${label}:`)),
    );
  }

  private isCurrentTeamContext(leagueId: string, viewedOwnerId: string): boolean {
    return this.leagueId === leagueId && this.viewedOwnerId() === viewedOwnerId;
  }

  private startLiveListeners(leagueId: string, viewedOwnerId: string, isOwnTeam: boolean): void {
    this.stopLiveListeners();

    this.stopRosterListener = listenToFantasyRoster(
      leagueId,
      viewedOwnerId,
      (roster) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.clearLiveDataWarning('Roster');
        this.roster.set(roster);
        this.resetFutureLineupDraftFromServer({ preserveDirty: true });
        this.clearFutureSwapEffectiveCycleOverrideIfIntentChanged();
        if (!this.isSelectedFutureLineupCurrent() && !this.futureLineupTimingLoading()) {
          if (isOwnTeam) {
            void this.refreshFutureLineupAuthorityFromLiveChange();
          } else {
            void this.loadFutureLineupTimingEvidence();
          }
        }
      },
      (error) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.recordLiveDataWarning('Roster', error);
      },
    );

    this.stopTeamListener = listenToLeagueTeams(
      leagueId,
      (teams) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.clearLiveDataWarning('League teams');
        this.teams.set(teams);

        if (!this.futureLineupInitialLoadStarted) {
          this.futureLineupInitialLoadStarted = true;
          void this.loadFutureMatchupLineupPlans();
        }

        const currentTeam = teams.find((candidate) => candidate.ownerId === viewedOwnerId);

        if (currentTeam) {
          this.team.set(currentTeam);
        } else {
          this.team.set(null);
          this.errorMessage.set('This team is no longer part of the league.');
        }
      },
      (error) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.recordLiveDataWarning('League teams', error);
      },
    );

    this.stopPicksListener = listenToDraftPicks(
      leagueId,
      (picks) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.clearLiveDataWarning('Draft picks');
        this.picks.set(picks);
        void this.loadCurrentCycleScoringIfReady();
      },
      (error) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.recordLiveDataWarning('Draft picks', error);
      },
    );

    if (isOwnTeam) {
      this.stopTransactionsListener = listenToOwnerTransactions(
        leagueId,
        this.userId,
        (transactions) => {
          if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
          this.clearLiveDataWarning('Transactions');
          this.transactionsLoading.set(false);
          this.transactionsUnavailable.set(false);
          this.transactions.set(transactions);
        },
        (error) => {
          if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
          this.transactionsLoading.set(false);
          this.transactionsUnavailable.set(true);
          this.recordLiveDataWarning('Transactions', error);
        },
      );
    }

    this.stopCurrentNavigationMatchupListener = listenToEarliestUnfinishedOwnerMatchup(
      leagueId,
      viewedOwnerId,
      (matchup) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.clearLiveDataWarning('Current matchup navigation');
        this.currentNavigationMatchup.set(matchup);
        if (this.syncDefaultFutureLineupSelection()) {
          void this.loadFutureLineupTimingEvidence();
        } else {
          this.resetFutureLineupDraftFromServer({ preserveDirty: true });
        }
      },
      (error) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.recordLiveDataWarning('Current matchup navigation', error);
      },
    );

    this.stopLatestCycleListener = listenToLatestCycle(
      leagueId,
      (cycle) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.clearLiveDataWarning('Current matchup');
        const cycleAuthoritySignature = this.getFutureLineupCycleAuthoritySignature(cycle);
        const cycleAuthorityChanged =
          this.futureLineupLatestCycleAuthoritySignature !== '' &&
          this.futureLineupLatestCycleAuthoritySignature !== cycleAuthoritySignature;
        this.futureLineupLatestCycleAuthoritySignature = cycleAuthoritySignature;
        this.latestCycle.set(cycle);
        if (cycle) {
          this.futureLineupOptionCycles.update((cycles) =>
            [
              ...cycles.filter((candidate) => candidate.cycleNumber !== cycle.cycleNumber),
              cycle,
            ].sort((first, second) => first.cycleNumber - second.cycleNumber),
          );
        }
        if (this.syncDefaultFutureLineupSelection()) {
          if (isOwnTeam && cycleAuthorityChanged) {
            void this.refreshFutureLineupAuthorityFromLiveChange();
          } else {
            void this.loadFutureLineupTimingEvidence();
          }
        } else {
          this.resetFutureLineupDraftFromServer({ preserveDirty: true });
          if (isOwnTeam && cycleAuthorityChanged && !this.futureLineupTimingLoading()) {
            void this.refreshFutureLineupAuthorityFromLiveChange();
          }
        }
        this.latestMatchups.set([]);
        this.cycleRosterPicks.set([]);
        this.cycleScoring.set(null);
        void this.loadCurrentCycleScoringIfReady();
        this.stopMatchupsListener?.();
        this.stopMatchupsListener = null;
        this.stopCycleRosterPicksListener?.();
        this.stopCycleRosterPicksListener = null;
        this.stopSharedScoringListener?.();
        this.stopSharedScoringListener = null;

        if (!cycle) {
          return;
        }

        this.scoringLoading.set(true);
        this.stopSharedScoringListener = listenToSharedCycleScoring(
          leagueId,
          cycle.cycleNumber,
          (snapshot) => {
            if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
            this.clearLiveDataWarning('Shared scoring');
            this.cycleScoring.set(snapshot?.result ?? null);
            this.scoringLoading.set(false);
            this.scoringError.set('');
          },
          (error) => {
            if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
            this.recordLiveDataWarning('Shared scoring', error);
            this.scoringLoading.set(false);
            this.scoringError.set(error.message);
          },
        );

        this.stopCycleRosterPicksListener = listenToCycleRosterPicks(
          leagueId,
          cycle.cycleNumber,
          (picks) => {
            if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
            this.clearLiveDataWarning('Matchup roster');
            this.cycleRosterPicks.set(picks);
            void this.loadCurrentCycleScoringIfReady();
          },
          (error) => {
            if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
            this.recordLiveDataWarning('Matchup roster', error);
          },
        );

        this.stopMatchupsListener = listenToCycleMatchups(
          leagueId,
          cycle.cycleNumber,
          (matchups) => {
            if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
            this.clearLiveDataWarning('Current matchup');
            this.latestMatchups.set(matchups);
          },
          (error) => {
            if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
            this.recordLiveDataWarning('Current matchup', error);
          },
        );
      },
      (error) => {
        if (!this.isCurrentTeamContext(leagueId, viewedOwnerId)) return;
        this.recordLiveDataWarning('Current matchup', error);
      },
    );
  }

  private async loadCurrentCycleScoringIfReady(): Promise<void> {
    if (this.cycleScoring()) {
      this.scoringLoading.set(false);
      return;
    }

    if (this.latestCycle()) {
      this.scoringLoading.set(true);
    }
  }

  private runBoundedRosterOperation<T>(operation: Promise<T>, actionLabel: string): Promise<T> {
    return withOperationDeadline(
      operation,
      45_000,
      `${actionLabel} was not confirmed within the safety window. This page has been unlocked. Check My Team before retrying because the server request may still finish.`,
    );
  }

  private getRosterOperationError(
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

  async saveTeamName(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    if (!this.isOwnTeam()) {
      this.errorMessage.set('Only this team’s manager can rename it.');
      return;
    }

    const user = auth.currentUser;

    if (!user) {
      this.errorMessage.set('You must be logged in.');
      return;
    }

    const updatedName = this.teamName.trim();

    if (!updatedName) {
      this.errorMessage.set('Team name cannot be empty.');
      return;
    }

    this.saving.set(true);

    try {
      await withOperationDeadline(
        updateTeamName(this.leagueId, user.uid, updatedName),
        25_000,
        'RinkRat stopped waiting for the team-name save. The page has been unlocked; reload My Team before submitting the same name again.',
      );

      const currentTeam = this.team();

      if (currentTeam) {
        this.team.set({
          ...currentTeam,
          teamName: updatedName,
        });
      }

      this.successMessage.set('Team name updated!');

      setTimeout(() => {
        this.successMessage.set('');
      }, 2200);
    } catch (error: unknown) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to update team name.');
    } finally {
      this.saving.set(false);
    }
  }

  openRosterManager(area: RosterManagementArea, slotId: string): void {
    if (
      !this.isOwnTeam() ||
      !slotId ||
      this.isRosterOperationPending() ||
      this.hasPendingFutureLineupSwap()
    ) {
      return;
    }

    this.clearFutureSwapEffectiveCycleOverride();
    const selectedOption = this.getSelectedFutureLineupMatchupOption();
    this.rosterActionUsesSelectedMatchupAuthority.set(
      this.shouldUseSelectedMatchupRosterAuthorityForAction(
        selectedOption,
        area,
        slotId,
      ),
    );
    this.rosterActionCycleNumber.set(
      area !== 'ir' && selectedOption
        ? selectedOption.cycleNumber
        : this.latestCycle()?.cycleNumber ?? this.currentMatchup()?.cycleNumber ?? null,
    );
    this.rosterManagerArea.set(area);
    this.rosterManagerSlotId.set(slotId);
  }

  isFutureRosterAction(): boolean {
    const cycleNumber = this.rosterActionCycleNumber();
    return Boolean(this.rosterActionUsesSelectedMatchupAuthority() && cycleNumber);
  }

  private shouldUseSelectedMatchupRosterAuthorityForAction(
    option: FutureMatchupLineupOption | null,
    area: RosterManagementArea,
    slotId: string,
  ): boolean {
    const roster = this.roster();

    if (!option || !roster) {
      return false;
    }

    const planResolutionBySlotId = new Map(
      (this.selectedFutureLineupPlan()?.slots ?? []).map(
        (slot) => [slot.rosterSlotId, slot.resolution] as const,
      ),
    );
    const managedAsset = area === 'bench'
      ? roster.benchSlots.find((slot) => slot.slotId === slotId)?.asset ?? null
      : null;

    return shouldUseSelectedMatchupRosterAuthority({
      timing: option.timing,
      area,
      slotId,
      windowsConfirmed: this.futureLineupWindowsConfirmed(),
      managedAssetKey: this.getRosterAssetKey(managedAsset) || null,
      managedAssetPosition: managedAsset?.position ?? null,
      selectedActiveSlots: this.getFutureRosterDisplaySlots().map((slot) => ({
        slotId: slot.slotId,
        position: slot.position,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
        resolution: planResolutionBySlotId.get(slot.slotId) ?? null,
      })),
      physicalActiveSlots: roster.activeSlots.map((slot) => ({
        slotId: slot.slotId,
        position: slot.position,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
      })),
    });
  }

  private getFutureSwapBenchCandidates(
    position: DraftPosition,
    activeSlotId = '',
  ): BenchRosterSlot[] {
    const projectedAssetKeys = this.getFutureProjectedActiveAssetKeys();
    const roster = this.roster();
    const physicalCandidates = (roster?.benchSlots ?? []).filter((slot) =>
      Boolean(
        slot.asset &&
        slot.asset.position === position &&
        !this.isBenchSlotReservedForActiveSwap(slot) &&
        !projectedAssetKeys.has(this.getRosterAssetKey(slot.asset)),
      ),
    );

    if (!activeSlotId || !roster) {
      return physicalCandidates;
    }

    const plannedSlot = this.selectedFutureLineupPlan()?.slots.find(
      (slot) => slot.rosterSlotId === activeSlotId,
    ) ?? null;
    const projectedSlot = this.getSelectedRosterDisplaySlot(activeSlotId);
    const physicalActiveSlot = roster.activeSlots.find(
      (slot) => slot.slotId === activeSlotId,
    ) ?? null;
    const projectedAssetKey = this.getRosterAssetKey(projectedSlot?.asset);
    const physicalActiveAssetKey = this.getRosterAssetKey(physicalActiveSlot?.asset);

    if (
      plannedSlot?.resolution !== 'planned' ||
      !plannedSlot.assetKey ||
      plannedSlot.assetKey !== projectedAssetKey ||
      !physicalActiveSlot?.asset ||
      physicalActiveSlot.position !== position ||
      !physicalActiveAssetKey ||
      projectedAssetKeys.has(physicalActiveAssetKey) ||
      (physicalActiveSlot.asset.eligibleFromCycleNumber ?? 1) >
        (this.rosterActionCycleNumber() ?? 0)
    ) {
      return physicalCandidates;
    }

    const plannedAssetBenchSlots = roster.benchSlots.filter(
      (slot) =>
        this.getRosterAssetKey(slot.asset) === plannedSlot.assetKey &&
        !this.isBenchSlotReservedForActiveSwap(slot),
    );

    if (plannedAssetBenchSlots.length !== 1) {
      return physicalCandidates;
    }

    return [
      ...physicalCandidates,
      {
        ...plannedAssetBenchSlots[0],
        asset: physicalActiveSlot.asset,
      },
    ];
  }

  isFuturePlannedReversalCandidate(
    candidate: BenchRosterSlot,
    activeSlotId: string,
  ): boolean {
    if (!this.isFutureRosterAction() || !candidate.asset || !activeSlotId) {
      return false;
    }

    const roster = this.roster();
    const physicalActiveSlot = roster?.activeSlots.find(
      (slot) => slot.slotId === activeSlotId,
    ) ?? null;
    const physicalBenchSlot = roster?.benchSlots.find(
      (slot) => slot.slotId === candidate.slotId,
    ) ?? null;
    const plannedSlot = this.selectedFutureLineupPlan()?.slots.find(
      (slot) => slot.rosterSlotId === activeSlotId,
    ) ?? null;

    return Boolean(
      physicalActiveSlot?.asset &&
      physicalBenchSlot?.asset &&
      plannedSlot?.resolution === 'planned' &&
      plannedSlot.assetKey === this.getRosterAssetKey(physicalBenchSlot.asset) &&
      this.getRosterAssetKey(candidate.asset) ===
        this.getRosterAssetKey(physicalActiveSlot.asset) &&
      plannedSlot.assetKey !== this.getRosterAssetKey(candidate.asset),
    );
  }

  getFutureSwapCandidateSourceLabel(
    candidate: BenchRosterSlot,
    activeSlotId: string,
  ): string {
    if (this.isFuturePlannedReversalCandidate(candidate, activeSlotId)) {
      return 'Current roster starter · Restore for this matchup';
    }

    return candidate.asset
      ? `${this.getRosterAssetTeamLabel(candidate.asset)} · ${candidate.asset.position} · Bench ${candidate.slotNumber}`
      : `Bench ${candidate.slotNumber}`;
  }

  private isFuturePlannedOpenSlotAssignment(activeSlotId: string): boolean {
    const physicalSlot = this.roster()?.activeSlots.find(
      (slot) => slot.slotId === activeSlotId,
    ) ?? null;
    const plannedSlot = this.selectedFutureLineupPlan()?.slots.find(
      (slot) => slot.rosterSlotId === activeSlotId,
    ) ?? null;
    const selectedWindow = this.futureLineupWindows().find(
      (window) => window.rosterSlotId === activeSlotId,
    ) ?? null;

    return Boolean(
      !physicalSlot?.asset &&
      !selectedWindow &&
      plannedSlot?.resolution === 'planned' &&
      plannedSlot.assetKey,
    );
  }

  private hasSelectedPlannedAssignment(activeSlotId: string): boolean {
    return this.selectedFutureLineupPlan()?.slots.some(
      (slot) =>
        slot.rosterSlotId === activeSlotId &&
        slot.resolution === 'planned' &&
        Boolean(slot.assetKey),
    ) ?? false;
  }

  private clearFuturePlannedOpenSlot(activeSlotId: string): void {
    if (!this.isFuturePlannedOpenSlotAssignment(activeSlotId)) {
      return;
    }

    this.futureLineupDraftAssignments.update((assignments) => ({
      ...assignments,
      [activeSlotId]: null,
    }));
    this.closeRosterManager();
    void this.saveFutureLineup();
  }

  private getFutureSwapActiveTargets(asset: RosterAsset): ActiveRosterDisplaySlot[] {
    const incomingAssetKey = this.getRosterAssetKey(asset);

    if (!incomingAssetKey || this.isFutureLineupProjectedStarter(asset)) {
      return [];
    }

    return this.getFutureDisplayPositionSlots(asset.position).filter(
      (slot) =>
        !slot.assignmentPending &&
        (!slot.asset || this.getRosterAssetKey(slot.asset) !== incomingAssetKey),
    );
  }

  private isFutureLineupProjectedStarter(asset: RosterAsset): boolean {
    const assetKey = this.getRosterAssetKey(asset);

    return Boolean(assetKey && this.getFutureProjectedActiveAssetKeys().has(assetKey));
  }

  private getFutureProjectedActiveAssetKeys(): Set<string> {
    return new Set(
      this.getFutureRosterDisplaySlots()
        .map((slot) => this.getRosterAssetKey(slot.asset))
        .filter((assetKey) => Boolean(assetKey)),
    );
  }

  private hasProjectedNhlBlockStarted(asset: RosterAsset | null): boolean | null {
    if (!asset) {
      return null;
    }

    const projectedGames = this.getFutureProjectedGamesForAsset(asset);
    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    if (projectedGames.length !== requiredGames) {
      return null;
    }

    return projectedGames.some((game) => this.hasProjectedNhlGameStarted(game));
  }

  private hasProjectedNhlGameStarted(game: NhlTeamSeasonGame): boolean {
    const state = String(game.gameState ?? '').toUpperCase();
    const startMilliseconds = game.startTimeUTC
      ? Date.parse(game.startTimeUTC)
      : Number.NaN;
    const hasFinalScores =
      typeof game.homeTeam.score === 'number' && typeof game.awayTeam.score === 'number';

    return (
      state === 'LIVE' ||
      state === 'CRIT' ||
      state === 'FINAL' ||
      state === 'OFF' ||
      hasFinalScores ||
      (Number.isFinite(startMilliseconds) && startMilliseconds <= Date.now())
    );
  }

  private getFutureSwapIntent(
    benchSlot: BenchRosterSlot | null = this.getPendingBenchSwapSlot(),
    activeSlot: ActiveRosterSlot | null = this.getBenchSwapTargetSlots().find(
      (slot) => slot.slotId === this.benchSwapTargetSlotId(),
    ) ?? null,
  ): FutureMatchupSwapIntent | null {
    const requestedCycleNumber = this.rosterActionCycleNumber();
    const outgoingAssetKey = this.getRosterAssetKey(activeSlot?.asset) || null;
    const incomingAssetKey = this.getRosterAssetKey(benchSlot?.asset);

    if (
      !requestedCycleNumber ||
      !activeSlot ||
      !benchSlot ||
      !incomingAssetKey
    ) {
      return null;
    }

    return {
      requestedCycleNumber,
      activeSlotId: activeSlot.slotId,
      benchSlotId: benchSlot.slotId,
      outgoingAssetKey,
      incomingAssetKey,
    };
  }

  private clearFutureSwapEffectiveCycleOverride(): void {
    this.futureSwapEffectiveCycleOverride.set(null);
  }

  private clearFutureSwapEffectiveCycleOverrideIfIntentChanged(): void {
    const override = this.futureSwapEffectiveCycleOverride();
    const intent = this.getFutureSwapIntent();

    if (
      override &&
      (!intent ||
        getFutureMatchupSwapIntentKey(override) !== getFutureMatchupSwapIntentKey(intent))
    ) {
      this.clearFutureSwapEffectiveCycleOverride();
    }
  }

  private getExpectedFutureSwapCycleNumber(): number | null {
    if (!this.isFutureRosterAction()) {
      return null;
    }

    const requestedCycleNumber = this.rosterActionCycleNumber();
    const benchSlot = this.getPendingBenchSwapSlot();
    const activeSlot = this.getBenchSwapTargetSlots().find(
      (slot) => slot.slotId === this.benchSwapTargetSlotId(),
    );

    if (!requestedCycleNumber || !benchSlot?.asset || !activeSlot) {
      return null;
    }

    const activeAssetKey = this.getRosterAssetKey(activeSlot.asset) || null;
    const selectedWindow = this.futureLineupWindows().find(
      (window) =>
        window.rosterSlotId === activeSlot.slotId &&
        activeAssetKey !== null &&
        window.assetKey === activeAssetKey,
    );
    const outgoingStarted = activeSlot.asset
      ? selectedWindow
        ? hasFutureMatchupWindowStarted(selectedWindow) ||
          this.hasProjectedNhlBlockStarted(activeSlot.asset)
        : this.hasProjectedNhlBlockStarted(activeSlot.asset)
      : selectedWindow
        ? null
        : false;
    const incomingStarted = this.hasProjectedNhlBlockStarted(benchSlot.asset);

    if (outgoingStarted === null || incomingStarted === null) {
      return null;
    }

    const earliestEligibleCycle = Math.max(
      requestedCycleNumber,
      benchSlot.asset.eligibleFromCycleNumber ?? requestedCycleNumber,
    );
    const predictedEffectiveCycleNumber = outgoingStarted || incomingStarted
      ? Math.max(requestedCycleNumber + 1, earliestEligibleCycle)
      : earliestEligibleCycle;

    return resolveFutureMatchupSwapEffectiveCycle({
      predictedEffectiveCycleNumber,
      intent: this.getFutureSwapIntent(benchSlot, activeSlot),
      override: this.futureSwapEffectiveCycleOverride(),
    });
  }

  closeRosterManager(preserveActionContext = false): void {
    if (this.isRosterOperationPending()) {
      return;
    }

    this.rosterManagerArea.set(null);
    this.rosterManagerSlotId.set('');
    if (!preserveActionContext) {
      this.clearFutureSwapEffectiveCycleOverride();
      this.rosterActionCycleNumber.set(null);
      this.rosterActionUsesSelectedMatchupAuthority.set(false);
    }
  }

  getRosterManagerTitle(): string {
    return this.getRosterManagerSlotLabel();
  }

  getRosterManagerEyebrow(): string {
    const cycleNumber = this.rosterActionCycleNumber();
    return this.isFutureRosterAction() && cycleNumber
      ? `Manage Matchup ${cycleNumber}`
      : 'Manage Roster Spot';
  }

  getRosterManagerDescription(): string {
    const asset = this.rosterManagerAsset();
    const area = this.rosterManagerArea();

    if (this.isFutureRosterAction()) {
      const cycleNumber = this.rosterActionCycleNumber();
      return area === 'bench'
        ? `Choose whether this bench player should start in Matchup ${cycleNumber}. The server keeps any started assignment intact and moves the expected start when needed.`
        : `Manage this Matchup ${cycleNumber} assignment. If both players are untouched, the swap applies here; otherwise it begins in the next fair matchup window.`;
    }

    if (!asset) {
      return area === 'bench'
        ? 'This bench spot is open. Choose a player without changing an active six-game count.'
        : 'This starting slot is open. Add / Drop will keep the exact position and slot selected.';
    }

    if (area === 'bench') {
      return 'Bench players are owned but do not score until they enter a starting roster slot.';
    }

    if (area === 'ir') {
      return 'Choose only a legal Injured Reserve action. RinkRat will explain the roster consequence before confirmation.';
    }

    return 'Manage this roster spot without changing any games that have already counted.';
  }

  getActiveBenchPickerTitle(): string {
    if (this.isFutureRosterAction()) {
      return `Choose a Matchup ${this.rosterActionCycleNumber()} Bench Player`;
    }

    return this.isActiveBenchPickerInjuryReplacement()
      ? 'Replace Injured Player Now'
      : 'Swap with Bench';
  }

  getActiveBenchPickerEyebrow(): string {
    if (this.isFutureRosterAction()) {
      return 'Selected Matchup Lineup';
    }

    return this.isActiveBenchPickerInjuryReplacement()
      ? 'Immediate Injury Replacement'
      : 'Active Lineup Change';
  }

  getActiveBenchPickerDescription(): string {
    if (this.isFutureRosterAction()) {
      return `Choose the compatible bench player for this exact Matchup ${this.rosterActionCycleNumber()} slot. If both assignments are untouched, the server changes the selected matchup; if either has started, it preserves this matchup and schedules the next fair one.`;
    }

    return this.isActiveBenchPickerInjuryReplacement()
      ? 'Choose the compatible bench player who should take only this slot’s remaining future games. All games and points already started stay protected.'
      : 'Choose a compatible bench player for this exact active roster spot. RinkRat will verify whether the swap happens now or at the next fair matchup boundary. A current Day-to-Day, Out, IR, or LTIR report can qualify the pairing for the protected immediate-injury route.';
  }

  getBenchSwapDialogEyebrow(): string {
    if (this.isFutureRosterAction()) {
      return `Matchup ${this.rosterActionCycleNumber()} Lineup Change`;
    }

    return this.isPendingBenchSwapInjuryReplacement()
      ? 'Injury Replacement'
      : 'Fair Lineup Change';
  }

  getBenchSwapDialogDescription(): string {
    if (this.isFutureRosterAction()) {
      return `Choose the exact active slot for Matchup ${this.rosterActionCycleNumber()}. Untouched assignments apply to this matchup. If a selected assignment has started, this matchup stays unchanged and the incoming player’s expected start moves to the next fair matchup.`;
    }

    return 'Choose a matching active slot. Normal swaps follow six-game timing. Only players listed as Day-to-Day, Out, Injured Reserve, or Long-Term Injured Reserve can be replaced immediately. The server verifies that status again before changing the roster.';
  }

  getRosterManagerSlotLabel(): string {
    const area = this.rosterManagerArea();
    const slotId = this.rosterManagerSlotId();
    const roster = this.roster();

    if (!area || !slotId || !roster) {
      return 'Roster Spot';
    }

    if (area === 'active') {
      const slot = this.isFutureRosterAction()
        ? this.getSelectedRosterDisplaySlot(slotId)
        : roster.activeSlots.find((candidate) => candidate.slotId === slotId);
      return slot ? `${slot.position} Slot ${slot.slotNumber}` : slotId;
    }

    if (area === 'bench') {
      const slot = roster.benchSlots.find((candidate) => candidate.slotId === slotId);
      return slot ? `Bench ${slot.slotNumber}` : slotId;
    }

    const slot = roster.irSlots.find((candidate) => candidate.slotId === slotId);
    return slot ? `Injured Reserve ${slot.slotNumber}` : slotId;
  }

  getRosterManagerMeta(): string {
    const asset = this.rosterManagerAsset();

    if (!asset) {
      return this.getRosterManagerSlotLabel();
    }

    const matchupLabel = this.isFutureRosterAction()
      ? ` · Matchup ${this.rosterActionCycleNumber()}`
      : '';
    return `${this.getRosterAssetTeamLabel(asset)} · ${asset.position} · ${this.getRosterManagerSlotLabel()}${matchupLabel}`;
  }

  getRosterManagerPendingMoveText(): string {
    if (this.rosterManagerArea() !== 'active') {
      return '';
    }

    if (this.isFutureRosterAction()) {
      return this.getSelectedRosterDisplaySlot(this.rosterManagerSlotId())
        ?.nextPlannedAssetLabel ?? '';
    }

    const slot = this.roster()?.activeSlots.find(
      (candidate) => candidate.slotId === this.rosterManagerSlotId(),
    );

    return slot?.pendingMove ? this.getPendingRosterMoveText(slot) : '';
  }

  getRosterManagerActionClass(action: RosterManagementAction): string {
    return `roster-manager-action roster-manager-action--${action.tone}`;
  }

  handleRosterManagerAction(actionId: RosterManagementActionId): void {
    if (!this.isOwnTeam()) {
      return;
    }

    const action = this.rosterManagerActions().find((candidate) => candidate.id === actionId);
    const area = this.rosterManagerArea();
    const slotId = this.rosterManagerSlotId();
    const asset = this.rosterManagerAsset();

    if (!action?.enabled || !area || !slotId) {
      return;
    }

    switch (actionId) {
      case 'view':
        this.closeRosterManager();
        if (asset) {
          this.openRosterAssetDetail(asset, area === 'active' ? slotId : '');
        }
        return;

      case 'find-player':
        this.closeRosterManager();
        void this.openFreeAgentsForRosterSlot(area, slotId);
        return;

      case 'review-scheduled':
        this.closeRosterManager();
        void this.router.navigate(['/leagues', this.leagueId, 'players'], {
          queryParams: { focus: 'pending-moves' },
          fragment: 'pending-roster-moves',
        });
        return;

      case 'swap-with-bench':
      case 'replace-injured-now':
        this.closeRosterManager(true);
        this.beginActiveBenchSwapPicker(slotId);
        return;

      case 'keep-open':
        this.clearFuturePlannedOpenSlot(slotId);
        return;

      case 'start':
        this.closeRosterManager(true);
        this.beginBenchSwap(slotId);
        return;

      case 'move-to-ir':
        this.closeRosterManager();
        if (area === 'active') {
          void this.moveActiveSlotToIr(slotId);
        } else if (area === 'bench') {
          void this.moveBenchSlotToIr(slotId);
        }
        return;

      case 'activate':
        this.closeRosterManager();
        this.beginIrActivation(slotId);
        return;

      case 'move-to-bench':
        this.closeRosterManager();
        this.beginIrBenchActivation(slotId);
        return;

      case 'drop':
        this.closeRosterManager();
        this.beginRosterDrop(area, slotId);
        return;
    }
  }

  async openFreeAgentsForRosterSlot(area: RosterManagementArea, slotId: string): Promise<void> {
    if (!this.isOwnTeam()) {
      return;
    }

    const roster = this.roster();

    if (!roster) {
      return;
    }

    const activeSlot =
      area === 'active'
        ? (roster.activeSlots.find((slot) => slot.slotId === slotId) ?? null)
        : null;
    const benchSlot =
      area === 'bench' ? (roster.benchSlots.find((slot) => slot.slotId === slotId) ?? null) : null;
    const position = activeSlot?.position ?? benchSlot?.asset?.position ?? null;
    const query = buildFreeAgentRosterTargetQuery(area, position, slotId);

    if (!query) {
      return;
    }

    await this.router.navigate(['/leagues', this.leagueId, 'players'], {
      queryParams: {
        ...query,
        tab: 'available',
      },
    });
  }

  getBenchSlots(): BenchRosterSlot[] {
    return this.roster()?.benchSlots ?? [];
  }

  getOpenBenchSlotCount(): number {
    return this.roster()?.benchSlots.filter((slot) => slot.asset === null).length ?? 0;
  }

  getIrSlots(): IrRosterSlot[] {
    return this.roster()?.irSlots ?? [];
  }

  getOpenIrSlotCount(): number {
    return this.roster()?.irSlots.filter((slot) => slot.asset === null).length ?? 0;
  }

  getRosterMoveEffectiveCycleNumber(): number {
    return (this.latestCycle()?.cycleNumber ?? 0) + 1;
  }

  getRosterMoveEffectiveLabel(): string {
    return `Matchup ${this.getRosterMoveEffectiveCycleNumber()}`;
  }

  getPlayerAvailability(asset: RosterAsset): PlayerAvailability | null {
    if (asset.assetType !== 'skater') {
      return null;
    }

    return getPlayerAvailabilityForPlayer(asset.player);
  }

  shouldShowPlayerAvailabilityBadge(asset: RosterAsset): boolean {
    const availability = this.getPlayerAvailability(asset);

    return availability ? shouldDisplayPlayerAvailability(availability) : false;
  }

  getPlayerAvailabilityLabel(asset: RosterAsset): string {
    return this.getPlayerAvailability(asset)?.shortLabel ?? '';
  }

  getPlayerAvailabilityClass(asset: RosterAsset): string {
    const availability = this.getPlayerAvailability(asset);

    return availability ? getPlayerAvailabilityStatusClass(availability.status) : '';
  }

  getPlayerAvailabilityNote(asset: RosterAsset): string {
    return this.getPlayerAvailability(asset)?.note ?? '';
  }

  isPlayerIrEligible(asset: RosterAsset): boolean {
    const availability = this.getPlayerAvailability(asset);

    return availability ? isPlayerIrEligible(availability.status) : false;
  }

  isIrAssetNoLongerEligible(asset: SkaterRosterAsset): boolean {
    return !this.isPlayerIrEligible(asset);
  }

  getIrEligibilityStatusText(asset: SkaterRosterAsset): string {
    const availability = this.getPlayerAvailability(asset);

    if (!availability) {
      return '';
    }

    if (availability.irEligible) {
      return `${availability.label} · Injured Reserve (IR) eligible`;
    }

    return `${availability.label} · Activation recommended when a roster slot is available`;
  }

  canMoveSlotToIr(slot: ActiveRosterSlot): boolean {
    return Boolean(
      this.isOwnTeam() &&
      slot.asset &&
      slot.asset.assetType === 'skater' &&
      this.isPlayerIrEligible(slot.asset) &&
      this.getOpenIrSlotCount() > 0 &&
      !slot.pendingMove &&
      this.clientHealth.competitiveActionsReady() &&
      !this.rosterMoveLoading(),
    );
  }

  getMoveToIrDisabledText(slot: ActiveRosterSlot): string {
    if (!slot.asset) {
      return '';
    }

    if (slot.pendingMove) {
      return 'A move is already scheduled for this slot.';
    }

    if (slot.asset.assetType !== 'skater') {
      return 'Goalie units cannot be moved to Injured Reserve (IR).';
    }

    const availability = this.getPlayerAvailability(slot.asset);

    if (availability && !availability.irEligible) {
      return getPlayerIrIneligibleReason(availability);
    }

    if (this.getOpenIrSlotCount() <= 0) {
      return 'No Injured Reserve (IR) slots are open.';
    }

    return '';
  }

  canActivateIrSlot(slot: IrRosterSlot): boolean {
    if (!this.isOwnTeam() || !slot.asset || this.rosterMoveLoading()) {
      return false;
    }

    const activeSlots = this.getActiveSlotsForIrAsset(slot.asset);
    return (
      activeSlots.some((activeSlot) => activeSlot.asset === null) ||
      (activeSlots.length > 0 && this.getIrActivationBenchTargets().length > 0)
    );
  }

  getIrActivationHelp(slot: IrRosterSlot): string {
    if (!slot.asset) {
      return 'Open Injured Reserve (IR) slot';
    }

    const activeSlots = this.getActiveSlotsForIrAsset(slot.asset);
    const openSlot = activeSlots.find((activeSlot) => activeSlot.asset === null);
    const availability = this.getPlayerAvailability(slot.asset);

    if (activeSlots.length === 0) {
      return `No ${slot.asset.position} roster slots were found.`;
    }

    if (openSlot) {
      return availability && !availability.irEligible
        ? `${availability.label}. Choose the open ${slot.asset.position} slot to activate.`
        : `Open ${slot.asset.position} Slot ${openSlot.slotNumber} is available.`;
    }

    const availableBenchSlots = this.getIrActivationBenchTargets();
    const openBenchSlot = availableBenchSlots.find((benchSlot) => benchSlot.asset === null);

    return availability && !availability.irEligible
      ? `${availability.label}. Choose a ${slot.asset.position} player to replace.`
      : openBenchSlot
        ? `Choose a ${slot.asset.position} starter to replace. That starter will move to Open Bench ${openBenchSlot.slotNumber}.`
        : availableBenchSlots.length > 0
          ? `Choose a ${slot.asset.position} starter, then choose the bench player or goalie unit to waive.`
          : 'Every bench slot is reserved for another scheduled lineup move.';
  }

  getPendingIrActivationSlot(): IrRosterSlot | null {
    const irSlotId = this.irActivationSlotId();

    if (!irSlotId) {
      return null;
    }

    return this.getIrSlots().find((slot) => slot.slotId === irSlotId) ?? null;
  }

  getIrActivationTargetSlots(): ActiveRosterSlot[] {
    const irSlot = this.getPendingIrActivationSlot();

    if (!irSlot?.asset) {
      return [];
    }

    return this.getActiveSlotsForIrAsset(irSlot.asset);
  }

  getSelectedIrActivationTargetSlot(): ActiveRosterSlot | null {
    const irSlot = this.getPendingIrActivationSlot();
    const targetSlotId = this.irActivationTargetSlotId();

    if (!irSlot?.asset || !targetSlotId) {
      return null;
    }

    return (
      this.getActiveSlotsForIrAsset(irSlot.asset).find((slot) => slot.slotId === targetSlotId) ??
      null
    );
  }

  getIrActivationBenchTargets(): BenchRosterSlot[] {
    return this.getBenchSlots().filter((slot) => !this.isBenchSlotReservedForActiveSwap(slot));
  }

  getSelectedIrActivationBenchSlot(): BenchRosterSlot | null {
    const slotId = this.irActivationBenchSlotId();

    if (!slotId) {
      return null;
    }

    return this.getIrActivationBenchTargets().find((slot) => slot.slotId === slotId) ?? null;
  }

  irActivationNeedsBenchDestination(): boolean {
    return Boolean(this.getSelectedIrActivationTargetSlot()?.asset);
  }

  selectIrActivationBenchTarget(slotId: string): void {
    const slot = this.getIrActivationBenchTargets().find(
      (candidate) => candidate.slotId === slotId,
    );

    if (!this.rosterMoveLoading() && slot) {
      this.irActivationBenchSlotId.set(slotId);
    }
  }

  isIrActivationBenchTargetSelected(slotId: string): boolean {
    return this.irActivationBenchSlotId() === slotId;
  }

  getIrActivationBenchTargetHeading(slot: BenchRosterSlot): string {
    return slot.asset ? this.getRosterAssetName(slot.asset) : `Open Bench ${slot.slotNumber}`;
  }

  getIrActivationBenchTargetDetail(slot: BenchRosterSlot): string {
    if (!slot.asset) {
      return 'The displaced starter moves here. Nobody is dropped.';
    }

    return `${this.getRosterAssetTeamLabel(slot.asset)} · ${slot.asset.position} · This bench player or goalie unit will be placed on waivers.`;
  }

  private chooseDefaultIrActivationBenchSlot(): string {
    return this.getIrActivationBenchTargets().find((slot) => slot.asset === null)?.slotId ?? '';
  }

  beginIrActivation(irSlotId: string): void {
    if (!this.isOwnTeam()) {
      return;
    }

    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');
    this.rosterDropSource.set(null);
    this.rosterDropSlotId.set('');

    const irSlot = this.getIrSlots().find((slot) => slot.slotId === irSlotId);

    if (!irSlot?.asset) {
      this.rosterMoveError.set('That Injured Reserve (IR) slot is empty.');
      return;
    }

    const targetSlots = this.getActiveSlotsForIrAsset(irSlot.asset);

    if (targetSlots.length === 0) {
      this.rosterMoveError.set(`No ${irSlot.asset.position} roster slots were found.`);
      return;
    }

    const openSlot = targetSlots.find((slot) => slot.asset === null);
    const defaultTarget = openSlot ?? targetSlots[0];

    this.irActivationSlotId.set(irSlotId);
    this.irActivationTargetSlotId.set(defaultTarget.slotId);
    this.irActivationBenchSlotId.set(
      defaultTarget.asset ? this.chooseDefaultIrActivationBenchSlot() : '',
    );
  }

  cancelIrActivation(): void {
    if (this.rosterMoveLoading()) {
      return;
    }

    this.irActivationSlotId.set('');
    this.irActivationTargetSlotId.set('');
    this.irActivationBenchSlotId.set('');
  }

  selectIrActivationTarget(slotId: string): void {
    const targetSlot = this.getIrActivationTargetSlots().find((slot) => slot.slotId === slotId);

    if (!targetSlot || this.rosterMoveLoading()) {
      return;
    }

    this.irActivationTargetSlotId.set(slotId);

    if (!targetSlot.asset) {
      this.irActivationBenchSlotId.set('');
      return;
    }

    const selectedBenchSlot = this.getSelectedIrActivationBenchSlot();
    if (!selectedBenchSlot) {
      this.irActivationBenchSlotId.set(this.chooseDefaultIrActivationBenchSlot());
    }
  }

  isIrActivationTargetSelected(slotId: string): boolean {
    return this.irActivationTargetSlotId() === slotId;
  }

  canConfirmIrActivation(): boolean {
    const irSlot = this.getPendingIrActivationSlot();
    const targetSlotId = this.irActivationTargetSlotId();

    if (
      !this.isOwnTeam() ||
      !irSlot?.asset ||
      !targetSlotId ||
      !this.clientHealth.competitiveActionsReady() ||
      this.rosterMoveLoading()
    ) {
      return false;
    }

    const targetSlot = this.getActiveSlotsForIrAsset(irSlot.asset).find(
      (slot) => slot.slotId === targetSlotId,
    );

    if (!targetSlot) {
      return false;
    }

    if (!targetSlot.asset) {
      return true;
    }

    return Boolean(this.getSelectedIrActivationBenchSlot());
  }

  getIrActivationTargetHeading(slot: ActiveRosterSlot): string {
    if (!slot.asset) {
      return `Open ${slot.position} Slot ${slot.slotNumber}`;
    }

    return this.getRosterAssetName(slot.asset);
  }

  getIrActivationTargetDetail(slot: ActiveRosterSlot): string {
    if (!slot.asset) {
      return 'Activate into this open roster slot. No player will be dropped.';
    }

    return `${this.getRosterAssetTeamLabel(slot.asset)} · ${slot.position} Slot ${slot.slotNumber} · Moves to the selected bench slot`;
  }

  getPendingRosterDrop(): PendingRosterDrop | null {
    const sourceRosterArea = this.rosterDropSource();
    const slotId = this.rosterDropSlotId();
    const roster = this.roster();

    if (!sourceRosterArea || !slotId || !roster) {
      return null;
    }

    if (sourceRosterArea === 'active') {
      const slot = roster.activeSlots.find((candidate) => candidate.slotId === slotId);

      if (!slot?.asset) {
        return null;
      }

      return {
        sourceRosterArea,
        slotId,
        slotLabel: `${slot.position} Slot ${slot.slotNumber}`,
        asset: slot.asset,
      };
    }

    if (sourceRosterArea === 'bench') {
      const slot = roster.benchSlots.find((candidate) => candidate.slotId === slotId);

      if (!slot?.asset) {
        return null;
      }

      return {
        sourceRosterArea,
        slotId,
        slotLabel: `Bench Slot ${slot.slotNumber}`,
        asset: slot.asset,
      };
    }

    const slot = roster.irSlots.find((candidate) => candidate.slotId === slotId);

    if (!slot?.asset) {
      return null;
    }

    return {
      sourceRosterArea,
      slotId,
      slotLabel: `Injured Reserve Slot ${slot.slotNumber}`,
      asset: slot.asset,
    };
  }

  beginRosterDrop(sourceRosterArea: RosterDropSource, slotId: string): void {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    if (!this.isOwnTeam()) {
      this.rosterMoveError.set('This roster is read-only. Only its manager can make changes.');
      return;
    }

    const roster = this.roster();
    const hasAsset =
      sourceRosterArea === 'active'
        ? roster?.activeSlots.some((slot) => slot.slotId === slotId && slot.asset !== null)
        : sourceRosterArea === 'bench'
          ? roster?.benchSlots.some((slot) => slot.slotId === slotId && slot.asset !== null)
          : roster?.irSlots.some((slot) => slot.slotId === slotId && slot.asset !== null);

    if (!hasAsset) {
      this.rosterMoveError.set(
        sourceRosterArea === 'active'
          ? 'That active roster slot is already empty.'
          : sourceRosterArea === 'bench'
            ? 'That bench slot is already empty.'
            : 'That Injured Reserve (IR) slot is already empty.',
      );
      return;
    }

    this.irActivationSlotId.set('');
    this.irActivationTargetSlotId.set('');
    this.irActivationBenchSlotId.set('');
    this.rosterDropSource.set(sourceRosterArea);
    this.rosterDropSlotId.set(slotId);
  }

  cancelRosterDrop(): void {
    if (this.rosterMoveLoading()) {
      return;
    }

    this.rosterDropSource.set(null);
    this.rosterDropSlotId.set('');
  }

  canConfirmRosterDrop(): boolean {
    return Boolean(
      this.isOwnTeam() &&
      this.clientHealth.competitiveActionsReady() &&
      this.getPendingRosterDrop() &&
      !this.rosterMoveLoading(),
    );
  }

  getRosterDropSourceLabel(sourceRosterArea: RosterDropSource): string {
    return sourceRosterArea === 'ir'
      ? 'injured reserve'
      : sourceRosterArea === 'bench'
        ? 'bench'
        : 'active roster';
  }

  async confirmRosterDrop(): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    if (!this.ensureCompetitiveActionReady()) {
      return;
    }

    const pendingDrop = this.getPendingRosterDrop();

    if (!pendingDrop) {
      this.rosterMoveError.set(
        'That player or goalie unit is no longer in the selected roster slot.',
      );
      this.cancelRosterDrop();
      return;
    }

    const previousAssetKey = this.getRosterAssetKey(pendingDrop.asset);

    if (!previousAssetKey) {
      this.rosterMoveError.set(
        'Unable to verify the selected roster asset. Refresh and try again.',
      );
      return;
    }

    const actionHandle = this.actionMonitor.begin('roster-drop');
    let actionOutcome: 'success' | 'error' | 'uncertain' = 'error';
    this.rosterMoveLoading.set(true);
    const operationGeneration = ++this.rosterOperationGeneration;

    // Close the confirmation dialog before waiting for Firebase. Mobile Safari
    // can lose a callable response after Firestore has already committed; a
    // modal backdrop must never remain pinned over the page while that settles.
    this.rosterDropSource.set(null);
    this.rosterDropSlotId.set('');

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const assetName = this.getRosterAssetName(pendingDrop.asset);
      const sourceLabel = this.getRosterDropSourceLabel(pendingDrop.sourceRosterArea);
      const expectation: RosterRemovalExpectation = {
        sourceRosterArea: pendingDrop.sourceRosterArea,
        slotId: pendingDrop.slotId,
        previousAssetKey,
      };
      const request = dropRosterAssetToWaivers({
        leagueId: this.leagueId,
        ownerId: this.userId,
        sourceRosterArea: pendingDrop.sourceRosterArea,
        slotId: pendingDrop.slotId,
        effectiveCycleNumber,
        effectiveLabel,
      });

      await this.awaitRosterRemovalConfirmation(request, expectation, operationGeneration);

      this.rosterMoveMessage.set(
        pendingDrop.sourceRosterArea === 'active'
          ? `${assetName} was removed from your ${sourceLabel} and placed on waivers. An untouched assignment opens immediately; an already-started six-game scoring history remains preserved, and the open slot can change in Matchup ${effectiveCycleNumber}.`
          : `${assetName} was removed from your ${sourceLabel} and placed on waivers immediately.`,
      );
      actionOutcome = 'success';
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unable to drop this player or goalie unit.';
      this.rosterMoveError.set(message);
      actionOutcome =
        /may still finish|check my team before retrying|final server or live-roster confirmation/i.test(
          message,
        )
          ? 'uncertain'
          : 'error';
    } finally {
      if (this.rosterOperationGeneration === operationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  canMoveBenchSlotToIr(slot: BenchRosterSlot): boolean {
    return Boolean(
      this.isOwnTeam() &&
      slot.asset &&
      slot.asset.assetType === 'skater' &&
      this.isPlayerIrEligible(slot.asset) &&
      this.getOpenIrSlotCount() > 0 &&
      this.clientHealth.competitiveActionsReady() &&
      !this.rosterMoveLoading(),
    );
  }

  async moveBenchSlotToIr(slotId: string): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    if (!this.ensureCompetitiveActionReady()) {
      return;
    }

    const slot = this.roster()?.benchSlots.find((candidate) => candidate.slotId === slotId);
    if (!slot?.asset || slot.asset.assetType !== 'skater') {
      this.rosterMoveError.set('That bench skater is no longer available.');
      return;
    }

    const actionHandle = this.actionMonitor.begin('injured-reserve');
    let actionOutcome: 'success' | 'error' | 'uncertain' = 'error';
    const operationGeneration = ++this.rosterOperationGeneration;
    const previousRosterFingerprint = this.getRosterOperationFingerprint();
    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const request = moveBenchRosterAssetToIr({
        leagueId: this.leagueId,
        ownerId: this.userId,
        benchSlotId: slotId,
        effectiveCycleNumber,
        effectiveLabel: `Cycle ${effectiveCycleNumber}`,
      });

      await this.awaitRosterMutationConfirmation(
        request,
        previousRosterFingerprint,
        operationGeneration,
      );
      this.rosterMoveMessage.set(
        `${this.getRosterAssetName(slot.asset)} moved from the bench to Injured Reserve (IR). Bench players do not score, so the ownership move is immediate.`,
      );
      actionOutcome = 'success';
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to move this bench player to Injured Reserve (IR).';
      this.rosterMoveError.set(message);
      actionOutcome = this.isUncertainRosterOperationMessage(message) ? 'uncertain' : 'error';
    } finally {
      if (this.rosterOperationGeneration === operationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  beginActiveBenchSwapPicker(activeSlotId: string): void {
    if (!this.isOwnTeam() || this.isRosterOperationPending()) {
      return;
    }

    this.clearFutureSwapEffectiveCycleOverride();
    const activeSlot = this.isFutureRosterAction()
      ? this.getSelectedRosterDisplaySlot(activeSlotId)
      : this.roster()?.activeSlots.find((slot) => slot.slotId === activeSlotId);

    const promotableQueuedBenchSlot = activeSlot
      ? this.getPromotableQueuedBenchSwapSlot(activeSlot)
      : null;

    if (!activeSlot?.asset || (activeSlot.pendingMove && !promotableQueuedBenchSlot)) {
      this.rosterMoveError.set(
        activeSlot?.pendingMove
          ? 'That active roster slot has a different scheduled move. Review or cancel it before choosing an injury replacement.'
          : 'That active roster slot is empty.',
      );
      return;
    }

    this.rosterMoveError.set('');
    this.rosterMoveMessage.set('');
    this.activeBenchPickerSlotId.set(activeSlotId);
  }

  cancelActiveBenchSwapPicker(): void {
    if (this.rosterMoveLoading()) {
      return;
    }

    this.activeBenchPickerSlotId.set('');
    this.clearFutureSwapEffectiveCycleOverride();
    this.rosterActionCycleNumber.set(null);
    this.rosterActionUsesSelectedMatchupAuthority.set(false);
  }

  getPendingActiveBenchSwapSlot(): ActiveRosterSlot | null {
    const slotId = this.activeBenchPickerSlotId();

    if (!slotId) {
      return null;
    }

    return this.isFutureRosterAction()
      ? this.getSelectedRosterDisplaySlot(slotId)
      : this.roster()?.activeSlots.find((slot) => slot.slotId === slotId) ?? null;
  }

  isActiveBenchPickerInjuryReplacement(): boolean {
    if (this.isFutureRosterAction()) {
      return false;
    }

    const activeSlot = this.getPendingActiveBenchSwapSlot();

    return Boolean(
      activeSlot && this.getImmediateInjuryReplacementBenchSlots(activeSlot).length > 0,
    );
  }

  getActiveBenchSwapCandidates(): BenchRosterSlot[] {
    const activeSlot = this.getPendingActiveBenchSwapSlot();

    if (!activeSlot?.asset) {
      return [];
    }

    if (!this.isFutureRosterAction() && activeSlot.pendingMove) {
      const queuedBenchSlot = this.getPromotableQueuedBenchSwapSlot(activeSlot);
      return queuedBenchSlot ? [queuedBenchSlot] : [];
    }

    return this.isFutureRosterAction()
      ? this.getFutureSwapBenchCandidates(activeSlot.position, activeSlot.slotId)
      : this.getBenchSlots().filter(
          (slot) =>
            slot.asset?.position === activeSlot.position &&
            !this.isBenchSlotReservedForActiveSwap(slot),
        );
  }

  private isActiveSlotEligibleForImmediateInjuryReplacement(slot: ActiveRosterSlot): boolean {
    const availability =
      slot.asset?.assetType === 'skater' ? this.getPlayerAvailability(slot.asset) : null;

    return Boolean(
      this.isOwnTeam() &&
      slot.asset?.assetType === 'skater' &&
      isImmediateInjuryMoveStatus(availability?.status),
    );
  }

  private isExactPromotableQueuedBenchSwap(
    activeSlot: ActiveRosterSlot,
    benchSlot: BenchRosterSlot | null,
  ): boolean {
    const pendingMove = activeSlot.pendingMove;

    if (
      !pendingMove ||
      !benchSlot?.asset ||
      !activeSlot.asset ||
      !this.isActiveSlotEligibleForImmediateInjuryReplacement(activeSlot)
    ) {
      return false;
    }

    const activeAssetKey = this.getRosterAssetKey(activeSlot.asset);
    const benchAssetKey = this.getRosterAssetKey(benchSlot.asset);

    return isExactQueuedBenchSwapPromotion({
      managerId: this.userId,
      activeAssetKey,
      activePosition: activeSlot.position,
      pendingMove: {
        moveType: pendingMove.moveType,
        incomingAssetKey: this.getRosterAssetKey(pendingMove.incomingAsset),
        outgoingAssetKey: pendingMove.outgoingAssetKey,
        sourceWaiverId: pendingMove.sourceWaiverId,
        queuedByOwnerId: pendingMove.queuedByOwnerId,
        sourceBenchSlotId: pendingMove.sourceBenchSlotId,
        outgoingDestination: pendingMove.outgoingDestination,
      },
      benchSlotId: benchSlot.slotId,
      benchAssetKey,
      benchPosition: benchSlot.asset.position,
    });
  }

  private getPromotableQueuedBenchSwapSlot(activeSlot: ActiveRosterSlot): BenchRosterSlot | null {
    const sourceBenchSlotId = activeSlot.pendingMove?.sourceBenchSlotId ?? '';
    const benchSlot = sourceBenchSlotId
      ? (this.getBenchSlots().find((slot) => slot.slotId === sourceBenchSlotId) ?? null)
      : null;

    return this.isExactPromotableQueuedBenchSwap(activeSlot, benchSlot) ? benchSlot : null;
  }

  private getImmediateInjuryReplacementBenchSlots(activeSlot: ActiveRosterSlot): BenchRosterSlot[] {
    if (!this.isActiveSlotEligibleForImmediateInjuryReplacement(activeSlot)) {
      return [];
    }

    if (activeSlot.pendingMove) {
      const queuedBenchSlot = this.getPromotableQueuedBenchSwapSlot(activeSlot);
      return queuedBenchSlot ? [queuedBenchSlot] : [];
    }

    return this.getBenchSlots().filter(
      (slot) =>
        slot.asset?.assetType === 'skater' &&
        slot.asset.position === activeSlot.position &&
        !this.isBenchSlotReservedForActiveSwap(slot),
    );
  }

  chooseActiveBenchSwapCandidate(benchSlotId: string): void {
    const activeSlot = this.getPendingActiveBenchSwapSlot();
    const candidate = this.getActiveBenchSwapCandidates().find(
      (slot) => slot.slotId === benchSlotId,
    );

    if (!activeSlot?.asset || !candidate?.asset || this.rosterMoveLoading()) {
      return;
    }

    this.activeBenchPickerSlotId.set('');
    this.beginBenchSwap(candidate.slotId, activeSlot.slotId);
  }

  beginBenchSwap(benchSlotId: string): void;
  beginBenchSwap(benchSlotId: string, preferredActiveSlotId: string): void;
  beginBenchSwap(benchSlotId: string, preferredActiveSlotId = ''): void {
    if (
      !this.isOwnTeam() ||
      this.isRosterOperationPending() ||
      Date.now() < this.benchSwapReopenBlockedUntil
    ) {
      return;
    }

    this.clearFutureSwapEffectiveCycleOverride();
    const preferredFutureTarget = this.isFutureRosterAction() && preferredActiveSlotId
      ? this.getSelectedRosterDisplaySlot(preferredActiveSlotId)
      : null;
    const benchSlot = preferredFutureTarget
      ? this.getFutureSwapBenchCandidates(
          preferredFutureTarget.position,
          preferredFutureTarget.slotId,
        ).find((slot) => slot.slotId === benchSlotId)
      : this.roster()?.benchSlots.find((slot) => slot.slotId === benchSlotId);
    if (!benchSlot?.asset) {
      this.rosterMoveError.set('That bench slot is empty.');
      return;
    }

    const targets = this.isFutureRosterAction()
      ? this.getFutureSwapActiveTargets(benchSlot.asset)
      : this.getPositionSlots(benchSlot.asset.position).filter(
          (slot) => !slot.pendingMove || this.isExactPromotableQueuedBenchSwap(slot, benchSlot),
        );
    if (targets.length === 0) {
      this.rosterMoveError.set(
        this.isFutureRosterAction() && this.isFutureLineupProjectedStarter(benchSlot.asset)
          ? `${this.getRosterAssetName(benchSlot.asset)} is already scheduled to start in the selected matchup. Choose another bench player or clear the saved plan.`
          : `No ${benchSlot.asset.position} active slot is available for a scheduled swap.`,
      );
      return;
    }

    this.rosterMoveError.set('');
    this.rosterMoveMessage.set('');
    this.benchSwapSlotId.set(benchSlotId);
    const preferredTarget = targets.find((slot) => slot.slotId === preferredActiveSlotId);
    this.benchSwapRestrictedTargetSlotId.set(preferredTarget?.slotId ?? '');
    this.benchSwapTargetSlotId.set(preferredTarget?.slotId ?? targets[0].slotId);
    void this.refreshBenchSwapTimingPreview();
  }

  cancelBenchSwap(): void {
    if (this.rosterMoveLoading()) {
      return;
    }

    this.clearBenchSwapDialogState();
    this.rosterActionCycleNumber.set(null);
  }

  private clearBenchSwapDialogState(): void {
    this.benchSwapTimingGeneration += 1;
    this.clearFutureSwapEffectiveCycleOverride();
    this.benchSwapSlotId.set('');
    this.benchSwapTargetSlotId.set('');
    this.benchSwapRestrictedTargetSlotId.set('');
    this.benchSwapTimingPreview.set(null);
    this.benchSwapTimingLoading.set(false);
    this.benchSwapTimingError.set('');
    this.rosterActionUsesSelectedMatchupAuthority.set(false);
    this.scheduleViewportOverlayRepair();
  }

  private scheduleViewportOverlayRepair(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.requestAnimationFrame(() => repairViewportOverlayLock());
  }

  private waitForRosterOverlayDismissal(): Promise<void> {
    if (typeof window === 'undefined') {
      repairViewportOverlayLock();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        repairViewportOverlayLock();
        window.requestAnimationFrame(() => {
          repairViewportOverlayLock();
          resolve();
        });
      });
    });
  }

  getPendingBenchSwapSlot(): BenchRosterSlot | null {
    const slotId = this.benchSwapSlotId();
    const restrictedTargetSlotId = this.benchSwapRestrictedTargetSlotId();
    const restrictedTarget = this.isFutureRosterAction() && restrictedTargetSlotId
      ? this.getSelectedRosterDisplaySlot(restrictedTargetSlotId)
      : null;

    if (restrictedTarget) {
      return this.getFutureSwapBenchCandidates(
        restrictedTarget.position,
        restrictedTarget.slotId,
      ).find((slot) => slot.slotId === slotId) ?? null;
    }

    return this.roster()?.benchSlots.find((slot) => slot.slotId === slotId) ?? null;
  }

  getBenchSwapTargetSlots(): ActiveRosterSlot[] {
    const benchSlot = this.getPendingBenchSwapSlot();
    const targets = benchSlot?.asset
      ? this.isFutureRosterAction()
        ? this.getFutureSwapActiveTargets(benchSlot.asset)
        : this.getPositionSlots(benchSlot.asset.position).filter(
            (slot) => !slot.pendingMove || this.isExactPromotableQueuedBenchSwap(slot, benchSlot),
          )
      : [];
    const restrictedTargetSlotId = this.benchSwapRestrictedTargetSlotId();

    return restrictedTargetSlotId
      ? targets.filter((slot) => slot.slotId === restrictedTargetSlotId)
      : targets;
  }

  selectBenchSwapTarget(slotId: string): void {
    if (this.getBenchSwapTargetSlots().some((slot) => slot.slotId === slotId)) {
      if (slotId !== this.benchSwapTargetSlotId()) {
        this.clearFutureSwapEffectiveCycleOverride();
      }
      this.benchSwapTargetSlotId.set(slotId);
      void this.refreshBenchSwapTimingPreview();
    }
  }

  retryBenchSwapTiming(): void {
    const override = this.futureSwapEffectiveCycleOverride();
    if (this.isFutureRosterAction() && override && !override.authorityRefreshed) {
      void this.refreshFutureSwapEffectiveCycleOverride(override);
      return;
    }

    void this.refreshBenchSwapTimingPreview();
  }

  private async refreshFutureSwapEffectiveCycleOverride(
    override: FutureMatchupSwapEffectiveCycleOverride,
  ): Promise<boolean> {
    const intent = this.getFutureSwapIntent();
    const overrideKey = getFutureMatchupSwapIntentKey(override);

    if (!intent || getFutureMatchupSwapIntentKey(intent) !== overrideKey) {
      this.clearFutureSwapEffectiveCycleOverride();
      return false;
    }

    const timingGeneration = ++this.benchSwapTimingGeneration;
    this.benchSwapTimingLoading.set(true);
    this.benchSwapTimingError.set('');

    try {
      const authority = await this.loadFreshFutureLineupAuthority(
        override.requestedCycleNumber,
      );
      const liveIntent = this.getFutureSwapIntent();
      if (
        timingGeneration !== this.benchSwapTimingGeneration ||
        !liveIntent ||
        getFutureMatchupSwapIntentKey(liveIntent) !== overrideKey
      ) {
        return false;
      }

      this.applyFreshFutureLineupAuthority(authority, true);
      const refreshedIntent = this.getFutureSwapIntent();
      const currentOverride = this.futureSwapEffectiveCycleOverride();
      if (
        !refreshedIntent ||
        !currentOverride ||
        getFutureMatchupSwapIntentKey(refreshedIntent) !== overrideKey ||
        getFutureMatchupSwapIntentKey(currentOverride) !== overrideKey ||
        currentOverride.effectiveCycleNumber !== override.effectiveCycleNumber
      ) {
        this.clearFutureSwapEffectiveCycleOverride();
        return false;
      }

      this.futureSwapEffectiveCycleOverride.set({
        ...override,
        authorityRefreshed: true,
      });
      this.futureLineupStale.set(false);
      this.futureLineupError.set('');
      this.rosterMoveError.set('');
      void this.loadFutureLineupTimingEvidence(true);
      return true;
    } catch (error: unknown) {
      if (timingGeneration === this.benchSwapTimingGeneration) {
        this.benchSwapTimingError.set(
          error instanceof Error
            ? error.message
            : 'The updated matchup timing could not be refreshed. Retry before confirming.',
        );
      }
      return false;
    } finally {
      if (timingGeneration === this.benchSwapTimingGeneration) {
        this.benchSwapTimingLoading.set(false);
      }
    }
  }

  private async refreshBenchSwapTimingPreview(): Promise<void> {
    const benchSlot = this.getPendingBenchSwapSlot();
    const targetSlot = this.getBenchSwapTargetSlots().find(
      (slot) => slot.slotId === this.benchSwapTargetSlotId(),
    );

    if (!benchSlot?.asset || !targetSlot || !this.userId) {
      return;
    }

    if (this.isFutureRosterAction()) {
      this.benchSwapTimingGeneration += 1;
      this.benchSwapTimingPreview.set(null);
      this.benchSwapTimingLoading.set(false);
      this.benchSwapTimingError.set(
        this.getExpectedFutureSwapCycleNumber() === null
          ? 'Exact NHL start evidence is incomplete for one of these players. Retry the matchup date check before confirming.'
          : '',
      );
      return;
    }

    if (this.isPendingBenchSwapInjuryReplacement()) {
      this.benchSwapTimingGeneration += 1;
      this.benchSwapTimingPreview.set(null);
      this.benchSwapTimingError.set('');
      this.benchSwapTimingLoading.set(false);
      return;
    }

    const generation = ++this.benchSwapTimingGeneration;
    const benchSlotId = benchSlot.slotId;
    const activeSlotId = targetSlot.slotId;
    this.benchSwapTimingPreview.set(null);
    this.benchSwapTimingError.set('');
    this.benchSwapTimingLoading.set(true);

    try {
      const preview = await previewActiveBenchSwapTiming({
        leagueId: this.leagueId,
        ownerId: this.userId,
        activeSlot: targetSlot,
        benchAsset: benchSlot.asset,
        requiredGamesPerCycle:
          this.league()?.scoringRules?.requiredGamesPerCycle ??
          defaultScoringRules.requiredGamesPerCycle,
      });

      if (
        generation === this.benchSwapTimingGeneration &&
        this.benchSwapSlotId() === benchSlotId &&
        this.benchSwapTargetSlotId() === activeSlotId
      ) {
        this.benchSwapTimingPreview.set(preview);
      }
    } catch (error: unknown) {
      if (generation === this.benchSwapTimingGeneration) {
        this.benchSwapTimingError.set(
          error instanceof Error
            ? error.message
            : 'RinkRat could not verify the matchup timing for this swap.',
        );
      }
    } finally {
      if (generation === this.benchSwapTimingGeneration) {
        this.benchSwapTimingLoading.set(false);
      }
    }
  }

  canConfirmBenchSwap(): boolean {
    if (this.isFutureRosterAction()) {
      return Boolean(
        this.isOwnTeam() &&
        this.getPendingBenchSwapSlot()?.asset &&
        this.getBenchSwapTargetSlots().some(
          (slot) => slot.slotId === this.benchSwapTargetSlotId(),
        ) &&
        this.getExpectedFutureSwapCycleNumber() !== null &&
        !this.benchSwapTimingError() &&
        !this.benchSwapTimingLoading() &&
        !this.futureLineupTimingLoading() &&
        this.futureLineupWindowsConfirmed() &&
        this.clientHealth.competitiveActionsReady() &&
        !this.rosterMoveLoading(),
      );
    }

    return Boolean(
      this.isOwnTeam() &&
      this.getPendingBenchSwapSlot()?.asset &&
      this.getBenchSwapTargetSlots().some((slot) => slot.slotId === this.benchSwapTargetSlotId()) &&
      (this.isPendingBenchSwapInjuryReplacement() || this.benchSwapTimingPreview()) &&
      !this.benchSwapTimingLoading() &&
      this.clientHealth.competitiveActionsReady() &&
      !this.rosterMoveLoading(),
    );
  }

  isPendingBenchSwapInjuryReplacement(): boolean {
    if (this.isFutureRosterAction()) {
      return false;
    }

    const benchAsset = this.getPendingBenchSwapSlot()?.asset ?? null;
    const targetSlot = this.getBenchSwapTargetSlots().find(
      (slot) => slot.slotId === this.benchSwapTargetSlotId(),
    );

    return Boolean(
      benchAsset?.assetType === 'skater' &&
      targetSlot?.asset?.assetType === 'skater' &&
      targetSlot.asset.position === benchAsset.position &&
      this.isActiveSlotEligibleForImmediateInjuryReplacement(targetSlot) &&
      (!targetSlot.pendingMove ||
        this.isExactPromotableQueuedBenchSwap(targetSlot, this.getPendingBenchSwapSlot())),
    );
  }

  async confirmBenchSwap(event?: Event): Promise<void> {
    event?.preventDefault();
    event?.stopPropagation();

    if (!this.ensureCompetitiveActionReady()) {
      return;
    }

    const benchSlot = this.getPendingBenchSwapSlot();
    const targetSlot = this.getBenchSwapTargetSlots().find(
      (slot) => slot.slotId === this.benchSwapTargetSlotId(),
    );

    if (!benchSlot?.asset || !targetSlot) {
      this.rosterMoveError.set('Choose a valid bench player or goalie unit and an active slot.');
      return;
    }

    if (this.isFutureRosterAction()) {
      await this.confirmFutureMatchupBenchSwap(benchSlot, targetSlot);
      return;
    }

    const targetAsset = targetSlot.asset;
    const injuryReplacement =
      targetAsset?.assetType === 'skater' &&
      isImmediateInjuryMoveStatus(this.getPlayerAvailability(targetAsset)?.status) &&
      benchSlot.asset.assetType === 'skater' &&
      targetAsset.position === benchSlot.asset.position;

    const healthySwapTimingPreview = injuryReplacement ? null : this.benchSwapTimingPreview();

    if (!injuryReplacement && !healthySwapTimingPreview) {
      this.benchSwapTimingError.set(
        'RinkRat must verify the exact matchup timing before this swap can be confirmed.',
      );
      return;
    }

    const incomingName = this.getRosterAssetName(benchSlot.asset);
    const injurySwapExpectation: ImmediateActiveBenchSwapExpectation | null =
      injuryReplacement && targetAsset
        ? {
            activeSlotId: targetSlot.slotId,
            benchSlotId: benchSlot.slotId,
            incomingAssetKey: this.getRosterAssetKey(benchSlot.asset),
            outgoingAssetKey: this.getRosterAssetKey(targetAsset),
          }
        : null;
    const actionHandle = this.actionMonitor.begin('lineup-swap');
    let actionOutcome: 'success' | 'error' | 'uncertain' = 'error';
    const operationGeneration = ++this.rosterOperationGeneration;
    const previousRosterFingerprint = this.getRosterOperationFingerprint();

    // Disable the underlying roster controls before dismissing the portaled
    // confirmation view. This prevents a delayed touch/click from reopening the
    // same action while the secure move is reconciling.
    this.rosterMoveLoading.set(true);
    this.rosterMoveError.set('');
    this.benchSwapReopenBlockedUntil = Date.now() + 1_500;
    this.clearBenchSwapDialogState();
    await this.waitForRosterOverlayDismissal();

    try {
      const request = injuryReplacement
        ? replaceInjuredRosterAsset({
            leagueId: this.leagueId,
            ownerId: this.userId,
            activeSlotId: targetSlot.slotId,
            benchSlotId: benchSlot.slotId,
          })
        : queueActiveBenchSwap({
            leagueId: this.leagueId,
            ownerId: this.userId,
            activeSlotId: targetSlot.slotId,
            benchSlotId: benchSlot.slotId,
            effectiveCycleNumber: healthySwapTimingPreview?.effectiveCycleNumber ?? null,
            effectiveLabel: healthySwapTimingPreview
              ? `Matchup ${healthySwapTimingPreview.effectiveCycleNumber}`
              : null,
          });
      const execution = await this.awaitRosterMutationConfirmation(
        request,
        previousRosterFingerprint,
        operationGeneration,
        injurySwapExpectation
          ? () =>
              isImmediateActiveBenchSwapObserved(
                injurySwapExpectation,
                this.getActiveBenchSwapRosterObservation(),
              )
          : undefined,
      );
      const effectiveCycleNumber =
        execution?.effectiveCycleNumber ??
        (injuryReplacement
          ? (this.latestCycle()?.cycleNumber ?? 1)
          : this.getRosterMoveEffectiveCycleNumber());
      const observedTarget = this.roster()?.activeSlots.find(
        (slot) => slot.slotId === targetSlot.slotId,
      );
      const incomingKey = this.getRosterAssetKey(benchSlot.asset);
      const observedImmediate = this.getRosterAssetKey(observedTarget?.asset) === incomingKey;
      const observedQueued =
        this.getRosterAssetKey(observedTarget?.pendingMove?.incomingAsset) === incomingKey;
      const mode =
        execution?.mode ?? (observedImmediate ? 'immediate' : observedQueued ? 'queued' : 'queued');

      this.rosterMoveMessage.set(
        injuryReplacement
          ? `${incomingName} replaced the injured starter immediately in ${targetSlot.position} Slot ${targetSlot.slotNumber}. The starter moved to the bench, every already-started game and earned point remains with that player, and only the slot’s remaining future games belong to ${incomingName}.`
          : mode === 'immediate'
            ? `${incomingName} moved into ${targetSlot.position} Slot ${targetSlot.slotNumber} immediately. Neither six-game count had started, so the swap applies to Matchup ${effectiveCycleNumber}.`
            : `${incomingName} is scheduled for ${targetSlot.position} Slot ${targetSlot.slotNumber}. At least one six-game count has started, so the swap begins in Matchup ${effectiveCycleNumber}. A current Day-to-Day, Out, IR, or LTIR report can make this exact pairing eligible for the protected immediate-injury route while every started game and point stays preserved.`,
      );
      actionOutcome = 'success';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to schedule the bench swap.';
      this.rosterMoveError.set(message);
      actionOutcome = this.isUncertainRosterOperationMessage(message) ? 'uncertain' : 'error';
    } finally {
      if (this.rosterOperationGeneration === operationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      this.clearBenchSwapDialogState();
      this.rosterActionCycleNumber.set(null);
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  private async confirmFutureMatchupBenchSwap(
    benchSlot: BenchRosterSlot,
    targetSlot: ActiveRosterSlot,
  ): Promise<void> {
    const requestedCycleNumber = this.rosterActionCycleNumber();
    const expectedEffectiveCycleNumber = this.getExpectedFutureSwapCycleNumber();
    const outgoingAssetKey = this.getRosterAssetKey(targetSlot.asset) || null;
    const incomingAssetKey = this.getRosterAssetKey(benchSlot.asset);

    if (
      !requestedCycleNumber ||
      !expectedEffectiveCycleNumber ||
      !incomingAssetKey
    ) {
      this.benchSwapTimingError.set(
        'RinkRat must verify the exact matchup assignment before this move can be confirmed.',
      );
      return;
    }

    const operationGeneration = ++this.rosterOperationGeneration;
    const mutationGeneration = ++this.futureLineupMutationGeneration;
    const actionHandle = this.actionMonitor.begin('lineup-swap');
    let actionOutcome: 'success' | 'error' | 'uncertain' | 'cancelled' = 'error';

    this.rosterMoveLoading.set(true);
    this.futureLineupSaving.set(true);
    this.rosterMoveError.set('');
    this.futureLineupError.set('');
    this.futureLineupMessage.set('');

    try {
      const freshAuthority = await this.loadFreshFutureLineupAuthority(requestedCycleNumber);
      if (
        operationGeneration !== this.rosterOperationGeneration ||
        mutationGeneration !== this.futureLineupMutationGeneration
      ) {
        actionOutcome = 'cancelled';
        return;
      }

      this.applyFreshFutureLineupAuthority(freshAuthority, true);
      const refreshedTarget = this.getBenchSwapTargetSlots().find(
        (slot) => slot.slotId === targetSlot.slotId,
      );
      const refreshedBench = this.getPendingBenchSwapSlot();
      const refreshedEffectiveCycleNumber = this.getExpectedFutureSwapCycleNumber();

      if (
        !refreshedTarget ||
        !refreshedBench?.asset ||
        (this.getRosterAssetKey(refreshedTarget.asset) || null) !== outgoingAssetKey ||
        this.getRosterAssetKey(refreshedBench.asset) !== incomingAssetKey ||
        refreshedEffectiveCycleNumber !== expectedEffectiveCycleNumber
      ) {
        this.benchSwapTimingError.set(
          'The matchup timing or roster changed while this confirmation was open. Review the refreshed players and timing, then confirm again.',
        );
        actionOutcome = 'cancelled';
        return;
      }

      const expectedRevision =
        this.futureLineupPlans().find(
          (plan) => plan.cycleNumber === expectedEffectiveCycleNumber,
        )?.revision ?? 0;
      const mutationKey = JSON.stringify({
        requestedCycleNumber,
        expectedEffectiveCycleNumber,
        activeSlotId: targetSlot.slotId,
        benchSlotId: benchSlot.slotId,
        outgoingAssetKey,
        incomingAssetKey,
      });
      const pendingMutation = this.pendingFutureLineupMutation;
      const requestId =
        pendingMutation?.operation === 'swap' &&
        pendingMutation.cycleNumber === expectedEffectiveCycleNumber &&
        pendingMutation.expectedRevision === expectedRevision &&
        pendingMutation.slotsKey === mutationKey
          ? pendingMutation.requestId
          : createFutureMatchupLineupRequestId();
      const swapRequest: SwapFutureMatchupLineupRequest = {
        leagueId: this.leagueId,
        operation: 'swap',
        requestedCycleNumber,
        expectedEffectiveCycleNumber,
        activeSlotId: targetSlot.slotId,
        benchSlotId: benchSlot.slotId,
        expectedRevision,
        requestId,
        expectedOutgoingAssetKey: outgoingAssetKey,
        expectedIncomingAssetKey: incomingAssetKey,
      };

      this.pendingFutureLineupMutation = {
        operation: 'swap',
        cycleNumber: expectedEffectiveCycleNumber,
        expectedRevision,
        requestId,
        slotsKey: mutationKey,
        swapRequest,
      };

      const result = await this.runBoundedRosterOperation(
        swapFutureMatchupLineup(swapRequest),
        'The matchup lineup swap',
      );

      if (
        operationGeneration !== this.rosterOperationGeneration ||
        mutationGeneration !== this.futureLineupMutationGeneration
      ) {
        actionOutcome = 'cancelled';
        return;
      }

      this.replaceFutureLineupPlan(result.plan);
      this.pendingFutureLineupMutation = null;
      this.futureLineupStale.set(false);
      this.resetFutureLineupDraftFromServer();
      const incomingName = this.getRosterAssetName(benchSlot.asset);
      const outgoingName = targetSlot.asset ? this.getRosterAssetName(targetSlot.asset) : null;
      const message = result.mode === 'immediate'
        ? outgoingName
          ? `${incomingName} replaced ${outgoingName} in Matchup ${result.effectiveCycleNumber}. Both exact game assignments were untouched, so the selected matchup changed without moving any started game or point.`
          : `${incomingName} filled the open ${targetSlot.position} slot in Matchup ${result.effectiveCycleNumber}. The incoming game assignment was untouched, so no started game or point moved.`
        : outgoingName
          ? `${incomingName} is scheduled to replace ${outgoingName} in Matchup ${result.effectiveCycleNumber}. Matchup ${requestedCycleNumber} stays unchanged because at least one assignment had started. The incoming player’s expected start now follows Matchup ${result.effectiveCycleNumber}.`
          : `${incomingName} is scheduled for the open ${targetSlot.position} slot in Matchup ${result.effectiveCycleNumber}. Matchup ${requestedCycleNumber} stays unchanged because the incoming assignment had started.`;

      this.rosterMoveMessage.set(message);
      this.futureLineupMessage.set(message);
      this.clearBenchSwapDialogState();
      this.rosterActionCycleNumber.set(null);

      try {
        const refreshedAuthority = await this.loadFreshFutureLineupAuthority(
          requestedCycleNumber,
        );
        if (
          operationGeneration === this.rosterOperationGeneration &&
          mutationGeneration === this.futureLineupMutationGeneration
        ) {
          this.applyFreshFutureLineupAuthority(refreshedAuthority, false);
          void this.loadFutureLineupTimingEvidence(true);
        }
      } catch {
        this.futureLineupTimingError.set(
          'The move was saved, but its latest matchup dates could not be refreshed. Use Refresh before making another change.',
        );
      }

      actionOutcome = 'success';
    } catch (error: unknown) {
      if (
        operationGeneration !== this.rosterOperationGeneration ||
        mutationGeneration !== this.futureLineupMutationGeneration
      ) {
        actionOutcome = 'cancelled';
        return;
      }

      const normalizedError = normalizeFutureMatchupLineupError(error);
      const authoritativeEffectiveCycleNumber =
        normalizedError.details.reason === 'swap-timing-conflict'
          ? normalizedError.details.effectiveCycleNumber ?? null
          : null;
      if (
        authoritativeEffectiveCycleNumber &&
        authoritativeEffectiveCycleNumber >= requestedCycleNumber
      ) {
        const override: FutureMatchupSwapEffectiveCycleOverride = {
          requestedCycleNumber,
          activeSlotId: targetSlot.slotId,
          benchSlotId: benchSlot.slotId,
          outgoingAssetKey,
          incomingAssetKey,
          effectiveCycleNumber: authoritativeEffectiveCycleNumber,
          authorityRefreshed: false,
        };
        this.futureSwapEffectiveCycleOverride.set(override);
        this.pendingFutureLineupMutation = null;
        this.futureLineupStale.set(true);

        if (await this.refreshFutureSwapEffectiveCycleOverride(override)) {
          this.futureLineupMessage.set(
            `The server found Matchup ${authoritativeEffectiveCycleNumber} as the next fair window. Review the updated timing, then confirm this exact swap again.`,
          );
          actionOutcome = 'cancelled';
          return;
        }
      }

      const failure = this.getRosterOperationError(
        normalizedError,
        'Unable to apply this matchup lineup swap.',
      );
      this.rosterMoveError.set(failure.message);
      this.futureLineupError.set(failure.message);
      this.futureLineupStale.set(
        isFutureMatchupLineupRevisionConflict(error) ||
        isFutureMatchupLineupSwapTimingConflict(error),
      );
      actionOutcome = failure.outcome;
      if (failure.outcome === 'uncertain') {
        this.clearBenchSwapDialogState();
        this.rosterActionCycleNumber.set(null);
      }
    } finally {
      if (operationGeneration === this.rosterOperationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      if (mutationGeneration === this.futureLineupMutationGeneration) {
        this.futureLineupSaving.set(false);
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  private async retryPendingFutureLineupSwap(): Promise<void> {
    const pendingMutation = this.pendingFutureLineupMutation;
    const request = pendingMutation?.operation === 'swap'
      ? pendingMutation.swapRequest
      : undefined;

    if (!request || this.futureLineupSaving() || this.rosterMoveLoading()) {
      return;
    }

    const operationGeneration = ++this.rosterOperationGeneration;
    const mutationGeneration = ++this.futureLineupMutationGeneration;
    const actionHandle = this.actionMonitor.begin('lineup-swap');
    let actionOutcome: 'success' | 'error' | 'uncertain' | 'cancelled' = 'error';

    this.rosterMoveLoading.set(true);
    this.futureLineupSaving.set(true);
    this.rosterMoveError.set('');
    this.futureLineupError.set('');

    try {
      const result = await this.runBoundedRosterOperation(
        swapFutureMatchupLineup(request),
        'The matchup lineup swap retry',
      );

      if (
        operationGeneration !== this.rosterOperationGeneration ||
        mutationGeneration !== this.futureLineupMutationGeneration
      ) {
        actionOutcome = 'cancelled';
        return;
      }

      this.replaceFutureLineupPlan(result.plan);
      this.pendingFutureLineupMutation = null;
      this.futureLineupStale.set(false);
      this.resetFutureLineupDraftFromServer();
      const message = `The original lineup move is confirmed for Matchup ${result.effectiveCycleNumber}.`;
      this.rosterMoveMessage.set(message);
      this.futureLineupMessage.set(message);

      try {
        const refreshedAuthority = await this.loadFreshFutureLineupAuthority(
          request.requestedCycleNumber,
        );
        if (
          operationGeneration === this.rosterOperationGeneration &&
          mutationGeneration === this.futureLineupMutationGeneration
        ) {
          this.applyFreshFutureLineupAuthority(refreshedAuthority, false);
          void this.loadFutureLineupTimingEvidence(true);
        }
      } catch {
        this.futureLineupTimingError.set(
          'The move was confirmed, but its latest matchup dates could not be refreshed. Use Refresh before making another change.',
        );
      }

      actionOutcome = 'success';
    } catch (error: unknown) {
      if (
        operationGeneration !== this.rosterOperationGeneration ||
        mutationGeneration !== this.futureLineupMutationGeneration
      ) {
        actionOutcome = 'cancelled';
        return;
      }

      const failure = this.getRosterOperationError(
        normalizeFutureMatchupLineupError(error),
        'Unable to confirm the original matchup lineup move.',
      );
      this.rosterMoveError.set(failure.message);
      this.futureLineupError.set(failure.message);
      const stale =
        isFutureMatchupLineupRevisionConflict(error) ||
        isFutureMatchupLineupSwapTimingConflict(error);
      this.futureLineupStale.set(stale);
      if (failure.outcome !== 'uncertain') {
        this.pendingFutureLineupMutation = null;
      }
      actionOutcome = failure.outcome;
    } finally {
      if (operationGeneration === this.rosterOperationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      if (mutationGeneration === this.futureLineupMutationGeneration) {
        this.futureLineupSaving.set(false);
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  beginIrBenchActivation(irSlotId: string): void {
    if (!this.isOwnTeam()) {
      return;
    }

    const roster = this.roster();
    const irSlot = roster?.irSlots.find((slot) => slot.slotId === irSlotId);
    if (!irSlot?.asset) {
      this.rosterMoveError.set('That Injured Reserve (IR) slot is empty.');
      return;
    }

    const target =
      roster?.benchSlots.find((slot) => slot.asset === null) ??
      roster?.benchSlots.find((slot) => !this.isBenchSlotReservedForActiveSwap(slot)) ??
      null;
    if (!target) {
      this.rosterMoveError.set('No bench slot is available.');
      return;
    }

    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');
    this.irBenchActivationSlotId.set(irSlotId);
    this.irBenchActivationTargetSlotId.set(target.slotId);
  }

  cancelIrBenchActivation(): void {
    if (this.rosterMoveLoading()) {
      return;
    }

    this.irBenchActivationSlotId.set('');
    this.irBenchActivationTargetSlotId.set('');
  }

  getPendingIrBenchActivationSlot(): IrRosterSlot | null {
    const slotId = this.irBenchActivationSlotId();
    return this.roster()?.irSlots.find((slot) => slot.slotId === slotId) ?? null;
  }

  getIrBenchActivationTargets(): BenchRosterSlot[] {
    return this.roster()?.benchSlots ?? [];
  }

  isBenchSlotReservedForActiveSwap(slot: BenchRosterSlot): boolean {
    if (!slot.asset) {
      return false;
    }

    const assetKey = this.getRosterAssetKey(slot.asset);

    return Boolean(
      assetKey &&
      this.roster()?.activeSlots.some(
        (activeSlot) =>
          activeSlot.pendingMove?.sourceBenchSlotId === slot.slotId &&
          this.getRosterAssetKey(activeSlot.pendingMove.incomingAsset) === assetKey,
      ),
    );
  }

  selectIrBenchActivationTarget(slotId: string): void {
    const slot = this.getIrBenchActivationTargets().find(
      (candidate) => candidate.slotId === slotId,
    );

    if (!this.rosterMoveLoading() && slot && !this.isBenchSlotReservedForActiveSwap(slot)) {
      this.irBenchActivationTargetSlotId.set(slotId);
    }
  }

  canConfirmIrBenchActivation(): boolean {
    const irSlot = this.getPendingIrBenchActivationSlot();
    const targetSlot = this.getIrBenchActivationTargets().find(
      (slot) => slot.slotId === this.irBenchActivationTargetSlotId(),
    );
    return (
      this.isOwnTeam() &&
      !!irSlot?.asset &&
      !!targetSlot &&
      !this.isBenchSlotReservedForActiveSwap(targetSlot) &&
      this.clientHealth.competitiveActionsReady() &&
      !this.rosterMoveLoading()
    );
  }

  async confirmIrBenchActivation(): Promise<void> {
    if (!this.ensureCompetitiveActionReady()) {
      return;
    }

    const irSlot = this.getPendingIrBenchActivationSlot();
    const targetSlot = this.getIrBenchActivationTargets().find(
      (slot) => slot.slotId === this.irBenchActivationTargetSlotId(),
    );
    if (!irSlot?.asset || !targetSlot) {
      this.rosterMoveError.set('Choose a valid Injured Reserve player and bench destination.');
      return;
    }

    const playerName = this.getRosterAssetName(irSlot.asset);
    const replacedAsset = targetSlot.asset;
    const actionHandle = this.actionMonitor.begin('injured-reserve');
    let actionOutcome: 'success' | 'error' | 'uncertain' = 'error';
    const operationGeneration = ++this.rosterOperationGeneration;
    const previousRosterFingerprint = this.getRosterOperationFingerprint();

    this.irBenchActivationSlotId.set('');
    this.irBenchActivationTargetSlotId.set('');
    this.rosterMoveLoading.set(true);
    this.rosterMoveError.set('');

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const request = activateIrRosterAssetToBench({
        leagueId: this.leagueId,
        ownerId: this.userId,
        irSlotId: irSlot.slotId,
        benchSlotId: targetSlot.slotId,
        effectiveCycleNumber,
        effectiveLabel: `Cycle ${effectiveCycleNumber}`,
      });

      await this.awaitRosterMutationConfirmation(
        request,
        previousRosterFingerprint,
        operationGeneration,
      );
      this.rosterMoveMessage.set(
        replacedAsset
          ? `${playerName} moved from Injured Reserve (IR) to ${targetSlot.slotId}. ${this.getRosterAssetName(replacedAsset)} was placed on waivers.`
          : `${playerName} moved from Injured Reserve (IR) to ${targetSlot.slotId}.`,
      );
      actionOutcome = 'success';
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to move this player from Injured Reserve (IR) to the bench.';
      this.rosterMoveError.set(message);
      actionOutcome = this.isUncertainRosterOperationMessage(message) ? 'uncertain' : 'error';
    } finally {
      if (this.rosterOperationGeneration === operationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  async moveActiveSlotToIr(slotId: string): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    if (!this.ensureCompetitiveActionReady()) {
      return;
    }

    const roster = this.roster();
    const slot = roster?.activeSlots.find((candidate) => candidate.slotId === slotId);

    if (!slot?.asset) {
      this.rosterMoveError.set('That active roster slot is empty.');
      return;
    }

    if (!this.canMoveSlotToIr(slot)) {
      this.rosterMoveError.set(
        this.getMoveToIrDisabledText(slot) || 'Unable to move that player to Injured Reserve (IR).',
      );
      return;
    }

    const actionHandle = this.actionMonitor.begin('injured-reserve');
    let actionOutcome: 'success' | 'error' | 'uncertain' = 'error';
    const operationGeneration = ++this.rosterOperationGeneration;
    const previousRosterFingerprint = this.getRosterOperationFingerprint();
    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const playerName = this.getRosterAssetName(slot.asset);
      const availabilityLabel =
        this.getPlayerAvailability(slot.asset)?.label ?? 'Injured Reserve eligible';
      const request = moveRosterAssetToIr({
        leagueId: this.leagueId,
        ownerId: this.userId,
        activeSlotId: slotId,
        effectiveCycleNumber,
        effectiveLabel,
      });
      const execution = await this.awaitRosterMutationConfirmation(
        request,
        previousRosterFingerprint,
        operationGeneration,
      );
      const mode = execution?.mode ?? 'queued';
      const confirmedCycle = execution?.effectiveCycleNumber ?? effectiveCycleNumber;

      this.rosterMoveMessage.set(
        mode === 'immediate'
          ? `${playerName} moved to Injured Reserve (IR) with a ${availabilityLabel} designation. The untouched Matchup ${confirmedCycle} assignment was removed immediately, so a bench player or free agent can fill that slot now.`
          : `${playerName} moved to Injured Reserve (IR) with a ${availabilityLabel} designation. The player’s already-started six-game count remains unchanged, and a replacement begins in Matchup ${confirmedCycle}.`,
      );
      actionOutcome = 'success';
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to move this player to Injured Reserve (IR).';
      this.rosterMoveError.set(message);
      actionOutcome = this.isUncertainRosterOperationMessage(message) ? 'uncertain' : 'error';
    } finally {
      if (this.rosterOperationGeneration === operationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  async confirmIrActivation(): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    if (!this.ensureCompetitiveActionReady()) {
      return;
    }

    const irSlot = this.getPendingIrActivationSlot();
    const targetSlotId = this.irActivationTargetSlotId();

    if (!irSlot?.asset) {
      this.rosterMoveError.set('That Injured Reserve (IR) slot is empty.');
      this.cancelIrActivation();
      return;
    }

    const targetSlot = this.getActiveSlotsForIrAsset(irSlot.asset).find(
      (slot) => slot.slotId === targetSlotId,
    );

    if (!targetSlot) {
      this.rosterMoveError.set(`Choose a valid ${irSlot.asset.position} roster slot.`);
      return;
    }

    const benchSlot = targetSlot.asset ? this.getSelectedIrActivationBenchSlot() : null;

    if (targetSlot.asset && !benchSlot) {
      this.rosterMoveError.set(
        'Choose the bench spot that should receive the displaced starter. If every bench spot is full, choose the bench player or goalie unit to place on waivers.',
      );
      return;
    }

    const playerName = this.getRosterAssetName(irSlot.asset);
    const replacedPlayerName = targetSlot.asset ? this.getRosterAssetName(targetSlot.asset) : '';
    const waivedBenchAssetName = benchSlot?.asset ? this.getRosterAssetName(benchSlot.asset) : '';
    const actionHandle = this.actionMonitor.begin('injured-reserve');
    let actionOutcome: 'success' | 'error' | 'uncertain' = 'error';
    const operationGeneration = ++this.rosterOperationGeneration;
    const previousRosterFingerprint = this.getRosterOperationFingerprint();

    this.irActivationSlotId.set('');
    this.irActivationTargetSlotId.set('');
    this.irActivationBenchSlotId.set('');
    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const request = activateIrRosterAsset({
        leagueId: this.leagueId,
        ownerId: this.userId,
        irSlotId: irSlot.slotId,
        activeSlotId: targetSlot.slotId,
        benchSlotId: benchSlot?.slotId ?? null,
        effectiveCycleNumber,
        effectiveLabel,
      });
      const execution = await this.awaitRosterMutationConfirmation(
        request,
        previousRosterFingerprint,
        operationGeneration,
      );
      const confirmedCycle = execution?.effectiveCycleNumber ?? effectiveCycleNumber;
      const activationLabel = `Matchup ${confirmedCycle}`;
      const observedTarget = this.roster()?.activeSlots.find(
        (slot) => slot.slotId === targetSlot.slotId,
      );
      const playerKey = this.getRosterAssetKey(irSlot.asset);
      const mode =
        execution?.mode ??
        (this.getRosterAssetKey(observedTarget?.asset) === playerKey ? 'immediate' : 'queued');

      this.rosterMoveMessage.set(
        mode === 'immediate'
          ? replacedPlayerName
            ? `${playerName} activated from Injured Reserve (IR) into ${targetSlot.position} Slot ${targetSlot.slotNumber} immediately. ${replacedPlayerName} moved to Bench ${benchSlot?.slotNumber ?? ''}${waivedBenchAssetName ? `, and ${waivedBenchAssetName} was placed on waivers` : ' without dropping anyone'}. The untouched six-game count now belongs to ${playerName} in ${activationLabel}.`
            : `${playerName} activated from Injured Reserve (IR) into ${targetSlot.position} Slot ${targetSlot.slotNumber} immediately for ${activationLabel}.`
          : replacedPlayerName
            ? `${playerName} moved into ${targetSlot.position} Slot ${targetSlot.slotNumber}. ${replacedPlayerName} moved to Bench ${benchSlot?.slotNumber ?? ''}${waivedBenchAssetName ? `, and ${waivedBenchAssetName} was placed on waivers` : ' without dropping anyone'}. The already-started six-game scoring assignment remains unchanged until ${activationLabel}.`
            : `${playerName} moved into ${targetSlot.position} Slot ${targetSlot.slotNumber}. Scoring eligibility begins with ${activationLabel}.`,
      );
      actionOutcome = 'success';
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to activate this player from Injured Reserve (IR).';
      this.rosterMoveError.set(message);
      actionOutcome = this.isUncertainRosterOperationMessage(message) ? 'uncertain' : 'error';
    } finally {
      if (this.rosterOperationGeneration === operationGeneration) {
        this.rosterOperationGeneration += 1;
      }
      this.rosterMoveLoading.set(false);
      actionHandle.finish(actionOutcome);
    }
  }

  getPositionSlots(position: DraftPosition): FantasyRoster['activeSlots'] {
    return this.roster()?.activeSlots.filter((slot) => slot.position === position) ?? [];
  }

  getPositionSlotsForDisplay(position: DraftPosition): ActiveRosterDisplaySlot[] {
    const selectedOption = this.getSelectedFutureLineupMatchupOption();
    const displaySlots = selectedOption
      ? this.getFutureRosterDisplaySlots()
      : this.getPositionSlots(position).map((slot): ActiveRosterDisplaySlot => ({
          ...slot,
          assignmentPending: false,
          displayCycleNumber: this.currentMatchup()?.cycleNumber ?? null,
          futureStartDate: null,
          gameMarkers: this.getRosterSlotGameMarkers(slot),
          injuryReplacementPresentation: this.getRosterSlotInjuryReplacementPresentation(slot),
          nextPlannedAssetLabel: '',
          selectedPick: null,
          selectedWindow: null,
          useLiveCurrentScoring: true,
          windowLabel: this.getRosterSlotWindowLabel(slot),
        }));

    return orderRosterEntriesForDisplay(
      displaySlots.filter((slot) => slot.position === position),
      (slot) => (slot.asset ? this.getRosterDisplayAsset(slot.asset) : null),
      this.rosterDisplayPhase(),
    );
  }

  private getFutureRosterDisplaySlots(): ActiveRosterDisplaySlot[] {
    const roster = this.roster();
    const cycleNumber = this.selectedFutureLineupCycleNumber();
    const selectedOption = this.getSelectedFutureLineupMatchupOption();

    if (!roster || !cycleNumber || !selectedOption) {
      return [];
    }

    const projectedBySlotId = new Map(
      buildFutureMatchupProjectedLineup({
        cycleNumber,
        roster,
        plan: this.selectedFutureLineupPlan(),
        plans: this.futureLineupPlans(),
        baseCycleNumber: this.getCurrentFutureLineupCycleNumber(),
        windows: this.futureLineupWindows(),
      }).map((slot) => [slot.rosterSlotId, slot] as const),
    );

    return roster.activeSlots.map((sourceSlot): ActiveRosterDisplaySlot => {
      const projected = projectedBySlotId.get(sourceSlot.slotId) ?? null;
      const selectedWindow =
        this.futureLineupWindows().find(
          (window) => window.rosterSlotId === sourceSlot.slotId,
        ) ?? null;
      const plannedSlot = this.selectedFutureLineupPlan()?.slots.find(
        (slot) => slot.rosterSlotId === sourceSlot.slotId,
      ) ?? null;
      const selectedPick = this.getSelectedCycleRosterPick(sourceSlot.slotId);
      const livePick = this.getRosterSlotCyclePick(sourceSlot);
      const livePickAsset =
        selectedOption.timing === 'current' &&
        this.latestCycle()?.cycleNumber === cycleNumber &&
        plannedSlot?.resolution !== 'planned'
          ? (livePick?.asset as RosterAsset | null | undefined) ?? null
          : null;
      const selectedCycle = this.futureLineupOptionCycles().find(
        (cycle) => cycle.cycleNumber === cycleNumber,
      ) ?? null;
      const selectedSlotExpectation = resolveSelectedMatchupSlotExpectation({
        expectedRosterSlotIdsByOwner: selectedCycle?.expectedRosterSlotIdsByOwner,
        ownerId: this.viewedOwnerId(),
        rosterSlotId: sourceSlot.slotId,
        physicalSlotHasAsset: Boolean(sourceSlot.asset),
      });
      // Current slow slots may render their projected identity until their exact
      // window arrives. Earlier overlapping matchups must instead prove the
      // selected-cycle pick/window, or prove that the slot was legitimately
      // omitted because it was open.
      const assignmentIdentity = resolveSelectedMatchupAssignmentIdentity({
        timing: selectedOption.timing,
        plannedResolution: plannedSlot?.resolution ?? null,
        selectedSlotExpectation,
        livePickAssetKey: this.getRosterAssetKey(livePickAsset) || null,
        selectedPickAssetKey: this.getRosterAssetKey(selectedPick?.asset) || null,
        selectedWindowAssetKey: selectedWindow?.assetKey ?? null,
        projectedAssetKey: projected?.assetKey ?? null,
      });
      const asset = (
        assignmentIdentity.source === 'live-pick'
          ? livePickAsset
          : assignmentIdentity.source === 'selected-pick'
            ? selectedPick?.asset ?? null
            : assignmentIdentity.source === 'selected-window'
              ? selectedWindow?.asset ?? null
              : assignmentIdentity.source.startsWith('projected-')
                ? projected?.asset ?? null
                : null
      ) as RosterAsset | null;
      const assetKey = this.getRosterAssetKey(asset);
      const exactSelectedPick =
        assetKey && this.getRosterAssetKey(selectedPick?.asset) === assetKey
          ? selectedPick
          : null;
      const exactSelectedWindow =
        assetKey && selectedWindow?.assetKey === assetKey ? selectedWindow : null;
      const useLiveCurrentScoring = shouldUseLiveSelectedMatchupScoring({
        timing: selectedOption.timing,
        selectedCycleNumber: cycleNumber,
        latestCycleNumber: this.latestCycle()?.cycleNumber ?? null,
        displayedAssetKey: assetKey || null,
        livePickAssetKey: this.getRosterAssetKey(livePick?.asset) || null,
      });
      const liveDisplaySlot: ActiveRosterSlot = {
        ...sourceSlot,
        asset,
      };
      const injuryReplacementPresentation = useLiveCurrentScoring
        ? this.getRosterSlotInjuryReplacementPresentation(liveDisplaySlot)
        : exactSelectedWindow && assetKey
          ? buildReconciledInjuryReplacementPresentation({
              source: exactSelectedWindow,
              ownerId: this.viewedOwnerId(),
              rosterSlotId: sourceSlot.slotId,
              currentAssetKey: assetKey,
              injuryReplacementWindows: [exactSelectedWindow.injuryReplacementWindow],
            })
          : null;

      return {
        ...sourceSlot,
        asset,
        pendingMove: null,
        assignmentPending:
          assignmentIdentity.source === 'pending' && selectedOption.timing === 'open',
        displayCycleNumber: cycleNumber,
        futureStartDate: this.getFutureLineupStartDate(sourceSlot, asset),
        gameMarkers: useLiveCurrentScoring
          ? this.getRosterSlotGameMarkers(liveDisplaySlot)
          : this.getFutureRosterSlotGameMarkers(sourceSlot, asset, exactSelectedWindow),
        injuryReplacementPresentation,
        nextPlannedAssetLabel: this.getNextFutureLineupAssignmentLabel(
          sourceSlot.slotId,
          assetKey || null,
          cycleNumber,
        ),
        selectedPick: exactSelectedPick,
        selectedWindow: exactSelectedWindow,
        useLiveCurrentScoring,
        windowLabel: useLiveCurrentScoring
          ? this.getRosterSlotWindowLabel(liveDisplaySlot)
          : this.getFutureRosterSlotWindowLabel(sourceSlot, asset, exactSelectedWindow),
      };
    });
  }

  private getSelectedRosterDisplaySlot(slotId: string): ActiveRosterDisplaySlot | null {
    for (const group of this.rosterPositions) {
      const slot = this.getPositionSlotsForDisplay(group.position).find(
        (candidate) => candidate.slotId === slotId,
      );
      if (slot) {
        return slot;
      }
    }

    return null;
  }

  private getFutureDisplayPositionSlots(position: DraftPosition): ActiveRosterDisplaySlot[] {
    return this.getPositionSlotsForDisplay(position);
  }

  private getNextFutureLineupAssignmentLabel(
    rosterSlotId: string,
    selectedAssetKey: string | null,
    selectedCycleNumber: number,
  ): string {
    const nextAssignment = [...this.futureLineupPlans()]
      .filter((plan) => plan.cycleNumber > selectedCycleNumber)
      .sort((first, second) => first.cycleNumber - second.cycleNumber)
      .map((plan) => ({
        cycleNumber: plan.cycleNumber,
        slot: plan.slots.find((candidate) => candidate.rosterSlotId === rosterSlotId) ?? null,
      }))
      .find(({ slot }) => {
        if (!slot) {
          return false;
        }
        const effectiveAssetKey =
          slot.resolution !== 'planned' && slot.resolvedAssetKey !== undefined
            ? slot.resolvedAssetKey
            : slot.assetKey;
        return effectiveAssetKey !== selectedAssetKey;
      });

    if (!nextAssignment?.slot) {
      return '';
    }

    const assetKey =
      nextAssignment.slot.resolution !== 'planned' &&
      nextAssignment.slot.resolvedAssetKey !== undefined
        ? nextAssignment.slot.resolvedAssetKey
        : nextAssignment.slot.assetKey;
    const asset = assetKey ? this.getFutureLineupAssetByKey(assetKey) : null;

    return asset
      ? `Matchup ${nextAssignment.cycleNumber}: ${this.getRosterAssetName(asset)} is scheduled to start.`
      : `This slot changes in Matchup ${nextAssignment.cycleNumber}.`;
  }

  getRosterDisplayOrderLabel(): string {
    return `Top performer first by ${getRosterDisplayMetricLabel(this.rosterDisplayPhase()).toLowerCase()}`;
  }

  getRosterAssetDisplayMetric(asset: unknown): number | null {
    const displayAsset = this.getRosterDisplayAsset(asset);

    return displayAsset ? getRosterDisplayMetric(displayAsset, this.rosterDisplayPhase()) : null;
  }

  getRosterAssetDisplayMetricLabel(): string {
    return this.rosterDisplayPhase() === 'in-season' ? 'Season' : 'Season Proj';
  }

  private getRosterDisplayAsset(asset: unknown): DraftableAsset | null {
    const assetKey = this.getRosterAssetKey(asset);
    const currentProjectionAsset = assetKey
      ? (this.playerPool().find((candidate) => candidate.assetKey === assetKey) ?? null)
      : null;

    return currentProjectionAsset ?? this.getRosterAssetProjection(asset);
  }

  getManagerName(): string {
    const profile = this.profile();
    const currentUser = auth.currentUser;

    if (!this.isOwnTeam()) {
      return this.team()?.managerName?.trim() || this.team()?.teamName?.trim() || 'Manager';
    }

    return (
      profile?.username?.trim() ||
      currentUser?.displayName?.trim() ||
      currentUser?.email?.split('@')[0] ||
      'Manager'
    );
  }

  getFavoriteTeamLogoUrl(): string {
    return getPixelTeamTheme(
      this.profile()?.favoriteTeamAbbreviation,
      this.profile()?.favoriteTeamVariantId,
    ).logoUrl;
  }

  getFavoriteTeamName(): string {
    return getPixelTeamTheme(
      this.profile()?.favoriteTeamAbbreviation,
      this.profile()?.favoriteTeamVariantId,
    ).name;
  }

  getTeamContextLine(): string {
    if (!this.isOwnTeam()) {
      return `${this.league()?.name ?? 'League'} · Read-only roster`;
    }

    return `${this.league()?.name ?? 'League'} · ${this.getFavoriteTeamName()}`;
  }

  getLeagueRankLabel(): string {
    const rank = this.leagueRank();
    const teamCount = this.teams().length;

    return rank && teamCount > 0 ? `#${rank} of ${teamCount}` : '—';
  }

  isRosterAssetInjured(asset: RosterAsset): boolean {
    const status = this.getPlayerAvailability(asset)?.status;

    return Boolean(
      status &&
      ['day-to-day', 'out', 'injured-reserve', 'long-term-injured-reserve'].includes(status),
    );
  }

  isRosterAssetSuspended(asset: RosterAsset): boolean {
    return this.getPlayerAvailability(asset)?.status === 'suspended';
  }

  hasRosterAssetAlert(asset: RosterAsset): boolean {
    return this.isRosterAssetInjured(asset) || this.isRosterAssetSuspended(asset);
  }

  getRosterAssetAlertIcon(asset: RosterAsset): string {
    return this.isRosterAssetSuspended(asset) ? '⛔' : '✚';
  }

  getRosterAssetAlertTitle(asset: RosterAsset): string {
    if (this.isRosterAssetSuspended(asset)) {
      return 'Suspended';
    }

    return this.getPlayerInjuryBodyPart(asset);
  }

  getRosterAssetAlertDetail(asset: RosterAsset): string {
    if (this.isRosterAssetSuspended(asset)) {
      const availability = this.getPlayerAvailability(asset);
      return availability?.note?.trim() || availability?.label || 'Unavailable until reinstated';
    }

    return this.getPlayerExpectedReturnLabel(asset);
  }

  getRosterAssetAlertTooltip(asset: RosterAsset): string {
    const title = this.getRosterAssetAlertTitle(asset);
    const detail = this.getRosterAssetAlertDetail(asset);

    return `${title}: ${detail}`;
  }

  getRosterAvailabilityTooltip(asset: RosterAsset): string {
    const availability = this.getPlayerAvailability(asset);

    if (!availability) {
      return '';
    }

    return availability.note?.trim()
      ? `${availability.label}: ${availability.note.trim()}`
      : availability.label;
  }

  shouldShowMoveToIrAction(asset: RosterAsset): boolean {
    return asset.assetType === 'skater' && this.isPlayerIrEligible(asset);
  }

  getPlayerInjuryBodyPart(asset: RosterAsset): string {
    const availability = this.getPlayerAvailability(asset);

    if (!availability) {
      return 'Injury';
    }

    const searchableText =
      `${availability.externalStatus ?? ''} ${availability.note ?? ''}`.toLowerCase();
    const injuryLabels: Array<[RegExp, string]> = [
      [/concussion|head|face/, 'Head'],
      [/chest|rib|sternum/, 'Chest'],
      [/upper[- ]body/, 'Upper Body'],
      [/lower[- ]body/, 'Lower Body'],
      [/shoulder|clavicle/, 'Shoulder'],
      [/arm|elbow/, 'Arm / Elbow'],
      [/wrist|hand|finger|thumb/, 'Hand / Wrist'],
      [/back|spine/, 'Back'],
      [/hip|groin/, 'Hip / Groin'],
      [/knee/, 'Knee'],
      [/leg|calf|hamstring|quad/, 'Leg'],
      [/ankle|foot|toe/, 'Ankle / Foot'],
      [/illness|flu|virus/, 'Illness'],
    ];

    return (
      injuryLabels.find(([pattern]) => pattern.test(searchableText))?.[1] ?? availability.label
    );
  }

  getPlayerExpectedReturnLabel(asset: RosterAsset): string {
    const availability = this.getPlayerAvailability(asset);
    const rawReturnDate = availability?.externalReturnDate;

    if (!rawReturnDate) {
      return 'Return date not announced';
    }

    const returnDate = new Date(rawReturnDate);

    if (Number.isNaN(returnDate.getTime())) {
      return 'Return date not announced';
    }

    const dateOptions: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
    };

    if (returnDate.getFullYear() !== new Date().getFullYear()) {
      dateOptions.year = 'numeric';
    }

    return `Expected back ${returnDate.toLocaleDateString(undefined, dateOptions)}`;
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  getTeamRecord(team: FantasyTeam | null): string {
    if (!team) {
      return '0-0-0';
    }

    return `${team.wins ?? 0}-${team.losses ?? 0}-${team.ties ?? 0}`;
  }

  getWinPercentage(team: FantasyTeam | null): string {
    if (!team) {
      return '.000';
    }

    const wins = team.wins ?? 0;
    const losses = team.losses ?? 0;
    const ties = team.ties ?? 0;
    const decisions = wins + losses + ties;

    if (decisions <= 0) {
      return '.000';
    }

    const percentage = (wins + ties * 0.5) / decisions;

    return percentage.toFixed(3).replace(/^0/, '');
  }

  getDisplayNumber(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getSignedDisplayNumber(value: number): string {
    const rounded = value.toFixed(1);

    return value > 0 ? `+${rounded}` : rounded;
  }

  getMatchupScore(matchup: FantasyMatchup | null, ownerId: string | null): number | null {
    if (!matchup || !ownerId) {
      return null;
    }

    if (matchup.teamAOwnerId === ownerId) {
      return matchup.teamAScore;
    }

    if (matchup.teamBOwnerId === ownerId) {
      return matchup.teamBScore;
    }

    return null;
  }

  getCurrentMatchupLink(): Array<string | number> {
    const matchup = this.currentNavigationMatchup();

    if (matchup) {
      return ['/leagues', this.leagueId, 'cycles', matchup.cycleNumber, 'matchups', matchup.id];
    }

    return ['/leagues', this.leagueId, 'cycles', this.latestCycle()?.cycleNumber ?? 1];
  }

  getCurrentMatchupStatusText(): string {
    const matchup = this.currentFutureLineupMatchup;

    if (!this.latestCycle() && !matchup) {
      return 'No matchup has started yet.';
    }

    if (!matchup) {
      return 'No current matchup is available for this team yet.';
    }

    if (matchup.status === 'complete') {
      return `${this.getCycleLabel()} matchup is complete.`;
    }

    return `${this.getCycleLabel()} is active.`;
  }

  getCycleLabel(): string {
    const cycleNumber =
      this.selectedFutureLineupCycleNumber() ??
      this.latestCycle()?.cycleNumber ??
      this.currentMatchup()?.cycleNumber;

    return cycleNumber ? `Matchup ${cycleNumber}` : 'Current Matchup';
  }

  getRosterAssetName(asset: unknown): string {
    const rosterAsset = asset as {
      assetType?: string;
      player?: { fullName?: string; firstName?: string; lastName?: string };
      teamName?: string;
    };

    if (rosterAsset.assetType === 'skater') {
      const fallbackName = [rosterAsset.player?.firstName, rosterAsset.player?.lastName]
        .filter(Boolean)
        .join(' ');

      return (rosterAsset.player?.fullName ?? fallbackName) || 'Unknown Player';
    }

    if (rosterAsset.assetType === 'team-goalie-unit') {
      return `${rosterAsset.teamName ?? 'Unknown'} Goalie Unit`;
    }

    return 'Unknown Roster Entry';
  }

  getRosterAssetTeamLabel(asset: unknown): string {
    const rosterAsset = asset as {
      assetType?: string;
      player?: { nhlTeamAbbreviation?: string; teamAbbrev?: string };
      teamAbbreviation?: string;
    };

    if (rosterAsset.assetType === 'skater') {
      const scheduleTeamAbbreviation = this.getRosterAssetScoreSummary(asset)
        ?.scheduleTeamAbbreviation?.trim()
        .toUpperCase();

      return scheduleTeamAbbreviation && /^[A-Z0-9]{2,4}$/.test(scheduleTeamAbbreviation)
        ? scheduleTeamAbbreviation
        : (rosterAsset.player?.nhlTeamAbbreviation ?? rosterAsset.player?.teamAbbrev ?? '—');
    }

    return rosterAsset.teamAbbreviation ?? '—';
  }

  getRosterAssetPortrait(asset: unknown): AssetPortraitSource {
    const rosterAsset = asset as AssetPortraitSource;

    if (rosterAsset.assetType !== 'skater') {
      return rosterAsset;
    }

    const currentTeamAbbreviation = this.getRosterAssetTeamLabel(asset);

    if (
      currentTeamAbbreviation === '—' ||
      !/^[A-Z0-9]{2,4}$/.test(currentTeamAbbreviation) ||
      currentTeamAbbreviation === rosterAsset.player.nhlTeamAbbreviation
    ) {
      return rosterAsset;
    }

    return {
      ...rosterAsset,
      player: {
        ...rosterAsset.player,
        nhlTeamAbbreviation: currentTeamAbbreviation,
        teamLogoUrl: `https://assets.nhle.com/logos/nhl/svg/${currentTeamAbbreviation}_light.svg`,
      },
    };
  }

  getRosterAssetProjection(asset: unknown): DraftableAsset | null {
    const rosterAsset = asset as {
      assetType?: string;
      assetKey?: string;
      position?: DraftPosition;
      player?: unknown;
      teamName?: string;
      teamAbbreviation?: string;
      teamLogoUrl?: string;
      projectedSeasonPoints?: number | null;
      projectedCyclePoints?: number | null;
      reliabilityRating?: number | null;
      volatilityPenalty?: number | null;
      floorAdjustedCyclePoints?: number | null;
      floorAdjustedDraftValue?: number | null;
    };

    if (!rosterAsset.assetType) {
      return null;
    }

    const assetKey = this.getRosterAssetKey(asset);
    const userPicks = this.picks().filter((pick) => pick.ownerId === this.viewedOwnerId());

    if (assetKey) {
      const pickAsset = userPicks.find((pick) => pick.asset.assetKey === assetKey)?.asset;

      if (pickAsset) {
        return pickAsset;
      }

      const poolAsset = this.playerPool().find(
        (availableAsset) => availableAsset.assetKey === assetKey,
      );

      if (poolAsset) {
        return poolAsset;
      }
    }

    if (rosterAsset.assetType === 'team-goalie-unit') {
      const teamAbbreviation = rosterAsset.teamAbbreviation;

      const pickAsset = userPicks.find(
        (pick) =>
          pick.asset.assetType === 'team-goalie-unit' &&
          pick.asset.teamAbbreviation === teamAbbreviation,
      )?.asset;

      const poolAsset = this.playerPool().find(
        (availableAsset) =>
          availableAsset.assetType === 'team-goalie-unit' &&
          availableAsset.teamAbbreviation === teamAbbreviation,
      );

      return (
        pickAsset ??
        poolAsset ?? {
          assetType: 'team-goalie-unit',
          assetKey: assetKey || `goalie-unit-${teamAbbreviation ?? 'UNKNOWN'}`,
          position: 'G',
          teamName: rosterAsset.teamName ?? 'Unknown',
          teamAbbreviation: teamAbbreviation ?? '—',
          teamLogoUrl: rosterAsset.teamLogoUrl,
          projectedSeasonPoints: rosterAsset.projectedSeasonPoints ?? null,
          projectedCyclePoints: rosterAsset.projectedCyclePoints ?? null,
          reliabilityRating: rosterAsset.reliabilityRating ?? null,
          volatilityPenalty: rosterAsset.volatilityPenalty ?? null,
          floorAdjustedCyclePoints: rosterAsset.floorAdjustedCyclePoints ?? null,
          floorAdjustedDraftValue: rosterAsset.floorAdjustedDraftValue ?? null,
        }
      );
    }

    const rosterPlayerId = this.getPlayerId(rosterAsset.player);

    const pickAsset = userPicks.find((pick) => {
      if (pick.asset.assetType !== 'skater') {
        return false;
      }

      const draftPlayerId = this.getPlayerId(pick.asset.player);

      if (rosterPlayerId !== null && draftPlayerId !== null) {
        return rosterPlayerId === draftPlayerId;
      }

      return this.getAssetName(pick.asset) === this.getRosterAssetName(asset);
    })?.asset;

    const poolAsset = this.playerPool().find((availableAsset) => {
      if (availableAsset.assetType !== 'skater') {
        return false;
      }

      const poolPlayerId = this.getPlayerId(availableAsset.player);

      return rosterPlayerId !== null && poolPlayerId !== null && rosterPlayerId === poolPlayerId;
    });

    if (pickAsset || poolAsset) {
      return pickAsset ?? poolAsset ?? null;
    }

    if (rosterAsset.position && rosterAsset.player) {
      return {
        assetType: 'skater',
        assetKey: assetKey || `skater-${rosterPlayerId ?? 'unknown'}`,
        position: rosterAsset.position as 'LW' | 'C' | 'RW' | 'D',
        player: rosterAsset.player as NHLPlayer,
        projectedSeasonPoints: rosterAsset.projectedSeasonPoints ?? null,
        projectedCyclePoints: rosterAsset.projectedCyclePoints ?? null,
        reliabilityRating: rosterAsset.reliabilityRating ?? null,
        volatilityPenalty: rosterAsset.volatilityPenalty ?? null,
        floorAdjustedCyclePoints: rosterAsset.floorAdjustedCyclePoints ?? null,
        floorAdjustedDraftValue: rosterAsset.floorAdjustedDraftValue ?? null,
      } as DraftableAsset;
    }

    return null;
  }

  private hasSelectedMatchupScoringDetail(activeSlotId: string): boolean {
    const selectedOption = this.getSelectedFutureLineupMatchupOption();
    const displaySlot = activeSlotId
      ? this.getSelectedRosterDisplaySlot(activeSlotId)
      : null;

    return Boolean(
      selectedOption?.materialized &&
      displaySlot &&
      (displaySlot.selectedWindow || displaySlot.selectedPick || displaySlot.useLiveCurrentScoring),
    );
  }

  openRosterAssetDetail(asset: unknown, activeSlotId = ''): void {
    const projectionAsset = this.getRosterAssetProjection(asset);

    if (!projectionAsset) {
      return;
    }

    const selectedOption = activeSlotId
      ? this.getSelectedFutureLineupMatchupOption()
      : null;
    if (selectedOption && !this.hasSelectedMatchupScoringDetail(activeSlotId)) {
      this.openRosterAssetIntel(asset);
      return;
    }

    const cycleNumber = selectedOption?.cycleNumber ?? this.latestCycle()?.cycleNumber ?? 1;

    void this.router.navigate(
      ['/leagues', this.leagueId, 'cycles', cycleNumber, 'assets', projectionAsset.assetKey],
      {
        queryParams: {
          returnTo: this.router.url,
        },
      },
    );
  }

  openRosterAssetIntel(asset: unknown): void {
    const assetKey = this.getRosterAssetKey(asset);

    if (!assetKey) {
      return;
    }

    void this.router.navigate(['/leagues', this.leagueId, 'players', assetKey]);
  }

  handleRosterCardSurfaceClick(
    event: MouseEvent,
    asset: unknown,
    detailContext: 'matchup' | 'player-intel' = 'matchup',
    activeSlotId = '',
  ): void {
    const target = event.target;

    if (
      target instanceof Element &&
      target.closest('button, a, input, select, textarea, [role="button"], [role="link"]')
    ) {
      return;
    }

    if (detailContext === 'player-intel') {
      this.openRosterAssetIntel(asset);
      return;
    }

    this.openRosterAssetDetail(asset, activeSlotId);
  }

  handleRosterIdentityKeydown(
    event: KeyboardEvent,
    asset: unknown,
    detailContext: 'matchup' | 'player-intel' = 'matchup',
    activeSlotId = '',
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (detailContext === 'player-intel') {
      this.openRosterAssetIntel(asset);
      return;
    }

    this.openRosterAssetDetail(asset, activeSlotId);
  }

  getProjectedCycle(asset: unknown): number | null {
    return this.getRosterAssetProjection(asset)?.projectedCyclePoints ?? null;
  }

  getBenchCurrentBlockScore(asset: unknown): number | null {
    return this.getRosterDisplayAsset(asset)?.currentTeamCycleFantasyPoints ?? null;
  }

  getBenchCurrentBlockMarkers(asset: unknown): LeaguePlayerProgressMarker[] {
    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;

    return buildProjectionProgressMarkers(
      this.getRosterDisplayAsset(asset)?.currentTeamCycleGames,
      requiredGames,
    );
  }

  getBenchCurrentBlockLabel(asset: unknown): string {
    const projectionAsset = this.getRosterDisplayAsset(asset);
    const blockNumber = projectionAsset?.currentTeamCycleNumber;
    const markers = this.getBenchCurrentBlockMarkers(asset);
    const appearances = markers.filter((marker) => marker.status === 'played').length;
    const completed = markers.filter(
      (marker) => marker.status === 'played' || marker.status === 'missed',
    ).length;
    const blockLabel = blockNumber ? `NHL block ${blockNumber}` : 'Current NHL block';

    return `${blockLabel}: ${appearances} appearances, ${completed} of ${markers.length} team games complete. Bench points do not count toward the matchup.`;
  }

  getRosterAssetScoreSummary(asset: unknown): CycleAssetScoreSummary | null {
    const projectionAsset = this.getRosterAssetProjection(asset);

    if (!projectionAsset) {
      return null;
    }

    return this.cycleScoring()?.assetScores[projectionAsset.assetKey] ?? null;
  }

  private getRosterSlotCyclePick(slot: ActiveRosterSlot): DraftPick | null {
    return (
      this.cycleRosterPicks().find(
        (candidate) =>
          candidate.ownerId === this.viewedOwnerId() && candidate.rosterSlotId === slot.slotId,
      ) ?? null
    );
  }

  private getSelectedCycleRosterPick(rosterSlotId: string): DraftPick | null {
    const selectedCycleNumber = this.selectedFutureLineupCycleNumber();
    const isLatestSelected =
      selectedCycleNumber !== null &&
      selectedCycleNumber === this.latestCycle()?.cycleNumber;
    const isSelectedCycleSlot = (pick: DraftPick): boolean =>
      pick.ownerId === this.viewedOwnerId() &&
      pick.rosterSlotId === rosterSlotId &&
      (pick.snapshotCycleNumber ?? selectedCycleNumber) === selectedCycleNumber;
    // A successful selected-matchup mutation is followed by this bounded exact
    // read before the shared live listener is guaranteed to converge.
    const exactSelectedPick = this.futureLineupRosterPicks().find(
      isSelectedCycleSlot,
    );

    if (exactSelectedPick || !isLatestSelected) {
      return exactSelectedPick ?? null;
    }

    return this.cycleRosterPicks().find(
      isSelectedCycleSlot,
    ) ?? null;
  }

  getRosterSlotScoreSummary(slot: ActiveRosterSlot): CycleAssetScoreSummary | null {
    if (!slot.asset) {
      return null;
    }

    const assetKey = this.getRosterAssetKey(slot.asset);
    const pick = this.getRosterSlotCyclePick(slot);

    if (!assetKey) {
      return null;
    }

    return resolveCycleSlotScoreSummary(this.cycleScoring(), {
      ownerId: this.viewedOwnerId(),
      assetKey,
      rosterSlotId: slot.slotId,
      cycleWindowId: pick?.cycleWindowId,
    });
  }

  getRosterSlotInjuryReplacementPresentation(
    slot: ActiveRosterSlot,
  ): InjuryReplacementPresentation | null {
    const summary = this.getRosterSlotScoreSummary(slot);
    const pick = this.getRosterSlotCyclePick(slot);
    const currentAssetKey = this.getRosterAssetKey(slot.asset);

    return buildReconciledInjuryReplacementPresentation({
      source: summary,
      ownerId: this.viewedOwnerId(),
      rosterSlotId: slot.slotId,
      currentAssetKey,
      injuryReplacementWindows: [summary?.injuryReplacementWindow, pick?.injuryReplacementWindow],
    });
  }

  getRosterSlotCurrentCycleScore(slot: ActiveRosterSlot): number | null {
    if (this.isFutureDisplaySlot(slot)) {
      return this.getSelectedMatchupSlotScoreState(slot).score;
    }

    return this.getRosterSlotScoreSummary(slot)?.currentScore ?? null;
  }

  getRosterSlotGamesPlayed(slot: ActiveRosterSlot): number | null {
    if (this.isFutureDisplaySlot(slot)) {
      return this.getSelectedMatchupSlotScoreState(slot).gamesPlayed;
    }

    return this.getRosterSlotScoreSummary(slot)?.gamesPlayed ?? null;
  }

  getRosterSlotGamesLeft(slot: ActiveRosterSlot): number | null {
    if (this.isFutureDisplaySlot(slot)) {
      return this.getSelectedMatchupSlotScoreState(slot).gamesLeft;
    }

    return this.getRosterSlotScoreSummary(slot)?.gamesLeft ?? null;
  }

  getRosterSlotGameProgress(slot: ActiveRosterSlot): string {
    if (this.isFutureDisplaySlot(slot)) {
      const scoreState = this.getSelectedMatchupSlotScoreState(slot);
      if (scoreState.gamesPlayed === null) {
        return '—';
      }

      const requiredGames =
        this.league()?.scoringRules?.requiredGamesPerCycle ??
        defaultScoringRules.requiredGamesPerCycle;
      return `${scoreState.gamesPlayed} / ${requiredGames}`;
    }

    const summary = this.getRosterSlotScoreSummary(slot);

    if (!summary) {
      return '—';
    }

    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    return `${summary.gamesPlayed} / ${requiredGames}`;
  }

  private getSelectedMatchupSlotScoreState(slot: ActiveRosterDisplaySlot) {
    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;

    return resolveSelectedMatchupSlotScoreState({
      useLiveCurrentScoring: slot.useLiveCurrentScoring,
      liveSummary: slot.useLiveCurrentScoring
        ? this.getRosterSlotScoreSummary(slot)
        : null,
      selectedWindow: slot.selectedWindow,
      materialized: this.getSelectedFutureLineupMatchupOption()?.materialized === true,
      hasPlannedAssignment: this.hasSelectedPlannedAssignment(slot.slotId),
      requiredGames,
    });
  }

  private isFutureDisplaySlot(slot: ActiveRosterSlot): slot is ActiveRosterDisplaySlot {
    return 'displayCycleNumber' in slot &&
      Boolean(this.getSelectedFutureLineupMatchupOption()) &&
      slot.displayCycleNumber === this.selectedFutureLineupCycleNumber();
  }

  private getFutureProjectedGamesForAsset(asset: RosterAsset | null): NhlTeamSeasonGame[] {
    const teamAbbreviation = asset ? this.getFutureLineupScheduleTeam(asset) : null;
    const sourceNhlBlockNumber = this.futureLineupSourceNhlBlockNumber();

    if (!teamAbbreviation || !sourceNhlBlockNumber) {
      return [];
    }

    try {
      return selectFutureMatchupProjectedGames({
        schedule: this.futureLineupSchedulesByTeam()[teamAbbreviation] ?? [],
        targetGameIds: this.futureLineupTargetGameIdsByTeam()[teamAbbreviation],
        sourceNhlBlockNumber,
        requiredGamesPerCycle:
          this.league()?.scoringRules?.requiredGamesPerCycle ??
          defaultScoringRules.requiredGamesPerCycle,
      });
    } catch {
      return [];
    }
  }

  getBenchSwapCandidateProgress(slot: BenchRosterSlot): string {
    if (!this.isFutureRosterAction()) {
      return this.getRosterAssetGameProgress(slot.asset);
    }

    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    const projectedGames = this.getFutureProjectedGamesForAsset(slot.asset);

    if (projectedGames.length !== requiredGames) {
      return 'schedule pending';
    }

    const startedGames = projectedGames.filter((game) =>
      this.hasProjectedNhlGameStarted(game),
    ).length;
    return `${startedGames} / ${requiredGames} games started`;
  }

  private getFutureRosterSlotGameMarkers(
    slot: ActiveRosterSlot,
    asset: RosterAsset | null,
    window: FantasyAssetCycleWindow | null,
  ): RosterSlotGameMarker[] {
    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    const projectedGames = window ? [] : this.getFutureProjectedGamesForAsset(asset);

    return Array.from({ length: requiredGames }, (_, index) => {
      if (window) {
        const gameId = window.scheduledGameIds[index] ?? null;
        const state = resolveCycleWindowGameMarkerState({
          gameId,
          completedGameIds: window.completedGameIds,
          appearanceGameIds: window.appearanceGameIds,
          liveGameIds: window.liveGameIds,
          gameStates: window.gameStates,
          actualGamesPlayed: window.actualGamesPlayed,
        });
        const gameDate = window.scheduledGameDates[index] ?? null;
        const gameLabel = window.scheduledGameLabels[index] ?? 'Schedule pending';
        const dateLabel = gameDate
          ? new Date(`${gameDate}T12:00:00`).toLocaleDateString()
          : 'date pending';

        return {
          index: index + 1,
          status: state.status,
          title: `Game ${index + 1}: ${gameLabel} · ${dateLabel} · ${state.statusLabel}`,
          ariaLabel: `Game ${index + 1}, ${gameLabel}, ${dateLabel}, ${state.statusLabel}`,
          replacementBoundary: false,
          currentOwner: false,
        };
      }

      const game = projectedGames[index] ?? null;
      const gameDate = game?.gameDate ?? null;
      const dateLabel = gameDate
        ? new Date(`${gameDate}T12:00:00`).toLocaleDateString()
        : 'date pending';
      const gameLabel = game
        ? `${game.awayTeam.abbrev} at ${game.homeTeam.abbrev}`
        : 'Schedule pending';
      const state = String(game?.gameState ?? '').toUpperCase();
      const markerStatus: RosterSlotGameMarker['status'] = !game
        ? 'unavailable'
        : state === 'LIVE' || state === 'CRIT'
          ? 'live'
          : this.hasProjectedNhlGameStarted(game)
            ? 'unavailable'
            : 'upcoming';
      const evidenceLabel = !game
        ? 'schedule pending'
        : markerStatus === 'live'
          ? 'live; exact scoring pending'
          : markerStatus === 'unavailable'
            ? 'started; exact scoring pending'
            : 'upcoming';

      return {
        index: index + 1,
        status: markerStatus,
        title: `Projected game ${index + 1}: ${gameLabel} · ${dateLabel} · ${evidenceLabel}`,
        ariaLabel: `Projected game ${index + 1}, ${gameLabel}, ${dateLabel}, ${evidenceLabel}`,
        replacementBoundary: false,
        currentOwner: false,
      };
    });
  }

  private getFutureRosterSlotWindowLabel(
    slot: ActiveRosterSlot,
    asset: RosterAsset | null,
    window: FantasyAssetCycleWindow | null,
  ): string {
    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    const playerName = asset ? this.getRosterAssetName(asset) : `${slot.position} slot`;

    return window
      ? `${playerName}, Matchup ${window.cycleNumber}: ${window.gamesPlayed} played and ${window.gamesLeft} left.`
      : `${playerName}: projected ${requiredGames}-game assignment; exact ownership begins only after the server materializes this matchup.`;
  }

  getRosterSlotGameMarkers(slot: ActiveRosterSlot): RosterSlotGameMarker[] {
    const summary = this.getRosterSlotScoreSummary(slot);

    if (!summary) {
      return [];
    }

    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;
    const replacement = this.getRosterSlotInjuryReplacementPresentation(slot);

    return Array.from({ length: requiredGames }, (_, index) => {
      const owner = replacement?.gameOwnership[index] ?? null;
      const gameId = owner?.gameId ?? summary.scheduledGameIds[index] ?? null;
      const scheduleIndex = gameId === null ? -1 : summary.scheduledGameIds.indexOf(gameId);
      const gameDate =
        scheduleIndex >= 0 ? (summary.scheduledGameDates[scheduleIndex] ?? null) : null;
      const gameLabel =
        scheduleIndex >= 0
          ? (summary.scheduledGameLabels[scheduleIndex] ?? 'Schedule pending')
          : 'Schedule pending';
      const state = resolveCycleWindowGameMarkerState({
        gameId,
        completedGameIds: summary.completedGameIds,
        appearanceGameIds: summary.appearanceGameIds,
        liveGameIds: summary.liveGameIds,
        gameStates: summary.gameStates,
        actualGamesPlayed: summary.actualGamesPlayed ?? 0,
      });
      const dateLabel = gameDate
        ? new Date(`${gameDate}T12:00:00`).toLocaleDateString()
        : 'date pending';
      const ownerLabel = owner ? `${owner.ariaLabel}. ` : '';

      return {
        index: index + 1,
        status: state.status,
        title: `${ownerLabel}Game ${index + 1}: ${gameLabel} · ${dateLabel} · ${state.statusLabel}`,
        ariaLabel: `${ownerLabel}Game ${index + 1}, ${gameLabel}, ${dateLabel}, ${state.statusLabel}`,
        replacementBoundary: owner?.segmentStart ?? false,
        currentOwner: owner?.currentSegment ?? false,
      };
    });
  }

  getRosterSlotWindowLabel(slot: ActiveRosterSlot): string {
    const replacement = this.getRosterSlotInjuryReplacementPresentation(slot);

    if (replacement) {
      return `Six-game roster slot. ${replacement.accessibleLabel}`;
    }

    const summary = this.getRosterSlotScoreSummary(slot);
    return summary
      ? `Six-game roster slot, ${summary.gamesPlayed} played and ${summary.gamesLeft} left.`
      : 'Six-game roster slot is still loading.';
  }

  getRosterManagerActiveSlot(): ActiveRosterSlot | null {
    if (this.rosterManagerArea() !== 'active') {
      return null;
    }

    return this.isFutureRosterAction()
      ? this.getSelectedRosterDisplaySlot(this.rosterManagerSlotId())
      : this.roster()?.activeSlots.find(
          (slot) => slot.slotId === this.rosterManagerSlotId(),
        ) ?? null;
  }

  get rosterManagerInjuryReplacementPresentation(): InjuryReplacementPresentation | null {
    const activeSlot = this.getRosterManagerActiveSlot();
    if (
      activeSlot &&
      this.isFutureDisplaySlot(activeSlot) &&
      !activeSlot.useLiveCurrentScoring
    ) {
      return activeSlot.injuryReplacementPresentation;
    }
    return activeSlot ? this.getRosterSlotInjuryReplacementPresentation(activeSlot) : null;
  }

  getRosterManagerScore(): number | null {
    const activeSlot = this.getRosterManagerActiveSlot();
    return activeSlot
      ? this.getRosterSlotCurrentCycleScore(activeSlot)
      : this.getRosterAssetCurrentCycleScore(this.rosterManagerAsset());
  }

  getRosterManagerProgress(): string {
    const activeSlot = this.getRosterManagerActiveSlot();
    return activeSlot
      ? this.getRosterSlotGameProgress(activeSlot)
      : this.getRosterAssetGameProgress(this.rosterManagerAsset());
  }

  getRosterAssetCurrentCycleScore(asset: unknown): number | null {
    return this.getRosterAssetScoreSummary(asset)?.currentScore ?? null;
  }

  getRosterAssetGamesPlayed(asset: unknown): number | null {
    return this.getRosterAssetScoreSummary(asset)?.gamesPlayed ?? null;
  }

  getRosterAssetGamesLeft(asset: unknown): number | null {
    const summary = this.getRosterAssetScoreSummary(asset);

    if (summary) {
      return summary.gamesLeft;
    }

    return null;
  }

  getRosterAssetGameProgress(asset: unknown): string {
    const summary = this.getRosterAssetScoreSummary(asset);

    if (!summary) {
      return '—';
    }

    const requiredGames =
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;

    return `${summary.gamesPlayed} / ${requiredGames}`;
  }

  getRosterAssetStatusLabel(asset: unknown): string {
    const status = this.getRosterAssetStatus(asset);

    switch (status) {
      case 'injured':
        return 'Injured';

      case 'benched':
        return 'Benched';

      case 'new':
        return 'New Add';

      case 'moved':
        return 'Moved';

      default:
        return 'Active';
    }
  }

  getRosterAssetStatusClass(asset: unknown): string {
    return `roster-status-${this.getRosterAssetStatus(asset)}`;
  }

  private getRosterAssetStatus(asset: unknown): 'active' | 'injured' | 'benched' | 'new' | 'moved' {
    const rosterAsset = asset as {
      rosterStatus?: string;
      availabilityStatus?: string;
      transactionStatus?: string;
      injuryStatus?: string;
      isInjured?: boolean;
      isBenched?: boolean;
    } | null;

    const rawStatus = (
      rosterAsset?.rosterStatus ??
      rosterAsset?.availabilityStatus ??
      rosterAsset?.transactionStatus ??
      rosterAsset?.injuryStatus ??
      ''
    ).toLowerCase();

    if (rosterAsset?.isInjured || rawStatus.includes('injur')) {
      return 'injured';
    }

    if (rosterAsset?.isBenched || rawStatus.includes('bench') || rawStatus.includes('scratch')) {
      return 'benched';
    }

    if (rawStatus.includes('new') || rawStatus.includes('add')) {
      return 'new';
    }

    if (rawStatus.includes('move') || rawStatus.includes('trade') || rawStatus.includes('waiver')) {
      return 'moved';
    }

    return 'active';
  }

  getProjectedSeason(asset: unknown): number | null {
    return this.getRosterAssetProjection(asset)?.projectedSeasonPoints ?? null;
  }

  getReliabilityRating(asset: unknown): number | null {
    return this.getRosterAssetProjection(asset)?.reliabilityRating ?? null;
  }

  getReliabilityDisplay(asset: unknown): string {
    const reliability = this.getReliabilityRating(asset);

    return typeof reliability === 'number' ? Math.round(reliability).toString() : '—';
  }

  getRiskLabel(asset: unknown): string {
    const reliability = this.getReliabilityRating(asset);

    if (typeof reliability !== 'number') {
      return 'Unknown Risk';
    }

    if (reliability >= 88) {
      return 'Very Safe';
    }

    if (reliability >= 78) {
      return 'Safe';
    }

    if (reliability >= 65) {
      return 'Normal';
    }

    if (reliability >= 50) {
      return 'Volatile';
    }

    return 'Risky';
  }

  getRiskClass(asset: unknown): string {
    const reliability = this.getReliabilityRating(asset);

    if (typeof reliability !== 'number') {
      return 'risk-unknown';
    }

    if (reliability >= 78) {
      return 'risk-safe';
    }

    if (reliability >= 65) {
      return 'risk-normal';
    }

    return 'risk-risky';
  }

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.fullName : `${asset.teamName} Goalie Unit`;
  }

  getRosterAssetEffectiveText(asset: unknown): string {
    const rosterAsset = asset as {
      rosterStatus?: string;
    } | null;

    if (rosterAsset?.rosterStatus === 'new') {
      return `Scores starting Matchup ${(this.latestCycle()?.cycleNumber ?? 0) + 1}`;
    }

    return '';
  }

  getWaiverPriorityDisplay(team: FantasyTeam | null): string {
    return typeof team?.waiverPriority === 'number' ? `#${team.waiverPriority}` : '—';
  }

  getPendingRosterMoveText(slot: ActiveRosterSlot): string {
    if (!slot.pendingMove) {
      return '';
    }

    return `Next matchup: ${this.getRosterAssetName(slot.pendingMove.incomingAsset)}`;
  }

  getTransactionAssetName(asset: DraftableAsset | RosterAsset | null | undefined): string {
    if (!asset) {
      return 'Unknown Roster Entry';
    }

    if (asset.assetType === 'skater') {
      const player = asset.player as {
        fullName?: string;
        firstName?: string;
        lastName?: string;
      };

      const fallbackName = [player.firstName, player.lastName].filter(Boolean).join(' ');

      return player.fullName || fallbackName || 'Unknown Player';
    }

    return `${asset.teamName} Goalie Unit`;
  }

  private shouldShowTransactionInLedger(transaction: FantasyTransaction): boolean {
    return [
      'add-drop',
      'add-open-slot',
      'drop-to-waivers',
      'waiver-award',
      'slot-move-activated',
      'active-bench-swap-activated',
      'injury-replacement',
      'injury-active-bench-swap',
      'injury-add-drop-active',
    ].includes(transaction.type);
  }

  getTransactionAddedAsset(transaction: FantasyTransaction): DraftableAsset | RosterAsset | null {
    if (transaction.type === 'waiver-award') {
      return transaction.waiverAsset ?? null;
    }

    if (transaction.type === 'active-bench-swap-activated') {
      return transaction.addedAsset ?? transaction.movedAsset ?? null;
    }

    if (
      transaction.type === 'injury-replacement' ||
      transaction.type === 'injury-active-bench-swap'
    ) {
      return transaction.activatedAsset ?? null;
    }

    return transaction.addedAsset ?? null;
  }

  getTransactionDroppedAsset(transaction: FantasyTransaction): RosterAsset | null {
    if (
      transaction.type === 'injury-replacement' ||
      transaction.type === 'injury-active-bench-swap'
    ) {
      return transaction.movedAsset ?? null;
    }

    return transaction.droppedAsset ?? null;
  }

  getTransactionAddedLabel(transaction: FantasyTransaction): string {
    return [
      'active-bench-swap-activated',
      'injury-replacement',
      'injury-active-bench-swap',
    ].includes(transaction.type)
      ? 'Started'
      : 'Added';
  }

  getTransactionDroppedLabel(transaction: FantasyTransaction): string {
    if (transaction.type === 'injury-replacement') {
      return 'Moved to IR';
    }

    if (transaction.type === 'injury-active-bench-swap') {
      return 'Benched';
    }

    if (transaction.type === 'injury-add-drop-active') {
      return 'Waived';
    }

    return transaction.type === 'active-bench-swap-activated' ? 'Benched' : 'Dropped';
  }

  getTransactionAddedFallback(transaction: FantasyTransaction): string {
    return transaction.type === 'drop-to-waivers' ? 'No addition' : '—';
  }

  getTransactionAddedName(transaction: FantasyTransaction): string {
    const asset = this.getTransactionAddedAsset(transaction);
    return asset
      ? this.getTransactionAssetName(asset)
      : this.getTransactionAddedFallback(transaction);
  }

  getTransactionDroppedFallback(transaction: FantasyTransaction): string {
    if (transaction.type === 'active-bench-swap-activated') {
      return 'Previous starter';
    }

    if (
      transaction.type === 'injury-replacement' ||
      transaction.type === 'injury-active-bench-swap' ||
      transaction.type === 'injury-add-drop-active'
    ) {
      return 'Injured starter';
    }

    return ['add-open-slot', 'waiver-award', 'slot-move-activated'].includes(transaction.type)
      ? 'Open slot'
      : '—';
  }

  getTransactionDroppedName(transaction: FantasyTransaction): string {
    const asset = this.getTransactionDroppedAsset(transaction);
    return asset
      ? this.getTransactionAssetName(asset)
      : this.getTransactionDroppedFallback(transaction);
  }

  toggleTransactionHistory(): void {
    this.transactionHistoryExpanded.update((expanded) => !expanded);
  }

  getTransactionAssetMeta(asset: DraftableAsset | RosterAsset | null): string {
    if (!asset) {
      return 'No player';
    }

    return `${this.getRosterAssetTeamLabel(asset)} · ${asset.position}`;
  }

  getTransactionTitle(transaction: FantasyTransaction): string {
    switch (transaction.type) {
      case 'add-open-slot':
        return transaction.sourceRosterArea === 'bench'
          ? `Benched ${this.getTransactionAssetName(transaction.addedAsset)}`
          : `Added ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'move-to-ir':
        return `Moved ${this.getTransactionAssetName(transaction.movedAsset)} to Injured Reserve`;

      case 'activate-from-ir':
        return `Activated ${this.getTransactionAssetName(transaction.activatedAsset)} from Injured Reserve`;

      case 'drop-to-waivers':
        return `Dropped ${this.getTransactionAssetName(transaction.droppedAsset)}`;

      case 'waiver-claim':
        return `Claimed ${this.getTransactionAssetName(transaction.waiverAsset)}`;

      case 'waiver-award':
        return `Won ${this.getTransactionAssetName(transaction.waiverAsset)} on waivers`;

      case 'waiver-cleared':
        return `${this.getTransactionAssetName(transaction.waiverAsset)} cleared waivers`;

      case 'queue-add-drop':
      case 'queue-add-open-slot':
        return `Scheduled ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'queue-waiver-award':
        return `Reserved ${this.getTransactionAssetName(transaction.waiverAsset)} from waivers`;

      case 'slot-move-activated':
        return `Activated ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'queue-active-bench-swap':
        return `Scheduled ${this.getTransactionAssetName(transaction.movedAsset)} to start`;

      case 'active-bench-swap-activated':
        return `Started ${this.getTransactionAssetName(this.getTransactionAddedAsset(transaction))}`;

      case 'injury-replacement':
        return `Replaced injured ${this.getTransactionAssetName(transaction.movedAsset)}`;

      case 'injury-active-bench-swap':
        return `Replaced injured ${this.getTransactionAssetName(transaction.movedAsset)}`;

      case 'injury-add-drop-active':
        return `Added ${this.getTransactionAssetName(transaction.addedAsset)} for an injured starter`;

      case 'move-bench-to-ir':
        return `Moved ${this.getTransactionAssetName(transaction.movedAsset)} from bench to Injured Reserve`;

      case 'activate-ir-to-bench':
        return `Moved ${this.getTransactionAssetName(transaction.activatedAsset)} from Injured Reserve to bench`;

      case 'cancel-queued-move':
        return `Canceled ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'add-drop':
      default:
        return `Added ${this.getTransactionAssetName(transaction.addedAsset)}`;
    }
  }

  getTransactionDetail(transaction: FantasyTransaction): string {
    switch (transaction.type) {
      case 'add-open-slot':
        return transaction.sourceRosterArea === 'bench'
          ? `${this.getTransactionAssetName(transaction.addedAsset)} filled an open flexible bench spot and remains ineligible for active scoring before ${this.getTransactionEffectiveLabel(transaction)}.`
          : `Filled an open active roster slot with ${this.getTransactionAssetName(transaction.addedAsset)}.`;

      case 'move-to-ir':
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved from the active roster to Injured Reserve (IR).`;

      case 'activate-from-ir':
        if (transaction.movedAsset) {
          return transaction.droppedAsset
            ? `${this.getTransactionAssetName(transaction.activatedAsset)} moved from Injured Reserve (IR) to the active roster. ${this.getTransactionAssetName(transaction.movedAsset)} moved to the bench, and ${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers.`
            : `${this.getTransactionAssetName(transaction.activatedAsset)} moved from Injured Reserve (IR) to the active roster. ${this.getTransactionAssetName(transaction.movedAsset)} moved into an open bench spot, so nobody was dropped.`;
        }

        return `${this.getTransactionAssetName(transaction.activatedAsset)} moved from Injured Reserve (IR) back to an open active roster slot.`;

      case 'drop-to-waivers':
        return `${this.getTransactionAssetName(transaction.droppedAsset)} was released from the ${
          transaction.sourceRosterArea === 'ir'
            ? 'Injured Reserve'
            : transaction.sourceRosterArea === 'bench'
              ? 'bench'
              : 'active roster'
        } and placed on waivers.`;

      case 'waiver-claim':
        return 'Waiver claim submitted. Your roster only changes if the claim is awarded.';

      case 'waiver-award':
        return transaction.droppedAsset
          ? `Awarded by waiver priority. Dropped ${this.getTransactionAssetName(transaction.droppedAsset)}.`
          : 'Awarded by waiver priority into an open roster slot.';

      case 'waiver-cleared':
        return 'No claim was awarded, so this player became a normal free agent.';

      case 'queue-add-drop':
        return `${this.getTransactionAssetName(transaction.droppedAsset)} keeps the current six-game count. The incoming player is reserved until that slot begins its next matchup.`;

      case 'queue-add-open-slot':
        return 'The incoming player is reserved and will activate when this active roster slot begins its next matchup.';

      case 'queue-waiver-award':
        return transaction.droppedAsset
          ? `The waiver winner is reserved. ${this.getTransactionAssetName(transaction.droppedAsset)} remains in the current six-game count until the slot begins its next matchup.`
          : 'The waiver winner is reserved until the selected open slot begins its next matchup.';

      case 'slot-move-activated':
        return transaction.droppedAsset
          ? `${this.getTransactionAssetName(transaction.addedAsset)} started the slot’s new six-game count. ${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers.`
          : `${this.getTransactionAssetName(transaction.addedAsset)} started the slot’s new six-game count.`;

      case 'queue-active-bench-swap':
        return `${this.getTransactionAssetName(transaction.movedAsset)} remains on the bench until both roster spots can begin the same fair matchup. ${this.getTransactionAssetName(transaction.droppedAsset)} remains active until then.`;

      case 'active-bench-swap-activated':
        return `${this.getTransactionAssetName(transaction.addedAsset)} began the active slot’s new six-game count. ${this.getTransactionAssetName(transaction.droppedAsset)} moved to the bench.`;

      case 'injury-replacement':
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved to Injured Reserve and kept every already-started game and point. ${this.getTransactionAssetName(transaction.activatedAsset)} receives only the remaining future games in that same six-game slot.`;

      case 'injury-active-bench-swap':
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved to the bench and kept every already-started game and earned point. ${this.getTransactionAssetName(transaction.activatedAsset)} receives only the remaining future games in that same six-game slot.`;

      case 'injury-add-drop-active':
        return `${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers and keeps every already-started game and earned point. ${this.getTransactionAssetName(transaction.addedAsset)} receives only the remaining future games in that same six-game slot.`;

      case 'move-bench-to-ir':
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved from the bench to Injured Reserve (IR) and opened a flexible bench spot.`;

      case 'activate-ir-to-bench':
        return transaction.droppedAsset
          ? `${this.getTransactionAssetName(transaction.activatedAsset)} moved from Injured Reserve (IR) to the bench. ${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers.`
          : `${this.getTransactionAssetName(transaction.activatedAsset)} moved from Injured Reserve (IR) into an open bench spot.`;

      case 'cancel-queued-move':
        return `${this.getTransactionAssetName(transaction.addedAsset)} was released from its reservation before the slot began its next matchup.`;

      case 'add-drop':
      default:
        return transaction.sourceRosterArea === 'bench'
          ? `${this.getTransactionAssetName(transaction.addedAsset)} replaced ${this.getTransactionAssetName(transaction.droppedAsset)} on the bench. The dropped player or goalie unit was placed on waivers.`
          : `Dropped ${this.getTransactionAssetName(transaction.droppedAsset)}.`;
    }
  }

  getTransactionEffectiveLabel(transaction: FantasyTransaction): string {
    const storedLabel =
      transaction.effectiveLabel ||
      (typeof transaction.effectiveCycleNumber === 'number'
        ? `Matchup ${transaction.effectiveCycleNumber}`
        : 'Next matchup');

    return storedLabel.replace(/^Cycle\s+/i, 'Matchup ').replace(/^Next cycle$/i, 'Next matchup');
  }

  getTransactionDateLabel(value: unknown): string {
    const date = this.getDateFromUnknown(value);

    if (!date) {
      return 'Recently';
    }

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  getTransactionDateTime(value: unknown): string | null {
    const date = this.getDateFromUnknown(value);

    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  }

  private async loadPlayerPoolForProjectionFallback(): Promise<void> {
    try {
      this.playerPool.set(
        await loadDraftPlayerPool({
          forceRefresh: true,
          includeCurrentTeamCycle: true,
          requiredGamesPerCycle:
            this.league()?.scoringRules?.requiredGamesPerCycle ??
            defaultScoringRules.requiredGamesPerCycle,
        }),
      );
    } catch (error: unknown) {
      console.warn('Unable to load player pool projection fallback.', error);
    }
  }

  private getRosterOperationFingerprint(): string {
    const roster = this.roster();

    if (!roster) {
      return 'roster:missing';
    }

    const active = roster.activeSlots.map((slot) => [
      slot.slotId,
      this.getRosterAssetKey(slot.asset),
      this.getRosterAssetKey(slot.pendingMove?.incomingAsset),
      slot.pendingMove?.id ?? '',
      slot.pendingMove?.requestedEffectiveCycleNumber ?? null,
      slot.openFromCycleNumber ?? null,
    ]);
    const bench = roster.benchSlots.map((slot) => [
      slot.slotId,
      this.getRosterAssetKey(slot.asset),
    ]);
    const injuredReserve = roster.irSlots.map((slot) => [
      slot.slotId,
      this.getRosterAssetKey(slot.asset),
    ]);

    return JSON.stringify({ active, bench, injuredReserve });
  }

  private getActiveBenchSwapRosterObservation(): ActiveBenchSwapRosterObservation {
    const roster = this.roster();

    return {
      activeSlots: (roster?.activeSlots ?? []).map((slot) => ({
        slotId: slot.slotId,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
        hasPendingMove: Boolean(slot.pendingMove),
      })),
      benchSlots: (roster?.benchSlots ?? []).map((slot) => ({
        slotId: slot.slotId,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
      })),
    };
  }

  private async awaitRosterMutationConfirmation<T>(
    actionPromise: Promise<T>,
    previousRosterFingerprint: string,
    generation: number,
    isExpectedMutationObserved?: () => boolean,
  ): Promise<T | null> {
    let settled = false;
    let rejected = false;
    let settledValue: T | null = null;
    let settledError: unknown;

    // Attach both handlers immediately so a request that finishes after the UI
    // safety deadline can never produce an unhandled rejection.
    void actionPromise.then(
      (value) => {
        settled = true;
        settledValue = value;
      },
      (error: unknown) => {
        settled = true;
        rejected = true;
        settledError = error;
      },
    );

    const confirmationObserved = isExpectedMutationObserved ?? (() =>
      this.getRosterOperationFingerprint() !== previousRosterFingerprint);
    const deadline = Date.now() + 20_000;

    while (this.rosterOperationGeneration === generation && Date.now() <= deadline) {
      if (confirmationObserved()) {
        return settled && !rejected ? settledValue : null;
      }

      if (settled) {
        if (!rejected) {
          return settledValue;
        }

        if (await waitForOperationCondition(confirmationObserved, 2_500, 120)) {
          return null;
        }

        throw settledError;
      }

      await waitForOperationDelay(120);
    }

    if (confirmationObserved()) {
      return settled && !rejected ? settledValue : null;
    }

    if (settled && !rejected) {
      return settledValue;
    }

    if (settled && rejected) {
      throw settledError;
    }

    throw new Error(
      'RinkRat did not receive a final server or live-roster confirmation. The screen has been unlocked so it cannot remain stuck. Check My Team before retrying because the roster move may still finish in the background.',
    );
  }

  private isUncertainRosterOperationMessage(message: string): boolean {
    return /may still finish|may still have saved|check my team before retrying|final server or live-roster confirmation|screen has been unlocked/i.test(
      message,
    );
  }

  private getRosterRemovalObservation(): RosterRemovalObservation {
    const roster = this.roster();

    return {
      activeSlots: (roster?.activeSlots ?? []).map((slot) => ({
        slotId: slot.slotId,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
      })),
      benchSlots: (roster?.benchSlots ?? []).map((slot) => ({
        slotId: slot.slotId,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
      })),
      irSlots: (roster?.irSlots ?? []).map((slot) => ({
        slotId: slot.slotId,
        assetKey: this.getRosterAssetKey(slot.asset) || null,
      })),
    };
  }

  private isRosterRemovalConfirmed(expectation: RosterRemovalExpectation): boolean {
    return isRosterRemovalObserved(expectation, this.getRosterRemovalObservation());
  }

  private async waitForRosterRemovalObservation(
    expectation: RosterRemovalExpectation,
    timeoutMs: number,
    generation: number,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (this.rosterOperationGeneration === generation && Date.now() <= deadline) {
      if (this.isRosterRemovalConfirmed(expectation)) {
        return true;
      }

      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 120);
      });
    }

    return this.isRosterRemovalConfirmed(expectation);
  }

  private async awaitRosterRemovalConfirmation(
    actionPromise: Promise<unknown>,
    expectation: RosterRemovalExpectation,
    generation: number,
  ): Promise<void> {
    let settled = false;
    let rejected = false;
    let settledError: unknown;

    void actionPromise.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        rejected = true;
        settledError = error;
      },
    );

    const deadline = Date.now() + 20_000;

    while (this.rosterOperationGeneration === generation && Date.now() <= deadline) {
      if (this.isRosterRemovalConfirmed(expectation)) {
        return;
      }

      if (settled) {
        if (!rejected) {
          return;
        }

        if (await this.waitForRosterRemovalObservation(expectation, 2_500, generation)) {
          return;
        }

        throw settledError;
      }

      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 120);
      });
    }

    if (this.isRosterRemovalConfirmed(expectation)) {
      return;
    }

    if (settled && !rejected) {
      return;
    }

    if (settled && rejected) {
      throw settledError;
    }

    throw new Error(
      'RinkRat did not receive a final server or live-roster confirmation. The page has been unlocked so it cannot remain stuck. Check My Team before retrying because the drop may still finish in the background.',
    );
  }

  private getRosterAssetKey(asset: unknown): string {
    const rosterAsset = asset as {
      assetType?: string;
      assetKey?: string;
      player?: unknown;
      teamAbbreviation?: string;
    } | null;

    if (!rosterAsset) {
      return '';
    }

    if (rosterAsset.assetKey) {
      return rosterAsset.assetKey;
    }

    if (rosterAsset.assetType === 'skater') {
      const playerId = this.getPlayerId(rosterAsset.player);

      return playerId !== null ? `skater-${playerId}` : '';
    }

    return rosterAsset.teamAbbreviation ? `goalie-unit-${rosterAsset.teamAbbreviation}` : '';
  }

  private getActiveSlotsForIrAsset(asset: SkaterRosterAsset): ActiveRosterSlot[] {
    return (
      this.roster()?.activeSlots.filter(
        (slot) => slot.position === asset.position && !slot.pendingMove,
      ) ?? []
    );
  }

  private getProjectionWindowStartDate(): Date | null {
    const historicalTestDate = getHistoricalScoringTestDate();

    if (historicalTestDate) {
      return historicalTestDate;
    }

    const cycle = this.latestCycle();

    return this.getDateFromUnknown(cycle?.startedAt);
  }

  private getDateFromUnknown(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'object' && value !== null && 'toDate' in value) {
      const timestampLike = value as {
        toDate?: () => Date;
      };

      if (typeof timestampLike.toDate === 'function') {
        return timestampLike.toDate();
      }
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsedDate = new Date(value);

      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return null;
  }

  private getNhlSeasonForDate(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    const seasonStartYear = month >= 7 ? year : year - 1;

    return `${seasonStartYear}${seasonStartYear + 1}`;
  }

  private getPlayerId(player: unknown): number | string | null {
    const playerRecord = player as {
      id?: number | string;
      playerId?: number | string;
      nhlPlayerId?: number | string;
    } | null;

    return playerRecord?.id ?? playerRecord?.playerId ?? playerRecord?.nhlPlayerId ?? null;
  }

  getTeamProfileIconId(ownerId: string | null | undefined): string {
    const team = ownerId ? this.teams().find((candidate) => candidate.ownerId === ownerId) : null;
    return getFantasyTeamProfileIconId(team);
  }

  getTeamManagerLabel(ownerId: string | null | undefined): string {
    const team = ownerId ? this.teams().find((candidate) => candidate.ownerId === ownerId) : null;
    return team?.managerName?.trim() || team?.teamName?.trim() || 'Manager';
  }
}
