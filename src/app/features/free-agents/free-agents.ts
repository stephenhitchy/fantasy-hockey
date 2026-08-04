import { Component, computed, HostListener, OnDestroy, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../core/firebase';

import {
  DraftableAsset,
  DraftPosition,
  FantasyDraft,
  ProjectionCycleGameMarker,
  ProjectionStatBreakdownItem,
} from '../../core/draft/draft.models';

import {
  addDropRosterAsset,
  addFreeAgentToOpenRosterSlot,
  cancelQueuedRosterMove,
  FantasyWaiver,
  FantasyWaiverClaimMoveType,
  listenToFantasyDraft,
  listenToLeagueWaivers,
  placeWaiverClaim,
  processWaiver,
} from '../../core/draft/draft.service';

import { loadSharedProjectionSnapshot } from '../../core/projection/projection-snapshot.service';

import { PlayerAvailability } from '../../core/player/player-availability.models';

import {
  getPlayerAvailabilityForPlayer,
  getPlayerAvailabilityStatusClass,
  shouldDisplayPlayerAvailability,
} from '../../core/player/player-availability.service';

import {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyTeamCycleWindows,
} from '../../core/cycle/cycle.models';

import { listenToLeagueCycles } from '../../core/cycle/cycle.service';

import { listenToCycleTeamWindows } from '../../core/cycle/asset-cycle-window.service';

import { getLeagueById, League } from '../../core/league/league.service';

import { FantasyTeam, listenToLeagueTeams } from '../../core/team/team.service';

import { ActiveRosterSlot, BenchRosterSlot, FantasyRoster, RosterAsset } from '../../core/team/roster.models';

import { listenToFantasyRoster } from '../../core/team/roster.service';

import { defaultScoringRules } from '../../core/scoring/scoring-rules';

import {
  resolveRosterMoveAssetCycleEligibility,
  RosterMoveAssetCycleEligibility,
} from '../../core/transactions/roster-move-eligibility.service';

import { ActionSheet } from '../../shared/action-sheet/action-sheet';
import {
  parseFreeAgentMobileViewState,
  resolveFreeAgentRoutePreferences,
  resolvePreferredRosterCandidate,
  type FreeAgentMobileViewState,
  type FreeAgentPoolTab,
} from './free-agent-mobile-flow.util';

type FreeAgentPositionFilter = 'ALL' | DraftPosition;
type FreeAgentSortMode =
  | 'NEXT_CYCLE'
  | 'SEASON_POINTS'
  | 'REST_OF_SEASON'
  | 'FINAL_OUTLOOK'
  | 'PERFORMANCE'
  | 'RELIABILITY';
type FreeAgentFlowStep = 'player-pool' | 'roster-slot';

interface DropCandidate {
  slotId: string;
  slotNumber: number;
  position: DraftPosition;
  asset: RosterAsset | null;
  moveType: 'open-slot' | 'drop';
  rosterArea: 'active' | 'bench';
  currentWindow: FantasyAssetCycleWindow | null;
  slotNextCycleNumber: number;
  effectiveCycleNumber: number;
  currentWindowUntouched: boolean;
  canApplyImmediately: boolean;
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

@Component({
  selector: 'app-free-agents',
  imports: [FormsModule, RouterLink, ActionSheet],
  templateUrl: './free-agents.html',
  styleUrl: './free-agents.css',
})
export class FreeAgents implements OnDestroy {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  draft = signal<FantasyDraft | null>(null);
  teams = signal<FantasyTeam[]>([]);
  rosters = signal<Record<string, FantasyRoster | null>>({});
  latestCycle = signal<FantasyCycle | null>(null);
  leagueCycles = signal<FantasyCycle[]>([]);
  myTeamWindowsByCycle = signal<Record<number, FantasyTeamCycleWindows | null>>({});
  teamWindowLoadedByCycle = signal<Record<number, boolean>>({});
  waivers = signal<FantasyWaiver[]>([]);
  playerPool = signal<DraftableAsset[]>([]);

  loading = signal(true);
  playerPoolLoading = signal(false);
  moving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');

  searchTerm = signal('');
  positionFilter = signal<FreeAgentPositionFilter>('ALL');
  sortMode = signal<FreeAgentSortMode>('NEXT_CYCLE');
  poolTab = signal<FreeAgentPoolTab>('available');
  preferredSlotId = signal('');
  preferredRosterArea = signal<'active' | 'bench' | ''>('');
  playerPoolScrollY = signal(0);

  selectedAddAssetKey = signal('');
  selectedWaiverId = signal('');
  selectedDropSlotId = signal('');
  flowStep = signal<FreeAgentFlowStep>('player-pool');
  selectedAssetEligibility = signal<RosterMoveAssetCycleEligibility | null>(null);
  eligibilityLoading = signal(false);
  eligibilityError = signal('');

  readonly positionFilters: FreeAgentPositionFilter[] = ['ALL', 'LW', 'C', 'RW', 'D', 'G'];
  readonly cycleDotSlots = [0, 1, 2, 3, 4, 5];
  readonly sortOptions: Array<{ value: FreeAgentSortMode; label: string }> = [
    { value: 'NEXT_CYCLE', label: 'Next 6 Games Projection' },
    { value: 'SEASON_POINTS', label: 'Season Points' },
    { value: 'REST_OF_SEASON', label: 'Rest-of-Season Estimate' },
    { value: 'FINAL_OUTLOOK', label: 'Estimated Final Total' },
    { value: 'PERFORMANCE', label: 'Ahead of Projection' },
    { value: 'RELIABILITY', label: 'Projection Reliability' },
  ];

  private stopDraftListener: (() => void) | null = null;
  private stopTeamsListener: (() => void) | null = null;
  private stopLeagueCyclesListener: (() => void) | null = null;
  private stopWaiversListener: (() => void) | null = null;
  private rosterListeners: Record<string, () => void> = {};
  private teamWindowListeners: Record<number, () => void> = {};
  private eligibilityRequestKey = '';
  private restoredEligibilityKey = '';
  private hasReceivedWaivers = false;
  private viewStateRestored = false;
  private focusPendingMovesRequested = false;

  readonly selectedAddAsset = computed(
    () =>
      this.playerPool().find((asset) => asset.assetKey === this.selectedAddAssetKey()) ??
      this.waivers().find((waiver) => waiver.asset.assetKey === this.selectedAddAssetKey())
        ?.asset ??
      null,
  );

  readonly selectedWaiver = computed(() => {
    const waiverId = this.selectedWaiverId();

    if (!waiverId) {
      return null;
    }

    return (
      this.waivers().find((waiver) => waiver.id === waiverId && waiver.status === 'active') ?? null
    );
  });

  readonly myRoster = computed(() => this.rosters()[this.userId] ?? null);

  readonly pendingRosterMoves = computed(() =>
    (this.myRoster()?.activeSlots ?? [])
      .filter((slot) => Boolean(slot.pendingMove))
      .map((slot) => ({
        slot,
        move: slot.pendingMove!,
      })),
  );

  readonly rosteredAssetKeys = computed(() => {
    const assetKeys = new Set<string>();

    (Object.values(this.rosters()) as Array<FantasyRoster | null>).forEach((roster) => {
      roster?.activeSlots.forEach((slot) => {
        const assetKey = this.getRosterAssetKey(slot.asset);
        const pendingAssetKey = this.getRosterAssetKey(slot.pendingMove?.incomingAsset ?? null);

        if (assetKey) {
          assetKeys.add(assetKey);
        }

        if (pendingAssetKey) {
          assetKeys.add(pendingAssetKey);
        }
      });

      roster?.benchSlots.forEach((slot) => {
        const assetKey = this.getRosterAssetKey(slot.asset);

        if (assetKey) {
          assetKeys.add(assetKey);
        }
      });

      roster?.irSlots.forEach((slot) => {
        const assetKey = this.getRosterAssetKey(slot.asset);

        if (assetKey) {
          assetKeys.add(assetKey);
        }
      });
    });

    return assetKeys;
  });

  readonly activeWaiverAssetKeys = computed(() => {
    const assetKeys = new Set<string>();

    this.waivers()
      .filter((waiver) => waiver.status === 'active')
      .forEach((waiver) => assetKeys.add(waiver.assetKey));

    return assetKeys;
  });

  readonly availableWaivers = computed(() => {
    const search = this.searchTerm().trim().toLowerCase();
    const positionFilter = this.positionFilter();

    return this.waivers()
      .filter((waiver) => waiver.status === 'active')
      .filter((waiver) => positionFilter === 'ALL' || waiver.asset.position === positionFilter)
      .filter((waiver) => {
        if (!search) {
          return true;
        }

        return [
          this.getAssetName(waiver.asset),
          this.getAssetTeamLabel(waiver.asset),
          waiver.asset.position,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
      .sort((first, second) => {
        const firstClaims = first.claims?.length ?? 0;
        const secondClaims = second.claims?.length ?? 0;

        if (secondClaims !== firstClaims) {
          return secondClaims - firstClaims;
        }

        return this.getAssetName(first.asset).localeCompare(this.getAssetName(second.asset));
      });
  });

  readonly availableAssets = computed(() => {
    const search = this.searchTerm().trim().toLowerCase();
    const positionFilter = this.positionFilter();
    const rosteredAssetKeys = this.rosteredAssetKeys();
    const activeWaiverAssetKeys = this.activeWaiverAssetKeys();

    return this.playerPool()
      .filter((asset) => !rosteredAssetKeys.has(asset.assetKey))
      .filter((asset) => !activeWaiverAssetKeys.has(asset.assetKey))
      .filter((asset) => positionFilter === 'ALL' || asset.position === positionFilter)
      .filter((asset) => {
        if (!search) {
          return true;
        }

        return [this.getAssetName(asset), this.getAssetTeamLabel(asset), asset.position]
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
      .sort((first, second) => this.compareAvailableAssets(first, second));
  });

  readonly dropCandidates = computed((): DropCandidate[] => {
    const addAsset = this.selectedAddAsset();
    const roster = this.myRoster();
    const eligibility = this.selectedAssetEligibility();

    if (!addAsset || !roster) {
      return [];
    }

    const buildActiveCandidate = (
      slot: ActiveRosterSlot,
      asset: RosterAsset | null,
      moveType: DropCandidate['moveType'],
    ): DropCandidate => {
      const currentWindow = this.getLatestWindowForSlot(slot.slotId);
      const activeCycleNumbers = new Set(
        this.leagueCycles()
          .filter((cycle) => cycle.status === 'active')
          .map((cycle) => cycle.cycleNumber),
      );
      const openFromCurrentCycle =
        !currentWindow &&
        slot.asset === null &&
        typeof slot.openFromCycleNumber === 'number' &&
        activeCycleNumbers.has(slot.openFromCycleNumber);
      const currentWindowUntouched =
        this.isWindowUntouched(currentWindow) ||
        openFromCurrentCycle ||
        (!currentWindow && this.isAwaitingInitialWindowSync());
      const slotNextCycleNumber = openFromCurrentCycle
        ? slot.openFromCycleNumber!
        : this.getSlotNextCycleNumber(currentWindow);
      const effectiveCycleNumber = Math.max(
        slotNextCycleNumber,
        eligibility?.earliestEligibleCycleNumber ?? slotNextCycleNumber,
      );
      const canApplyImmediately = Boolean(
        currentWindowUntouched &&
        effectiveCycleNumber === slotNextCycleNumber,
      );

      return {
        slotId: slot.slotId,
        slotNumber: slot.slotNumber,
        position: slot.position,
        asset,
        moveType,
        rosterArea: 'active',
        currentWindow,
        slotNextCycleNumber,
        effectiveCycleNumber,
        currentWindowUntouched,
        canApplyImmediately,
      };
    };

    const buildBenchCandidate = (
      slot: BenchRosterSlot,
      asset: RosterAsset | null,
      moveType: DropCandidate['moveType'],
    ): DropCandidate => {
      const eligibleCycle = eligibility?.earliestEligibleCycleNumber ?? 1;

      return {
        slotId: slot.slotId,
        slotNumber: slot.slotNumber,
        position: addAsset.position,
        asset,
        moveType,
        rosterArea: 'bench',
        currentWindow: null,
        slotNextCycleNumber: eligibleCycle,
        effectiveCycleNumber: eligibleCycle,
        currentWindowUntouched: false,
        canApplyImmediately: false,
      };
    };

    const openActiveCandidates = roster.activeSlots
      .filter(
        (slot) => slot.position === addAsset.position && slot.asset === null && !slot.pendingMove,
      )
      .map((slot) => buildActiveCandidate(slot, null, 'open-slot'));

    const activeDropCandidates = roster.activeSlots
      .filter(
        (slot): slot is ActiveRosterSlot & { asset: RosterAsset } =>
          slot.position === addAsset.position && slot.asset !== null && !slot.pendingMove,
      )
      .map((slot) => buildActiveCandidate(slot, slot.asset, 'drop'));

    const openBenchCandidates = roster.benchSlots
      .filter((slot) => slot.asset === null)
      .map((slot) => buildBenchCandidate(slot, null, 'open-slot'));

    const benchDropCandidates = roster.benchSlots
      .filter(
        (slot): slot is BenchRosterSlot & { asset: RosterAsset } =>
          slot.asset !== null && !this.isBenchCandidateReservedForActiveSwap(slot),
      )
      .map((slot) => buildBenchCandidate(slot, slot.asset, 'drop'));

    return [
      ...openActiveCandidates,
      ...openBenchCandidates,
      ...activeDropCandidates,
      ...benchDropCandidates,
    ];
  });

  readonly selectedDropCandidate = computed(() => {
    const selectedSlotId = this.selectedDropSlotId();

    if (!selectedSlotId) {
      return null;
    }

    return this.dropCandidates().find((candidate) => candidate.slotId === selectedSlotId) ?? null;
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    this.loadPage();
  }

  ngOnDestroy(): void {
    this.persistFreeAgentViewState();
    this.stopDraftListener?.();
    this.stopTeamsListener?.();
    this.stopLeagueCyclesListener?.();
    this.stopWaiversListener?.();
    this.clearRosterListeners();
    this.clearTeamWindowListeners();
  }

  canLeaveRosterPage(): boolean {
    return !this.isRosterOperationPending();
  }

  @HostListener('window:beforeunload', ['$event'])
  protectPendingRosterOperation(event: BeforeUnloadEvent): void {
    if (!this.isRosterOperationPending()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  }

  isRosterOperationPending(): boolean {
    return this.moving();
  }

  async loadPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;
    this.restoreFreeAgentViewState();
    const routePreferences = this.applyRoutePreferences();
    this.focusPendingMovesRequested = routePreferences.focusPendingMoves;

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);

      this.stopDraftListener = listenToFantasyDraft(leagueId, (draft) => {
        this.draft.set(draft);
      });

      this.stopLeagueCyclesListener = listenToLeagueCycles(leagueId, (cycles) => {
        this.leagueCycles.set(cycles);
        this.latestCycle.set(cycles.at(-1) ?? null);
        this.refreshTeamWindowListeners(cycles);
        this.selectPreferredDropCandidateIfAvailable();
      });

      this.stopWaiversListener = listenToLeagueWaivers(leagueId, (waivers) => {
        this.hasReceivedWaivers = true;
        this.waivers.set(waivers);
        this.resumeRestoredSelectionIfAvailable();
      });

      this.stopTeamsListener = listenToLeagueTeams(leagueId, (teams) => {
        this.teams.set(teams);
        this.refreshRosterListeners(teams);
      });

      await this.loadPlayerPool();
    } catch (error: unknown) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to load free agents.');
    } finally {
      this.loading.set(false);
      this.focusPendingMovesAfterRender();
    }
  }

  async loadPlayerPool(): Promise<void> {
    this.playerPoolLoading.set(true);
    this.errorMessage.set('');

    try {
      const snapshot = await loadSharedProjectionSnapshot(this.leagueId);

      if (!snapshot) {
        this.playerPool.set([]);
        throw new Error(
          'Shared projections are not ready. The commissioner must refresh them in Projection Lab.',
        );
      }

      this.playerPool.set(snapshot.assets);
      this.resumeRestoredSelectionIfAvailable();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load the shared free agent pool.',
      );
    } finally {
      this.playerPoolLoading.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
    this.persistFreeAgentViewState();
  }

  setPositionFilter(value: string): void {
    const validFilters: FreeAgentPositionFilter[] = ['ALL', 'LW', 'C', 'RW', 'D', 'G'];

    if (validFilters.includes(value as FreeAgentPositionFilter)) {
      this.positionFilter.set(value as FreeAgentPositionFilter);
      this.persistFreeAgentViewState();
    }
  }


  setSortMode(value: string): void {
    const validModes = this.sortOptions.map((option) => option.value);

    if (validModes.includes(value as FreeAgentSortMode)) {
      this.sortMode.set(value as FreeAgentSortMode);
      this.persistFreeAgentViewState();
    }
  }

  setPoolTab(tab: FreeAgentPoolTab): void {
    if (tab === this.poolTab()) {
      return;
    }

    this.poolTab.set(tab);
    this.persistFreeAgentViewState();
  }

  getPoolTabCount(tab: FreeAgentPoolTab): number {
    return tab === 'available' ? this.availableAssets().length : this.availableWaivers().length;
  }

  selectAddAsset(asset: DraftableAsset): void {
    this.capturePlayerPoolScroll();
    this.successMessage.set('');
    this.errorMessage.set('');
    this.selectedAddAssetKey.set(asset.assetKey);
    this.selectedWaiverId.set('');
    this.selectedDropSlotId.set('');
    this.flowStep.set('roster-slot');

    if (this.positionFilter() === 'ALL') {
      this.positionFilter.set(asset.position);
    }

    this.persistFreeAgentViewState();
    void this.loadSelectedAssetEligibility(asset);
  }

  selectWaiver(waiver: FantasyWaiver): void {
    this.capturePlayerPoolScroll();
    this.successMessage.set('');
    this.errorMessage.set('');
    this.selectedAddAssetKey.set(waiver.asset.assetKey);
    this.selectedWaiverId.set(waiver.id);
    this.selectedDropSlotId.set('');
    this.flowStep.set('roster-slot');

    if (this.positionFilter() === 'ALL') {
      this.positionFilter.set(waiver.asset.position);
    }

    this.persistFreeAgentViewState();
    void this.loadSelectedAssetEligibility(waiver.asset);
  }

  returnToPlayerPool(): void {
    if (this.moving()) {
      return;
    }

    this.flowStep.set('player-pool');
    this.selectedAddAssetKey.set('');
    this.selectedWaiverId.set('');
    this.selectedDropSlotId.set('');
    this.selectedAssetEligibility.set(null);
    this.eligibilityError.set('');
    this.restoredEligibilityKey = '';
    this.persistFreeAgentViewState();
    this.restorePlayerPoolScroll();
  }

  async retryEligibilityCheck(): Promise<void> {
    const asset = this.selectedAddAsset();

    if (!asset) {
      return;
    }

    await this.loadSelectedAssetEligibility(asset, true);
  }

  selectDropCandidate(candidate: DropCandidate): void {
    this.selectedDropSlotId.set(candidate.slotId);
    this.persistFreeAgentViewState();
  }

  canConfirmMove(): boolean {
    return Boolean(
      this.selectedAddAsset() &&
      this.selectedDropCandidate() &&
      this.selectedAssetEligibility() &&
      !this.eligibilityLoading() &&
      this.areRosterWindowsReady() &&
      this.draft()?.status === 'complete',
    );
  }

  async confirmAddDrop(): Promise<void> {
    const addAsset = this.selectedAddAsset();

    this.successMessage.set('');
    this.errorMessage.set('');

    if (!addAsset || !this.selectedDropCandidate()) {
      this.errorMessage.set('Choose a player and an eligible active or bench roster spot.');
      return;
    }

    if (!this.areRosterWindowsReady()) {
      this.errorMessage.set(
        'Your current six-game roster progress is still loading. Try again in a moment.',
      );
      return;
    }

    this.moving.set(true);

    try {
      await this.loadSelectedAssetEligibility(addAsset, true);

      const dropCandidate = this.selectedDropCandidate();
      const waiver = this.selectedWaiver();

      if (!dropCandidate) {
        throw new Error('The selected roster slot is no longer available.');
      }

      if (addAsset.position !== dropCandidate.position) {
        throw new Error('Active roster moves must use the same position. Bench slots accept any position.');
      }

      if (!this.selectedAssetEligibility()) {
        throw new Error(this.eligibilityError() || 'Unable to verify the player’s current six-game status.');
      }

      const effectiveCycleNumber = dropCandidate.effectiveCycleNumber;
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const leagueOwnerIds = this.teams().map((team) => team.ownerId);

      if (waiver) {
        const moveType: FantasyWaiverClaimMoveType = dropCandidate.moveType;

        await placeWaiverClaim({
          leagueId: this.leagueId,
          ownerId: this.userId,
          waiverId: waiver.id,
          moveType,
          dropSlotId: moveType === 'drop' ? dropCandidate.slotId : null,
          targetSlotId: moveType === 'open-slot' ? dropCandidate.slotId : null,
          effectiveCycleNumber,
          effectiveLabel,
        });

        this.successMessage.set(
          `Claim submitted for ${this.getAssetName(addAsset)}. If awarded, the player is reserved for this slot and cannot activate before Matchup ${effectiveCycleNumber}.`,
        );
      } else if (dropCandidate.moveType === 'open-slot') {
        const execution = await addFreeAgentToOpenRosterSlot({
          leagueId: this.leagueId,
          ownerId: this.userId,
          targetSlotId: dropCandidate.slotId,
          addAsset,
          effectiveCycleNumber,
          effectiveLabel,
          leagueOwnerIds,
          preferImmediateCurrentCycle: dropCandidate.canApplyImmediately,
        });

        this.successMessage.set(dropCandidate.rosterArea === 'bench'
          ? `Added ${this.getAssetName(addAsset)} to ${dropCandidate.slotId}. The player is owned immediately but cannot enter an active scoring slot before Matchup ${effectiveCycleNumber}.`
          : execution.mode === 'immediate'
            ? `Added ${this.getAssetName(addAsset)} to ${dropCandidate.slotId} immediately. The slot was untouched and the incoming NHL-team block had not started, so the player is active in Matchup ${execution.effectiveCycleNumber}.`
            : this.hasStartedCycleWindows()
              ? `Scheduled ${this.getAssetName(addAsset)} for ${dropCandidate.slotId}. The player is reserved and will activate in Matchup ${effectiveCycleNumber}.`
              : `Added ${this.getAssetName(addAsset)} into the open ${addAsset.position} slot.`);
      } else {
        if (!dropCandidate.asset) {
          throw new Error('The selected drop option is missing a roster player or goalie unit.');
        }

        const execution = await addDropRosterAsset({
          leagueId: this.leagueId,
          ownerId: this.userId,
          dropSlotId: dropCandidate.slotId,
          addAsset,
          effectiveCycleNumber,
          effectiveLabel,
          leagueOwnerIds,
          preferImmediateCurrentCycle: dropCandidate.canApplyImmediately,
        });

        this.successMessage.set(dropCandidate.rosterArea === 'bench'
          ? `Added ${this.getAssetName(addAsset)} to ${dropCandidate.slotId} and placed ${this.getRosterAssetName(dropCandidate.asset)} on waivers. The incoming player cannot enter an active scoring slot before Matchup ${effectiveCycleNumber}.`
          : execution.mode === 'immediate'
            ? `Added ${this.getAssetName(addAsset)} and dropped ${this.getRosterAssetName(dropCandidate.asset)} immediately. Both six-game counts were untouched, so the change applies to Matchup ${execution.effectiveCycleNumber}.`
            : this.hasStartedCycleWindows()
              ? `Scheduled ${this.getAssetName(addAsset)} for ${dropCandidate.slotId}. ${this.getRosterAssetName(dropCandidate.asset)} keeps the started six-game count, and the move activates in Matchup ${effectiveCycleNumber}.`
              : `Added ${this.getAssetName(addAsset)} and dropped ${this.getRosterAssetName(dropCandidate.asset)}.`);
      }

      this.selectedAddAssetKey.set('');
      this.selectedWaiverId.set('');
      this.selectedDropSlotId.set('');
      this.selectedAssetEligibility.set(null);
      this.flowStep.set('player-pool');
      this.preferredSlotId.set('');
      this.preferredRosterArea.set('');
      this.restoredEligibilityKey = '';
      this.persistFreeAgentViewState();
      this.restorePlayerPoolScroll();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to complete this roster move.',
      );
    } finally {
      this.moving.set(false);
    }
  }

  async processLeagueWaiver(waiver: FantasyWaiver): Promise<void> {
    this.successMessage.set('');
    this.errorMessage.set('');
    this.moving.set(true);

    try {
      const eligibility = await resolveRosterMoveAssetCycleEligibility(
        waiver.asset,
        this.getRequiredGamesPerCycle(),
        { forceRefresh: true },
      );
      const effectiveCycleNumber = Math.max(
        this.getFallbackNextCycleNumber(),
        eligibility.earliestEligibleCycleNumber,
      );
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;

      await processWaiver({
        leagueId: this.leagueId,
        commissionerId: this.userId,
        waiverId: waiver.id,
        leagueTeams: this.teams(),
        effectiveCycleNumber,
        effectiveLabel,
      });

      const claimCount = waiver.claims?.length ?? 0;

      this.successMessage.set(
        claimCount > 0
          ? this.hasStartedCycleWindows()
            ? `Processed waivers for ${this.getAssetName(waiver.asset)}. The winner is reserved for the selected slot and will activate when that slot starts its next matchup.`
            : `Processed waivers for ${this.getAssetName(waiver.asset)}. The winning team was awarded the player and waiver priority was updated.`
          : `${this.getAssetName(waiver.asset)} cleared waivers and is now a normal free agent.`,
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to process that waiver.',
      );
    } finally {
      this.moving.set(false);
    }
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

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.fullName : `${asset.teamName} Goalie Unit`;
  }

  getAssetTeamLabel(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  getAssetLogoUrl(asset: DraftableAsset): string | undefined {
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
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

  isPlayerAvailabilitySuspended(asset: DraftableAsset): boolean {
    return this.getPlayerAvailability(asset)?.status === 'suspended';
  }

  getPlayerAvailabilityIcon(asset: DraftableAsset): string {
    return this.isPlayerAvailabilitySuspended(asset) ? '⛔' : '✚';
  }

  getPlayerAvailabilityTooltip(asset: DraftableAsset): string {
    const availability = this.getPlayerAvailability(asset);

    if (!availability) {
      return '';
    }

    return availability.note?.trim()
      ? `${availability.label}: ${availability.note.trim()}`
      : availability.label;
  }

  getPlayerAvailabilityNote(asset: DraftableAsset): string {
    return this.getPlayerAvailability(asset)?.note ?? '';
  }

  isPlayerAvailabilityIrEligible(asset: DraftableAsset): boolean {
    return this.getPlayerAvailability(asset)?.irEligible ?? false;
  }

  getRosterAssetName(asset: RosterAsset): string {
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

  getRosterAssetTeamLabel(asset: RosterAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  getRosterAssetLogoUrl(asset: RosterAsset): string | undefined {
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  }

  getDisplayNumber(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getProjectionAsset(asset: DraftableAsset): DraftableAsset {
    return this.playerPool().find((poolAsset) => poolAsset.assetKey === asset.assetKey) ?? asset;
  }

  getDropCandidateProjectionAsset(candidate: DropCandidate | null): DraftableAsset | null {
    const assetKey = this.getRosterAssetKey(candidate?.asset ?? null);

    if (!assetKey) {
      return null;
    }

    return this.playerPool().find((asset) => asset.assetKey === assetKey) ?? null;
  }

  getSelectedOutgoingProjectionAsset(): DraftableAsset | null {
    return this.getDropCandidateProjectionAsset(this.selectedDropCandidate());
  }

  getMoveProjectionDeltaLabel(metric: 'NEXT_CYCLE' | 'REST_OF_SEASON'): string {
    const incoming = this.selectedAddAsset();
    const outgoing = this.getSelectedOutgoingProjectionAsset();

    if (!incoming) {
      return 'Select an incoming player to compare the move.';
    }

    if (!outgoing) {
      return 'Open slot — no outgoing player projection is removed.';
    }

    const incomingProjection = this.getProjectionAsset(incoming);
    const outgoingProjection = this.getProjectionAsset(outgoing);
    const incomingValue = metric === 'NEXT_CYCLE'
      ? incomingProjection.projectedCyclePoints
      : incomingProjection.projectedRestOfSeasonPoints;
    const outgoingValue = metric === 'NEXT_CYCLE'
      ? outgoingProjection.projectedCyclePoints
      : outgoingProjection.projectedRestOfSeasonPoints;

    if (typeof incomingValue !== 'number' || typeof outgoingValue !== 'number') {
      return metric === 'NEXT_CYCLE'
        ? 'Next-matchup comparison unavailable'
        : 'Rest-of-season comparison unavailable';
    }

    const difference = incomingValue - outgoingValue;
    const direction = difference >= 0 ? 'Gain' : 'Lose';

    return `${direction} ${Math.abs(difference).toFixed(1)} projected ${
      metric === 'NEXT_CYCLE' ? 'next-six-games' : 'rest-of-season'
    } points`;
  }

  getRecentFormAdjustment(asset: DraftableAsset): number | null {
    const projectionAsset = this.getProjectionAsset(asset);

    return projectionAsset.recentFormAdjustment ?? null;
  }

  getRecentFormLabel(asset: DraftableAsset): string {
    const adjustment = this.getRecentFormAdjustment(asset);

    if (typeof adjustment !== 'number') {
      return 'Form —';
    }

    const prefix = adjustment > 0 ? '+' : '';

    return `Form ${prefix}${adjustment.toFixed(1)}`;
  }

  getRecentFormClass(asset: DraftableAsset): string {
    const adjustment = this.getRecentFormAdjustment(asset);

    if (typeof adjustment !== 'number' || Math.abs(adjustment) < 0.05) {
      return 'form-neutral';
    }

    return adjustment > 0 ? 'form-positive' : 'form-negative';
  }

  getProjectedCyclePoints(asset: DraftableAsset): number | null {
    return this.getProjectionAsset(asset).projectedCyclePoints ?? null;
  }

  getCycleRank(asset: DraftableAsset): number | null {
    return this.getProjectionAsset(asset).cycleRank ?? null;
  }

  getDraftRank(asset: DraftableAsset): number | null {
    return (
      this.getProjectionAsset(asset).draftRank ??
      this.getProjectionAsset(asset).balancedRank ??
      null
    );
  }


  getCurrentTeamCycleNumber(asset: DraftableAsset): number | null {
    const projectionAsset = this.getProjectionAsset(asset);

    return (
      projectionAsset.currentTeamCycleNumber ??
      projectionAsset.targetProjectionCycleNumber ??
      null
    );
  }

  getCurrentCycleMarker(
    asset: DraftableAsset,
    index: number,
  ): ProjectionCycleGameMarker | null {
    return this.getProjectionAsset(asset).currentTeamCycleGames?.[index] ?? null;
  }

  getCycleMarkerClass(marker: ProjectionCycleGameMarker | null): string {
    if (!marker) {
      return 'cycle-marker-unavailable';
    }

    return `cycle-marker-${marker.status}`;
  }

  getCycleMarkerTooltip(
    marker: ProjectionCycleGameMarker | null,
    index: number,
  ): string {
    if (!marker) {
      return `Game ${index + 1}: refresh shared projections for live six-game status.`;
    }

    const venue = marker.venue === 'home' ? 'vs' : '@';
    const status =
      marker.status === 'played'
        ? 'played and counted'
        : marker.status === 'missed'
          ? 'team played; player missed'
          : 'upcoming';

    return `Game ${index + 1}: ${marker.gameDate} ${venue} ${marker.opponentAbbreviation} — ${status}.`;
  }

  getCycleProgressLabel(asset: DraftableAsset): string {
    const markers = this.getProjectionAsset(asset).currentTeamCycleGames ?? [];

    if (markers.length === 0) {
      return 'Six-game schedule refresh needed';
    }

    const played = markers.filter((marker) => marker.status === 'played').length;
    const missed = markers.filter((marker) => marker.status === 'missed').length;
    const upcoming = markers.filter((marker) => marker.status === 'upcoming').length;

    return `${played} played · ${missed} missed · ${upcoming} upcoming`;
  }

  getCurrentSeasonPoints(asset: DraftableAsset): number | null {
    return this.getProjectionAsset(asset).currentSeasonFantasyPoints ?? null;
  }

  getRestOfSeasonProjection(asset: DraftableAsset): number | null {
    return this.getProjectionAsset(asset).projectedRestOfSeasonPoints ?? null;
  }

  getProjectedFinalSeasonPoints(asset: DraftableAsset): number | null {
    return this.getProjectionAsset(asset).projectedFinalSeasonPoints ?? null;
  }

  getSeasonGamesLabel(asset: DraftableAsset): string {
    const projectionAsset = this.getProjectionAsset(asset);
    const appearances = projectionAsset.projectionGamesPlayed;
    const teamGames = projectionAsset.seasonTeamGamesPlayed;
    const remaining = projectionAsset.seasonGamesRemaining;

    if (typeof teamGames !== 'number' && typeof appearances !== 'number') {
      return 'Season sample unavailable';
    }

    const pieces: string[] = [];

    if (typeof appearances === 'number') {
      pieces.push(`${appearances} appearances`);
    }

    if (typeof teamGames === 'number') {
      pieces.push(`${teamGames} team games`);
    }

    if (typeof remaining === 'number') {
      pieces.push(`${remaining} remaining`);
    }

    return pieces.join(' · ');
  }

  getPerformanceClass(asset: DraftableAsset): string {
    const percent = this.getProjectionAsset(asset).performanceVsProjectionPercent;

    if (typeof percent !== 'number' || Math.abs(percent) < 5) {
      return 'performance-even';
    }

    return percent > 0 ? 'performance-ahead' : 'performance-behind';
  }

  getPerformanceLabel(asset: DraftableAsset): string {
    const projectionAsset = this.getProjectionAsset(asset);
    const percent = projectionAsset.performanceVsProjectionPercent;
    const points = projectionAsset.performanceVsProjectionPoints;

    if (typeof percent !== 'number' || typeof points !== 'number') {
      return 'Projection pace unavailable';
    }

    if (Math.abs(percent) < 5) {
      return `On pace (${points >= 0 ? '+' : ''}${points.toFixed(1)} pts)`;
    }

    return `${Math.abs(percent).toFixed(0)}% ${percent > 0 ? 'ahead' : 'behind'} (${points >= 0 ? '+' : ''}${points.toFixed(1)} pts)`;
  }

  getPerformanceDetail(asset: DraftableAsset): string {
    const expected = this.getProjectionAsset(asset).expectedFantasyPointsToDate;

    return typeof expected === 'number'
      ? `${expected.toFixed(1)} points were expected through the NHL team games completed so far.`
      : 'A stable draft projection was not available for a pace comparison.';
  }

  getProjectionReliability(asset: DraftableAsset): number | null {
    const projectionAsset = this.getProjectionAsset(asset);

    return projectionAsset.reliabilityRating ?? projectionAsset.draftReliabilityRating ?? null;
  }

  getReliabilityLabel(asset: DraftableAsset): string {
    const reliability = this.getProjectionReliability(asset);

    if (typeof reliability !== 'number') {
      return 'Reliability unavailable';
    }

    if (reliability >= 82) {
      return `${reliability.toFixed(0)}/100 · High confidence`;
    }

    if (reliability >= 65) {
      return `${reliability.toFixed(0)}/100 · Moderate confidence`;
    }

    return `${reliability.toFixed(0)}/100 · Volatile outlook`;
  }

  getScheduleOutlookLabel(asset: DraftableAsset): string {
    const projectionAsset = this.getProjectionAsset(asset);
    const label = projectionAsset.scheduleDifficultyLabel;
    const adjustment = projectionAsset.scheduleStrengthAdjustment;

    if (!label && typeof adjustment !== 'number') {
      return 'Schedule outlook unavailable';
    }

    const adjustmentLabel =
      typeof adjustment === 'number'
        ? ` (${adjustment >= 0 ? '+' : ''}${adjustment.toFixed(1)} pts)`
        : '';

    return `${label ?? 'Neutral schedule'}${adjustmentLabel}`;
  }

  getExpectedAvailabilityLabel(asset: DraftableAsset): string {
    const projectionAsset = this.getProjectionAsset(asset);
    const expected = projectionAsset.expectedGamesAvailable;
    const scheduled = projectionAsset.scheduledGamesInProjectionCycle;

    if (typeof expected !== 'number' || typeof scheduled !== 'number') {
      return 'Expected availability unavailable';
    }

    return `${expected.toFixed(1)} of ${scheduled} games expected`;
  }

  getRecentPaceLabel(asset: DraftableAsset, window: 3 | 5 | 10 | 20): string {
    const projectionAsset = this.getProjectionAsset(asset);
    const value =
      window === 3
        ? projectionAsset.recentThreeGameFantasyPointsPerGame
        : window === 5
          ? projectionAsset.recentFiveGameFantasyPointsPerGame
          : window === 10
            ? projectionAsset.recentTenGameFantasyPointsPerGame
            : projectionAsset.recentTwentyGameFantasyPointsPerGame;

    return typeof value === 'number' ? value.toFixed(1) : '—';
  }

  getSeasonFantasyPointsPerGame(asset: DraftableAsset): string {
    const value = this.getProjectionAsset(asset).seasonFantasyPointsPerGame;

    return typeof value === 'number' ? value.toFixed(1) : '—';
  }

  getStatBreakdown(asset: DraftableAsset): ProjectionStatBreakdownItem[] {
    return this.getProjectionAsset(asset).seasonStatBreakdown ?? [];
  }

  getStatBreakdownNote(asset: DraftableAsset): string {
    return (
      this.getProjectionAsset(asset).seasonStatBreakdownNote ??
      'Refresh shared projections to load the current-season point breakdown.'
    );
  }

  getBreakdownStatLabel(item: ProjectionStatBreakdownItem): string {
    const value = Number.isInteger(item.statValue)
      ? item.statValue.toFixed(0)
      : item.statValue.toFixed(1);

    return `${value} ${item.statUnit}`;
  }

  getProjectionSourceLabel(asset: DraftableAsset): string {
    const source = this.getProjectionAsset(asset).projectionDataSource;

    switch (source) {
      case 'current-season-form':
        return 'Current season + recent form';
      case 'current-season-baseline':
        return 'Current-season baseline';
      case 'previous-season-form':
        return 'Previous season + recent form';
      case 'previous-season-baseline':
        return 'Previous-season baseline';
      case 'conservative-baseline':
        return 'Conservative position baseline';
      default:
        return 'Projection source unavailable';
    }
  }

  getDraftStatusText(): string {
    const status = this.draft()?.status;

    if (status === 'complete') {
      return 'Add/drop and waiver claims are open.';
    }

    if (!status) {
      return 'Draft status is loading.';
    }

    return 'Add/drop opens after the draft is complete.';
  }

  areRosterWindowsReady(): boolean {
    const activeCycleNumbers = this.leagueCycles()
      .filter((cycle) => cycle.status === 'active')
      .map((cycle) => cycle.cycleNumber);

    if (activeCycleNumbers.length === 0) {
      return true;
    }

    const loadedByCycle = this.teamWindowLoadedByCycle();

    return activeCycleNumbers.every((cycleNumber) => loadedByCycle[cycleNumber] === true);
  }

  hasStartedCycleWindows(): boolean {
    return this.latestCycle() !== null;
  }

  getEffectiveCycleText(): string {
    const candidate = this.selectedDropCandidate();

    if (!this.hasStartedCycleWindows()) {
      return 'immediately before Matchup 1 begins';
    }

    if (candidate?.rosterArea === 'bench') {
      return `owned now · first active eligibility Matchup ${candidate.effectiveCycleNumber}`;
    }

    return candidate
      ? `in Matchup ${candidate.effectiveCycleNumber}`
      : 'after the selected slot finishes its current six games';
  }

  getRequiredGamesPerCycle(): number {
    return (
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle
    );
  }

  getSelectedAssetCycleHeadline(): string {
    const eligibility = this.selectedAssetEligibility();

    if (!eligibility) {
      return this.eligibilityLoading()
        ? 'Checking current six-game status…'
        : 'Six-game check unavailable';
    }

    const liveSuffix = eligibility.liveGamesInCurrentCycle > 0 ? ' · game live' : '';

    return `Matchup ${eligibility.currentCycleNumber} · ${eligibility.completedGamesInCurrentCycle}/${eligibility.scheduledGamesInCurrentCycle} NHL team games final${liveSuffix}`;
  }

  getSelectedAssetCycleDetail(): string {
    const eligibility = this.selectedAssetEligibility();

    if (!eligibility) {
      return this.eligibilityError() || 'The move cannot be confirmed until this check finishes.';
    }

    if (eligibility.currentCycleHasStarted) {
      return `This player’s six-game count for Matchup ${eligibility.currentCycleNumber} has already started. Those results cannot be acquired retroactively, so the earliest fair activation is Matchup ${eligibility.earliestEligibleCycleNumber}.`;
    }

    return `No game in this player’s Matchup ${eligibility.currentCycleNumber} count has started. The player is eligible for Matchup ${eligibility.earliestEligibleCycleNumber}, subject to the selected roster slot finishing its current six games.`;
  }

  getSelectedAssetCycleClass(): string {
    const eligibility = this.selectedAssetEligibility();

    if (!eligibility) {
      return this.eligibilityError() ? 'eligibility-error' : 'eligibility-loading';
    }

    return eligibility.currentCycleHasStarted ? 'eligibility-delayed' : 'eligibility-ready';
  }

  getCandidateWindowLabel(candidate: DropCandidate): string {
    if (candidate.rosterArea === 'bench') {
      return candidate.asset
        ? 'Current location: flexible bench · no fantasy points counted'
        : 'Open flexible bench slot · no active six-game count';
    }

    const window = candidate.currentWindow;

    if (!window) {
      return this.hasStartedCycleWindows()
        ? `No active six-game count · next opening Matchup ${candidate.slotNextCycleNumber}`
        : 'Season not started · available immediately';
    }

    return `Current count: Matchup ${window.cycleNumber} · ${window.gamesPlayed}/${window.scheduledGames || this.getRequiredGamesPerCycle()} NHL team games final`;
  }

  getCandidateWindowAssetLabel(candidate: DropCandidate): string {
    if (candidate.rosterArea === 'bench') {
      return candidate.asset
        ? `${this.getRosterAssetName(candidate.asset)} is currently benched`
        : 'Open bench ownership slot';
    }

    const window = candidate.currentWindow;

    if (!window) {
      return candidate.asset ? this.getRosterAssetName(candidate.asset) : 'Open slot';
    }

    const windowAssetName = this.getAssetName(window.asset);

    if (candidate.currentWindowUntouched) {
      return `${windowAssetName} · six-game count not started`;
    }

    if (!candidate.asset) {
      return `Started six-game count still belongs to ${windowAssetName}`;
    }

    return window.assetKey === this.getRosterAssetKey(candidate.asset)
      ? `${windowAssetName} keeps the started six-game count`
      : `Started six-game count: ${windowAssetName}`;
  }

  getCandidateActivationLabel(candidate: DropCandidate): string {
    if (candidate.rosterArea === 'bench') {
      return this.hasStartedCycleWindows()
        ? `Active eligibility Matchup ${candidate.effectiveCycleNumber}`
        : 'Owned immediately';
    }

    if (candidate.canApplyImmediately) {
      return `Applies now · Matchup ${candidate.effectiveCycleNumber}`;
    }

    return this.hasStartedCycleWindows()
      ? `Activates Matchup ${candidate.effectiveCycleNumber}`
      : 'Activates immediately';
  }

  getCandidateActivationDetail(candidate: DropCandidate): string {
    const eligibility = this.selectedAssetEligibility();

    if (!this.hasStartedCycleWindows()) {
      return 'The season has not started, so no completed NHL games need to be skipped.';
    }

    if (candidate.rosterArea === 'bench') {
      return `The add or replacement happens immediately on your bench. This player or goalie unit cannot move into an active scoring slot before Matchup ${candidate.effectiveCycleNumber}, so already-played games are never backfilled.`;
    }

    if (candidate.canApplyImmediately) {
      return `Neither the outgoing slot’s six-game count nor the incoming player’s eligible count has started. The server will replace only this untouched Matchup ${candidate.effectiveCycleNumber} assignment.`;
    }

    if (eligibility && eligibility.earliestEligibleCycleNumber > candidate.slotNextCycleNumber) {
      return `The slot could advance in Matchup ${candidate.slotNextCycleNumber}, but the incoming player’s current six-game count has already started. The player is reserved and waits until Matchup ${candidate.effectiveCycleNumber}.`;
    }

    return `The move begins when this roster slot advances into Matchup ${candidate.effectiveCycleNumber}.`;
  }

  getPendingMoveIncomingName(index: number): string {
    const entry = this.pendingRosterMoves()[index];

    return entry ? this.getRosterAssetName(entry.move.incomingAsset) : 'Unknown Player';
  }

  getPendingMoveOutgoingName(index: number): string {
    const entry = this.pendingRosterMoves()[index];

    if (!entry?.slot.asset) {
      return 'Open Slot';
    }

    return this.getRosterAssetName(entry.slot.asset);
  }

  getPendingMoveSlotLabel(index: number): string {
    const entry = this.pendingRosterMoves()[index];

    return entry ? `${entry.slot.position} Slot ${entry.slot.slotNumber}` : 'Roster Slot';
  }

  canCancelPendingMove(index: number): boolean {
    const entry = this.pendingRosterMoves()[index];

    return Boolean(entry && !entry.move.sourceWaiverId);
  }

  async cancelPendingMove(index: number): Promise<void> {
    const entry = this.pendingRosterMoves()[index];

    this.successMessage.set('');
    this.errorMessage.set('');

    if (!entry) {
      this.errorMessage.set('That scheduled roster move is no longer available.');
      return;
    }

    if (entry.move.sourceWaiverId) {
      this.errorMessage.set(
        'An awarded waiver move cannot be canceled after commissioner processing.',
      );
      return;
    }

    this.moving.set(true);

    try {
      await cancelQueuedRosterMove({
        leagueId: this.leagueId,
        ownerId: this.userId,
        rosterSlotId: entry.slot.slotId,
      });

      this.successMessage.set(
        `Canceled the scheduled move for ${entry.slot.position} Slot ${entry.slot.slotNumber}. ${this.getRosterAssetName(entry.move.incomingAsset)} is available again.`,
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to cancel that scheduled roster move.',
      );
    } finally {
      this.moving.set(false);
    }
  }

  isSelectedAddAsset(asset: DraftableAsset): boolean {
    return this.selectedAddAssetKey() === asset.assetKey;
  }

  isSelectedDropCandidate(candidate: DropCandidate): boolean {
    return this.selectedDropSlotId() === candidate.slotId;
  }

  getRosterSpotCandidateName(candidate: DropCandidate): string {
    if (!candidate.asset) {
      return candidate.rosterArea === 'bench' ? `Open Bench ${candidate.slotNumber}` : `Open ${candidate.position} Slot`;
    }

    return this.getRosterAssetName(candidate.asset);
  }

  getRosterSpotCandidateDescription(candidate: DropCandidate): string {
    if (!candidate.asset) {
      return candidate.rosterArea === 'bench'
        ? `Flexible Bench Slot ${candidate.slotNumber} · any position`
        : `${candidate.position} Slot ${candidate.slotNumber} · opened by Injured Reserve or a roster move`;
    }

    return candidate.rosterArea === 'bench'
      ? `${this.getRosterAssetTeamLabel(candidate.asset)} · ${candidate.asset.position} · Bench ${candidate.slotNumber}`
      : `${this.getRosterAssetTeamLabel(candidate.asset)} · ${candidate.position} · Slot ${candidate.slotNumber}`;
  }

  getMoveSummary(): string {
    const addAsset = this.selectedAddAsset();
    const dropCandidate = this.selectedDropCandidate();
    const waiver = this.selectedWaiver();

    if (!addAsset) {
      return 'Choose a free agent or waiver player to start a move.';
    }

    if (!dropCandidate) {
      return waiver
        ? `Choose an active ${addAsset.position} slot, an open bench slot, or a player to drop for your waiver claim.`
        : `Choose an active ${addAsset.position} slot, an open bench slot, or a player to drop.`;
    }

    if (dropCandidate.moveType === 'open-slot') {
      const destination = dropCandidate.rosterArea === 'bench'
        ? `Fill Bench ${dropCandidate.slotNumber}`
        : `Fill open ${addAsset.position} slot`;
      return waiver
        ? `Claim ${this.getAssetName(addAsset)} · ${destination} · ${this.getEffectiveCycleText()}`
        : `Add ${this.getAssetName(addAsset)} · ${destination} · ${this.getEffectiveCycleText()}`;
    }

    if (!dropCandidate.asset) {
      return waiver
        ? `Claim ${this.getAssetName(addAsset)} · ${this.getEffectiveCycleText()}`
        : `Add ${this.getAssetName(addAsset)} · ${this.getEffectiveCycleText()}`;
    }

    return waiver
      ? `Claim ${this.getAssetName(addAsset)} · Drop ${this.getRosterAssetName(dropCandidate.asset)} if awarded · ${this.getEffectiveCycleText()}`
      : `Add ${this.getAssetName(addAsset)} · Drop ${this.getRosterAssetName(dropCandidate.asset)} · ${this.getEffectiveCycleText()}`;
  }

  getConfirmButtonLabel(): string {
    if (this.moving()) {
      return this.selectedWaiver() ? 'Submitting Claim...' : 'Saving Move...';
    }

    return this.selectedWaiver() ? 'Submit Waiver Claim' : 'Confirm Add / Drop';
  }

  getPreferredRosterTargetLabel(): string {
    const slotId = this.preferredSlotId();
    const rosterArea = this.preferredRosterArea();
    const roster = this.myRoster();

    if (!slotId || !rosterArea || !roster) {
      return '';
    }

    if (rosterArea === 'active') {
      const slot = roster.activeSlots.find((candidate) => candidate.slotId === slotId);
      return slot ? `${slot.position} Slot ${slot.slotNumber}` : slotId;
    }

    const slot = roster.benchSlots.find((candidate) => candidate.slotId === slotId);
    return slot ? `Bench ${slot.slotNumber}` : slotId;
  }

  clearPreferredRosterTarget(): void {
    const preferredSlotId = this.preferredSlotId();

    this.preferredSlotId.set('');
    this.preferredRosterArea.set('');

    if (preferredSlotId && this.selectedDropSlotId() === preferredSlotId) {
      this.selectedDropSlotId.set('');
    }

    this.persistFreeAgentViewState();
  }

  getConfirmationTimingTitle(): string {
    const candidate = this.selectedDropCandidate();

    if (!candidate) {
      return 'Choose a roster spot to see the exact timing.';
    }

    if (this.selectedWaiver()) {
      return `If awarded: earliest Matchup ${candidate.effectiveCycleNumber}`;
    }

    if (candidate.rosterArea === 'bench') {
      return candidate.canApplyImmediately
        ? 'Bench ownership updates immediately'
        : `Owned now · active eligibility Matchup ${candidate.effectiveCycleNumber}`;
    }

    return candidate.canApplyImmediately
      ? `Applies now in Matchup ${candidate.effectiveCycleNumber}`
      : `Scheduled for Matchup ${candidate.effectiveCycleNumber}`;
  }

  getConfirmationTimingDetail(): string {
    const candidate = this.selectedDropCandidate();

    if (!candidate) {
      return 'RinkRat checks the incoming player and this exact roster slot before allowing the move.';
    }

    if (this.selectedWaiver()) {
      return `Submitting a claim does not add the player immediately. If this claim wins, ${this.getCandidateActivationDetail(candidate).replace(/^The /, 'the ')}`;
    }

    return this.getCandidateActivationDetail(candidate);
  }

  isCommissioner(): boolean {
    return this.league()?.commissionerId === this.userId;
  }

  isSelectedWaiver(waiver: FantasyWaiver): boolean {
    return this.selectedWaiverId() === waiver.id;
  }

  getWaiverClaimCount(waiver: FantasyWaiver): number {
    return waiver.claims?.length ?? 0;
  }

  getWaiverClaimLabel(waiver: FantasyWaiver): string {
    const claimCount = this.getWaiverClaimCount(waiver);

    if (claimCount === 0) {
      return 'No claims yet';
    }

    return claimCount === 1 ? '1 claim' : `${claimCount} claims`;
  }

  getWaiverDroppedByLabel(waiver: FantasyWaiver): string {
    return `Dropped by ${this.getTeamName(waiver.droppedByOwnerId)}`;
  }

  getTeamName(ownerId: string | null | undefined): string {
    if (!ownerId) {
      return 'Unknown Team';
    }

    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  getWaiverPriorityLabel(ownerId: string | null | undefined = this.userId): string {
    const team = this.teams().find((candidate) => candidate.ownerId === ownerId);

    return typeof team?.waiverPriority === 'number'
      ? `Waiver Priority #${team.waiverPriority}`
      : 'Waiver Priority —';
  }

  getPendingMoveActivationText(index: number): string {
    const entry = this.pendingRosterMoves()[index];

    if (!entry) {
      return 'Waiting for a slot boundary';
    }

    const targetCycle = entry.move.requestedEffectiveCycleNumber;

    return typeof targetCycle === 'number'
      ? `Reserved · earliest activation Matchup ${targetCycle}`
      : 'Reserved · activates after the roster spot finishes its current six games';
  }

  private getFreeAgentViewStateKey(): string {
    return `rinkrat:free-agents:v1:${this.leagueId}:${this.userId}`;
  }

  private restoreFreeAgentViewState(): void {
    if (this.viewStateRestored || !this.leagueId || !this.userId) {
      return;
    }

    this.viewStateRestored = true;

    if (typeof sessionStorage === 'undefined') {
      return;
    }

    let storedValue: string | null;

    try {
      storedValue = sessionStorage.getItem(this.getFreeAgentViewStateKey());
    } catch {
      return;
    }

    const state = parseFreeAgentMobileViewState(storedValue);

    if (!state) {
      return;
    }

    this.searchTerm.set(state.searchTerm);
    this.positionFilter.set(state.positionFilter);
    this.sortMode.set(state.sortMode);
    this.poolTab.set(state.poolTab);
    this.selectedAddAssetKey.set(state.selectedAddAssetKey);
    this.selectedWaiverId.set(state.selectedWaiverId);
    this.selectedDropSlotId.set(state.selectedDropSlotId);
    this.preferredSlotId.set(state.preferredSlotId);
    this.preferredRosterArea.set(state.preferredRosterArea);
    this.playerPoolScrollY.set(Math.max(0, state.playerPoolScrollY));
    this.flowStep.set(
      state.flowStep === 'roster-slot' && state.selectedAddAssetKey
        ? 'roster-slot'
        : 'player-pool',
    );
  }

  private persistFreeAgentViewState(): void {
    if (!this.leagueId || !this.userId || typeof sessionStorage === 'undefined') {
      return;
    }

    const state: FreeAgentMobileViewState = {
      version: 1,
      savedAt: Date.now(),
      searchTerm: this.searchTerm(),
      positionFilter: this.positionFilter(),
      sortMode: this.sortMode(),
      poolTab: this.poolTab(),
      flowStep: this.flowStep(),
      selectedAddAssetKey: this.selectedAddAssetKey(),
      selectedWaiverId: this.selectedWaiverId(),
      selectedDropSlotId: this.selectedDropSlotId(),
      preferredSlotId: this.preferredSlotId(),
      preferredRosterArea: this.preferredRosterArea(),
      playerPoolScrollY: this.playerPoolScrollY(),
    };

    try {
      sessionStorage.setItem(this.getFreeAgentViewStateKey(), JSON.stringify(state));
    } catch {
      // Storage may be disabled. The page remains fully usable without persistence.
    }
  }

  private applyRoutePreferences() {
    const query = this.route.snapshot.queryParamMap;
    const preferences = resolveFreeAgentRoutePreferences({
      position: query.get('position'),
      targetSlot: query.get('targetSlot'),
      rosterArea: query.get('rosterArea'),
      tab: query.get('tab'),
      focus: query.get('focus'),
    });

    if (preferences.position) {
      this.positionFilter.set(preferences.position);
    }

    if (preferences.poolTab) {
      this.poolTab.set(preferences.poolTab);
    }

    if (preferences.targetSlot) {
      // A direct handoff from My Team represents a new roster task. Do not reopen
      // an older comparison sheet that happened to be saved in this tab.
      this.selectedAddAssetKey.set('');
      this.selectedWaiverId.set('');
      this.selectedDropSlotId.set('');
      this.selectedAssetEligibility.set(null);
      this.eligibilityError.set('');
      this.restoredEligibilityKey = '';
      this.flowStep.set('player-pool');
      this.playerPoolScrollY.set(0);
      this.preferredSlotId.set(preferences.targetSlot);
      this.preferredRosterArea.set(preferences.rosterArea);
    }

    this.persistFreeAgentViewState();
    return preferences;
  }

  private resumeRestoredSelectionIfAvailable(): void {
    if (this.flowStep() !== 'roster-slot' || !this.selectedAddAssetKey()) {
      return;
    }

    const asset = this.selectedAddAsset();

    if (!asset) {
      if (!this.playerPoolLoading() && this.hasReceivedWaivers) {
        const missingName = this.selectedAddAssetKey();
        this.returnToPlayerPool();
        this.errorMessage.set(
          `The previously selected player (${missingName}) is no longer available. Choose another player.`,
        );
      }
      return;
    }

    const eligibilityKey = `${asset.assetKey}:${this.selectedWaiverId()}`;
    if (this.restoredEligibilityKey === eligibilityKey) {
      this.selectPreferredDropCandidateIfAvailable();
      return;
    }

    this.restoredEligibilityKey = eligibilityKey;
    void this.loadSelectedAssetEligibility(asset);
  }

  private selectPreferredDropCandidateIfAvailable(): void {
    if (this.selectedDropSlotId()) {
      return;
    }

    const preferred = resolvePreferredRosterCandidate(
      this.dropCandidates(),
      this.preferredSlotId(),
      this.preferredRosterArea(),
    );

    if (!preferred) {
      return;
    }

    this.selectedDropSlotId.set(preferred.slotId);
    this.persistFreeAgentViewState();
  }

  private capturePlayerPoolScroll(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.playerPoolScrollY.set(Math.max(0, window.scrollY));
  }

  private restorePlayerPoolScroll(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const targetY = this.playerPoolScrollY();
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: targetY, behavior: 'auto' });
      });
    }, 0);
  }

  private focusPendingMovesAfterRender(): void {
    if (
      !this.focusPendingMovesRequested ||
      typeof document === 'undefined' ||
      typeof window === 'undefined'
    ) {
      return;
    }

    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        if (!this.focusPendingMovesRequested) {
          return;
        }

        const target = document.getElementById('pending-roster-moves');

        if (!target) {
          return;
        }

        this.focusPendingMovesRequested = false;
        target.scrollIntoView({
          block: 'start',
          behavior: 'smooth',
        });
        target.focus({ preventScroll: true });
      });
    }, 80);
  }

  private async loadSelectedAssetEligibility(
    asset: DraftableAsset,
    forceRefresh = false,
  ): Promise<void> {
    const requestKey = `${asset.assetKey}::${Date.now()}`;
    this.eligibilityRequestKey = requestKey;
    this.eligibilityLoading.set(true);
    this.eligibilityError.set('');

    try {
      const eligibility = await resolveRosterMoveAssetCycleEligibility(
        asset,
        this.getRequiredGamesPerCycle(),
        { forceRefresh },
      );

      if (
        this.eligibilityRequestKey !== requestKey ||
        this.selectedAddAssetKey() !== asset.assetKey
      ) {
        return;
      }

      this.selectedAssetEligibility.set(eligibility);
      this.selectPreferredDropCandidateIfAvailable();
      this.persistFreeAgentViewState();
    } catch (error: unknown) {
      if (this.eligibilityRequestKey !== requestKey) {
        return;
      }

      this.selectedAssetEligibility.set(null);
      this.eligibilityError.set(
        error instanceof Error
          ? error.message
          : 'Unable to verify the selected player’s current six-game status.',
      );
    } finally {
      if (this.eligibilityRequestKey === requestKey) {
        this.eligibilityLoading.set(false);
      }
    }
  }

  private refreshTeamWindowListeners(cycles: FantasyCycle[]): void {
    const activeCycleNumbers = new Set(
      cycles.filter((cycle) => cycle.status === 'active').map((cycle) => cycle.cycleNumber),
    );

    Object.entries(this.teamWindowListeners).forEach(([cycleNumberText, unsubscribe]) => {
      const cycleNumber = Number(cycleNumberText);

      if (!activeCycleNumbers.has(cycleNumber)) {
        unsubscribe();
        delete this.teamWindowListeners[cycleNumber];
      }
    });

    const nextLoadedByCycle = Object.fromEntries(
      Object.entries(this.teamWindowLoadedByCycle()).filter(([cycleNumberText]) =>
        activeCycleNumbers.has(Number(cycleNumberText)),
      ),
    );
    const nextWindowsByCycle = Object.fromEntries(
      Object.entries(this.myTeamWindowsByCycle()).filter(([cycleNumberText]) =>
        activeCycleNumbers.has(Number(cycleNumberText)),
      ),
    );

    this.myTeamWindowsByCycle.set(nextWindowsByCycle);
    this.teamWindowLoadedByCycle.set(nextLoadedByCycle);

    activeCycleNumbers.forEach((cycleNumber) => {
      if (this.teamWindowListeners[cycleNumber]) {
        return;
      }

      this.teamWindowLoadedByCycle.set({
        ...this.teamWindowLoadedByCycle(),
        [cycleNumber]: false,
      });
      this.teamWindowListeners[cycleNumber] = listenToCycleTeamWindows(
        this.leagueId,
        cycleNumber,
        (teamWindows) => {
          const myWindows = teamWindows.find((entry) => entry.ownerId === this.userId) ?? null;

          this.myTeamWindowsByCycle.set({
            ...this.myTeamWindowsByCycle(),
            [cycleNumber]: myWindows,
          });
          this.teamWindowLoadedByCycle.set({
            ...this.teamWindowLoadedByCycle(),
            [cycleNumber]: true,
          });
          this.selectPreferredDropCandidateIfAvailable();
        },
        (error) => {
          console.warn(`Unable to load Matchup ${cycleNumber} roster-spot progress.`, error);
          this.teamWindowLoadedByCycle.set({
            ...this.teamWindowLoadedByCycle(),
            [cycleNumber]: false,
          });
        },
      );
    });
  }

  private clearTeamWindowListeners(): void {
    Object.values(this.teamWindowListeners).forEach((unsubscribe) => unsubscribe());
    this.teamWindowListeners = {};
    this.myTeamWindowsByCycle.set({});
    this.teamWindowLoadedByCycle.set({});
  }

  private getLatestWindowForSlot(slotId: string): FantasyAssetCycleWindow | null {
    const windows = (Object.values(this.myTeamWindowsByCycle()) as Array<FantasyTeamCycleWindows | null>)
      .flatMap((teamWindows) => teamWindows?.windows ?? [])
      .filter((window) => window.rosterSlotId === slotId)
      .sort((first, second) => second.cycleNumber - first.cycleNumber);

    return windows[0] ?? null;
  }

  private isWindowUntouched(window: FantasyAssetCycleWindow | null): boolean {
    return Boolean(
      window &&
      window.gamesPlayed === 0 &&
      window.actualGamesPlayed === 0 &&
      window.fantasyPoints === 0 &&
      window.completedGameIds.length === 0 &&
      window.liveGameIds.length === 0 &&
      window.appearanceGameIds.length === 0,
    );
  }

  private isAwaitingInitialWindowSync(): boolean {
    const activeCycleNumbers = this.leagueCycles()
      .filter((cycle) => cycle.status === 'active')
      .map((cycle) => cycle.cycleNumber);

    if (activeCycleNumbers.length === 0) {
      return false;
    }

    const loadedByCycle = this.teamWindowLoadedByCycle();
    const windowsByCycle = this.myTeamWindowsByCycle();

    return activeCycleNumbers.every(
      (cycleNumber) =>
        loadedByCycle[cycleNumber] === true &&
        (windowsByCycle[cycleNumber]?.windows.length ?? 0) === 0,
    );
  }

  private getSlotNextCycleNumber(window: FantasyAssetCycleWindow | null): number {
    if (!this.hasStartedCycleWindows()) {
      return 1;
    }

    if (this.isWindowUntouched(window) && window) {
      return window.cycleNumber;
    }

    if (!window && this.isAwaitingInitialWindowSync()) {
      return Math.max(
        1,
        ...this.leagueCycles()
          .filter((cycle) => cycle.status === 'active')
          .map((cycle) => cycle.cycleNumber),
      );
    }

    return window ? window.cycleNumber + 1 : this.getFallbackNextCycleNumber();
  }

  private getFallbackNextCycleNumber(): number {
    return (this.latestCycle()?.cycleNumber ?? 0) + 1;
  }

  private compareAvailableAssets(first: DraftableAsset, second: DraftableAsset): number {
    const firstAsset = this.getProjectionAsset(first);
    const secondAsset = this.getProjectionAsset(second);
    let firstValue = -Infinity;
    let secondValue = -Infinity;

    switch (this.sortMode()) {
      case 'SEASON_POINTS':
        firstValue = firstAsset.currentSeasonFantasyPoints ?? -Infinity;
        secondValue = secondAsset.currentSeasonFantasyPoints ?? -Infinity;
        break;
      case 'REST_OF_SEASON':
        firstValue = firstAsset.projectedRestOfSeasonPoints ?? -Infinity;
        secondValue = secondAsset.projectedRestOfSeasonPoints ?? -Infinity;
        break;
      case 'FINAL_OUTLOOK':
        firstValue = firstAsset.projectedFinalSeasonPoints ?? -Infinity;
        secondValue = secondAsset.projectedFinalSeasonPoints ?? -Infinity;
        break;
      case 'PERFORMANCE':
        firstValue = firstAsset.performanceVsProjectionPercent ?? -Infinity;
        secondValue = secondAsset.performanceVsProjectionPercent ?? -Infinity;
        break;
      case 'RELIABILITY':
        firstValue = this.getProjectionReliability(first) ?? -Infinity;
        secondValue = this.getProjectionReliability(second) ?? -Infinity;
        break;
      case 'NEXT_CYCLE':
      default: {
        const firstRank = firstAsset.cycleRank ?? 9999;
        const secondRank = secondAsset.cycleRank ?? 9999;

        if (firstRank !== secondRank) {
          return firstRank - secondRank;
        }

        firstValue = firstAsset.projectedCyclePoints ?? -Infinity;
        secondValue = secondAsset.projectedCyclePoints ?? -Infinity;
        break;
      }
    }

    if (secondValue !== firstValue) {
      return secondValue - firstValue;
    }

    return this.getAssetName(first).localeCompare(this.getAssetName(second));
  }

  private refreshRosterListeners(teams: FantasyTeam[]): void {
    const currentOwnerIds = new Set(teams.map((team) => team.ownerId));

    Object.entries(this.rosterListeners).forEach(([ownerId, unsubscribe]) => {
      if (!currentOwnerIds.has(ownerId)) {
        unsubscribe();
        delete this.rosterListeners[ownerId];

        const nextRosters = {
          ...this.rosters(),
        };

        delete nextRosters[ownerId];
        this.rosters.set(nextRosters);
      }
    });

    teams.forEach((team) => {
      if (this.rosterListeners[team.ownerId]) {
        return;
      }

      this.rosterListeners[team.ownerId] = listenToFantasyRoster(
        this.leagueId,
        team.ownerId,
        (roster) => {
          this.rosters.set({
            ...this.rosters(),
            [team.ownerId]: roster,
          });

          if (team.ownerId === this.userId) {
            this.selectPreferredDropCandidateIfAvailable();
            this.focusPendingMovesAfterRender();
          }
        },
      );
    });
  }

  private clearRosterListeners(): void {
    Object.values(this.rosterListeners).forEach((unsubscribe) => {
      unsubscribe();
    });

    this.rosterListeners = {};
  }

  private getRosterAssetKey(asset: RosterAsset | null): string {
    if (!asset) {
      return '';
    }

    if (asset.assetKey) {
      return asset.assetKey;
    }

    if (asset.assetType === 'skater') {
      const player = asset.player as {
        id?: number | string;
        playerId?: number | string;
        nhlPlayerId?: number | string;
      };

      const playerId = player.id ?? player.playerId ?? player.nhlPlayerId;

      return playerId ? `skater-${playerId}` : '';
    }

    return asset.teamAbbreviation ? `goalie-unit-${asset.teamAbbreviation}` : '';
  }

  private isBenchCandidateReservedForActiveSwap(slot: BenchRosterSlot): boolean {
    if (!slot.asset) {
      return false;
    }

    const assetKey = this.getRosterAssetKey(slot.asset);

    return Boolean(
      assetKey &&
      this.myRoster()?.activeSlots.some(
        (activeSlot) =>
          activeSlot.pendingMove?.sourceBenchSlotId === slot.slotId &&
          this.getRosterAssetKey(activeSlot.pendingMove.incomingAsset) === assetKey,
      ),
    );
  }
}
