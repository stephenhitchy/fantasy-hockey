import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../core/firebase';

import {
  DraftableAsset,
  DraftPosition,
  FantasyDraft
} from '../../core/draft/draft.models';

import {
  addDropRosterAsset,
  addFreeAgentToOpenRosterSlot,
  FantasyWaiver,
  FantasyWaiverClaimMoveType,
  listenToFantasyDraft,
  listenToLeagueWaivers,
  placeWaiverClaim,
  processWaiver
} from '../../core/draft/draft.service';

import {
  loadDraftPlayerPool
} from '../../core/draft/draft-player-pool.service';

import {
  PlayerAvailability
} from '../../core/player/player-availability.models';

import {
  getPlayerAvailabilityForPlayer,
  getPlayerAvailabilityStatusClass,
  shouldDisplayPlayerAvailability
} from '../../core/player/player-availability.service';

import {
  FantasyCycle
} from '../../core/cycle/cycle.models';

import {
  listenToLatestCycle
} from '../../core/cycle/cycle.service';

import {
  getLeagueById,
  League
} from '../../core/league/league.service';

import {
  FantasyTeam,
  listenToLeagueTeams
} from '../../core/team/team.service';

import {
  ActiveRosterSlot,
  FantasyRoster,
  RosterAsset
} from '../../core/team/roster.models';

import {
  listenToFantasyRoster
} from '../../core/team/roster.service';

type FreeAgentPositionFilter =
  | 'ALL'
  | DraftPosition;

interface DropCandidate {
  slotId: string;
  slotNumber: number;
  position: DraftPosition;
  asset: RosterAsset | null;
  moveType: 'open-slot' | 'drop';
}

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-free-agents',
  imports: [FormsModule, RouterLink],
  templateUrl: './free-agents.html',
  styleUrl: './free-agents.css'
})
export class FreeAgents implements OnDestroy {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  draft = signal<FantasyDraft | null>(null);
  teams = signal<FantasyTeam[]>([]);
  rosters = signal<Record<string, FantasyRoster | null>>({});
  latestCycle = signal<FantasyCycle | null>(null);
  waivers = signal<FantasyWaiver[]>([]);
  playerPool = signal<DraftableAsset[]>([]);

  loading = signal(true);
  playerPoolLoading = signal(false);
  moving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');

  searchTerm = signal('');
  positionFilter = signal<FreeAgentPositionFilter>('ALL');

  selectedAddAssetKey = signal('');
  selectedWaiverId = signal('');
  selectedDropSlotId = signal('');

  readonly positionFilters: FreeAgentPositionFilter[] = [
    'ALL',
    'LW',
    'C',
    'RW',
    'D',
    'G'
  ];

  private stopDraftListener: (() => void) | null = null;
  private stopTeamsListener: (() => void) | null = null;
  private stopLatestCycleListener: (() => void) | null = null;
  private stopWaiversListener: (() => void) | null = null;
  private rosterListeners: Record<string, () => void> = {};

  readonly selectedAddAsset = computed(() =>
    this.playerPool().find(
      (asset) => asset.assetKey === this.selectedAddAssetKey()
    ) ??
    this.waivers().find(
      (waiver) => waiver.asset.assetKey === this.selectedAddAssetKey()
    )?.asset ??
    null
  );

  readonly selectedWaiver = computed(() => {
    const waiverId = this.selectedWaiverId();

    if (!waiverId) {
      return null;
    }

    return this.waivers().find(
      (waiver) => waiver.id === waiverId && waiver.status === 'active'
    ) ?? null;
  });

  readonly myRoster = computed(() =>
    this.rosters()[this.userId] ?? null
  );

  readonly rosteredAssetKeys = computed(() => {
    const assetKeys = new Set<string>();

    Object.values(this.rosters()).forEach((roster) => {
      roster?.activeSlots.forEach((slot) => {
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
      .filter((waiver) =>
        positionFilter === 'ALL' ||
        waiver.asset.position === positionFilter
      )
      .filter((waiver) => {
        if (!search) {
          return true;
        }

        return [
          this.getAssetName(waiver.asset),
          this.getAssetTeamLabel(waiver.asset),
          waiver.asset.position
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

        return this.getAssetName(first.asset).localeCompare(
          this.getAssetName(second.asset)
        );
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
      .filter((asset) =>
        positionFilter === 'ALL' ||
        asset.position === positionFilter
      )
      .filter((asset) => {
        if (!search) {
          return true;
        }

        return [
          this.getAssetName(asset),
          this.getAssetTeamLabel(asset),
          asset.position
        ]
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
      .sort((first, second) => {
        const firstProjection = first.projectedCyclePoints ?? -1;
        const secondProjection = second.projectedCyclePoints ?? -1;

        if (secondProjection !== firstProjection) {
          return secondProjection - firstProjection;
        }

        return this.getAssetName(first).localeCompare(
          this.getAssetName(second)
        );
      });
  });

  readonly dropCandidates = computed((): DropCandidate[] => {
    const addAsset = this.selectedAddAsset();
    const roster = this.myRoster();

    if (!addAsset || !roster) {
      return [];
    }

    const openSlotCandidates = roster.activeSlots
      .filter((slot) =>
        slot.position === addAsset.position &&
        slot.asset === null
      )
      .map((slot) => ({
        slotId: slot.slotId,
        slotNumber: slot.slotNumber,
        position: slot.position,
        asset: null,
        moveType: 'open-slot' as const
      }));

    const dropCandidates = roster.activeSlots
      .filter((slot): slot is ActiveRosterSlot & { asset: RosterAsset } =>
        slot.position === addAsset.position &&
        slot.asset !== null
      )
      .map((slot) => ({
        slotId: slot.slotId,
        slotNumber: slot.slotNumber,
        position: slot.position,
        asset: slot.asset,
        moveType: 'drop' as const
      }))
      .sort((first, second) =>
        this.getRosterAssetName(first.asset).localeCompare(
          this.getRosterAssetName(second.asset)
        )
      );

    return [
      ...openSlotCandidates,
      ...dropCandidates
    ];
  });

  readonly selectedDropCandidate = computed(() => {
    const selectedSlotId = this.selectedDropSlotId();

    if (!selectedSlotId) {
      return null;
    }

    return this.dropCandidates().find(
      (candidate) => candidate.slotId === selectedSlotId
    ) ?? null;
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadPage();
  }

  ngOnDestroy(): void {
    this.stopDraftListener?.();
    this.stopTeamsListener?.();
    this.stopLatestCycleListener?.();
    this.stopWaiversListener?.();
    this.clearRosterListeners();
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

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);

      this.stopDraftListener = listenToFantasyDraft(
        leagueId,
        (draft) => {
          this.draft.set(draft);
        }
      );

      this.stopLatestCycleListener = listenToLatestCycle(
        leagueId,
        (cycle) => {
          this.latestCycle.set(cycle);
        }
      );

      this.stopWaiversListener = listenToLeagueWaivers(
        leagueId,
        (waivers) => {
          this.waivers.set(waivers);
        }
      );

      this.stopTeamsListener = listenToLeagueTeams(
        leagueId,
        (teams) => {
          this.teams.set(teams);
          this.refreshRosterListeners(teams);
        }
      );

      await this.loadPlayerPool();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load free agents.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  async loadPlayerPool(): Promise<void> {
    this.playerPoolLoading.set(true);
    this.errorMessage.set('');

    try {
      this.playerPool.set(
        await loadDraftPlayerPool(true)
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load the free agent pool.'
      );
    } finally {
      this.playerPoolLoading.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  setPositionFilter(value: string): void {
    const validFilters: FreeAgentPositionFilter[] = [
      'ALL',
      'LW',
      'C',
      'RW',
      'D',
      'G'
    ];

    if (validFilters.includes(value as FreeAgentPositionFilter)) {
      this.positionFilter.set(value as FreeAgentPositionFilter);
    }
  }

  selectAddAsset(asset: DraftableAsset): void {
    this.successMessage.set('');
    this.errorMessage.set('');
    this.selectedAddAssetKey.set(asset.assetKey);
    this.selectedWaiverId.set('');
    this.selectedDropSlotId.set('');

    if (this.positionFilter() === 'ALL') {
      this.positionFilter.set(asset.position);
    }
  }


  selectWaiver(waiver: FantasyWaiver): void {
    this.successMessage.set('');
    this.errorMessage.set('');
    this.selectedAddAssetKey.set(waiver.asset.assetKey);
    this.selectedWaiverId.set(waiver.id);
    this.selectedDropSlotId.set('');

    if (this.positionFilter() === 'ALL') {
      this.positionFilter.set(waiver.asset.position);
    }
  }

  selectDropCandidate(candidate: DropCandidate): void {
    this.selectedDropSlotId.set(candidate.slotId);
  }

  canConfirmMove(): boolean {
    return Boolean(
      this.selectedAddAsset() &&
      this.selectedDropCandidate() &&
      this.draft()?.status === 'complete'
    );
  }

  async confirmAddDrop(): Promise<void> {
    const addAsset = this.selectedAddAsset();
    const dropCandidate = this.selectedDropCandidate();
    const waiver = this.selectedWaiver();

    this.successMessage.set('');
    this.errorMessage.set('');

    if (!addAsset || !dropCandidate) {
      this.errorMessage.set(
        'Choose a player and a same-position roster spot.'
      );
      return;
    }

    if (addAsset.position !== dropCandidate.position) {
      this.errorMessage.set(
        'This version only allows same-position roster moves.'
      );
      return;
    }

    this.moving.set(true);

    try {
      const effectiveCycleNumber = this.getEffectiveCycleNumber();
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
          effectiveLabel
        });

        this.successMessage.set(
          `Claim submitted for ${this.getAssetName(addAsset)}. The commissioner can process waivers when ready. If your claim wins, the move should score starting ${effectiveLabel}.`
        );
      } else if (dropCandidate.moveType === 'open-slot') {
        await addFreeAgentToOpenRosterSlot({
          leagueId: this.leagueId,
          ownerId: this.userId,
          targetSlotId: dropCandidate.slotId,
          addAsset,
          effectiveCycleNumber,
          effectiveLabel,
          leagueOwnerIds
        });

        this.successMessage.set(
          `Added ${this.getAssetName(addAsset)} into an open ${addAsset.position} slot. This move is saved to your current roster and should score starting ${effectiveLabel}.`
        );
      } else {
        if (!dropCandidate.asset) {
          throw new Error('The selected drop candidate is missing a roster asset.');
        }

        await addDropRosterAsset({
          leagueId: this.leagueId,
          ownerId: this.userId,
          dropSlotId: dropCandidate.slotId,
          addAsset,
          effectiveCycleNumber,
          effectiveLabel,
          leagueOwnerIds
        });

        this.successMessage.set(
          `Added ${this.getAssetName(addAsset)} and dropped ${this.getRosterAssetName(dropCandidate.asset)}. The dropped player is now on waivers. This move should score starting ${effectiveLabel}.`
        );
      }

      this.selectedAddAssetKey.set('');
      this.selectedWaiverId.set('');
      this.selectedDropSlotId.set('');
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to complete this roster move.'
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
      const effectiveCycleNumber = this.getEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;

      await processWaiver({
        leagueId: this.leagueId,
        commissionerId: this.userId,
        waiverId: waiver.id,
        leagueTeams: this.teams(),
        effectiveCycleNumber,
        effectiveLabel
      });

      const claimCount = waiver.claims?.length ?? 0;

      this.successMessage.set(
        claimCount > 0
          ? `Processed waivers for ${this.getAssetName(waiver.asset)}. The winning team was awarded the player and waiver priority was updated.`
          : `${this.getAssetName(waiver.asset)} cleared waivers and is now a normal free agent.`
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to process that waiver.'
      );
    } finally {
      this.moving.set(false);
    }
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

  getRosterAssetName(asset: RosterAsset): string {
    if (asset.assetType === 'skater') {
      const player = asset.player as {
        fullName?: string;
        firstName?: string;
        lastName?: string;
      };

      const fallbackName = [
        player.firstName,
        player.lastName
      ]
        .filter(Boolean)
        .join(' ');

      return player.fullName || fallbackName || 'Unknown Player';
    }

    return `${asset.teamName} Goalie Unit`;
  }

  getRosterAssetTeamLabel(asset: RosterAsset): string {
    return asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation;
  }

  getRosterAssetLogoUrl(asset: RosterAsset): string | undefined {
    return asset.assetType === 'skater'
      ? asset.player.teamLogoUrl
      : asset.teamLogoUrl;
  }

  getDisplayNumber(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
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

  getEffectiveCycleNumber(): number {
    return (this.latestCycle()?.cycleNumber ?? 0) + 1;
  }

  getEffectiveCycleText(): string {
    return `Effective Cycle ${this.getEffectiveCycleNumber()}`;
  }

  isSelectedAddAsset(asset: DraftableAsset): boolean {
    return this.selectedAddAssetKey() === asset.assetKey;
  }

  isSelectedDropCandidate(candidate: DropCandidate): boolean {
    return this.selectedDropSlotId() === candidate.slotId;
  }

  getRosterSpotCandidateName(candidate: DropCandidate): string {
    if (!candidate.asset) {
      return `Open ${candidate.position} Slot`;
    }

    return this.getRosterAssetName(candidate.asset);
  }

  getRosterSpotCandidateDescription(candidate: DropCandidate): string {
    if (!candidate.asset) {
      return `${candidate.position} Slot ${candidate.slotNumber} · opened by IR or roster move`;
    }

    return `${this.getRosterAssetTeamLabel(candidate.asset)} · ${candidate.position} · Slot ${candidate.slotNumber}`;
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
        ? `Choose an open ${addAsset.position} slot or one ${addAsset.position} to drop for your waiver claim.`
        : `Choose an open ${addAsset.position} slot or one ${addAsset.position} to drop.`;
    }

    if (dropCandidate.moveType === 'open-slot') {
      return waiver
        ? `Claim ${this.getAssetName(addAsset)} · Fill open ${addAsset.position} slot · ${this.getEffectiveCycleText()}`
        : `Add ${this.getAssetName(addAsset)} · Fill open ${addAsset.position} slot · ${this.getEffectiveCycleText()}`;
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
      return this.selectedWaiver()
        ? 'Submitting Claim...'
        : 'Saving Move...';
    }

    return this.selectedWaiver()
      ? 'Submit Waiver Claim'
      : 'Confirm Add / Drop';
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

    return claimCount === 1
      ? '1 claim'
      : `${claimCount} claims`;
  }

  getWaiverDroppedByLabel(waiver: FantasyWaiver): string {
    return `Dropped by ${this.getTeamName(waiver.droppedByOwnerId)}`;
  }

  getTeamName(ownerId: string | null | undefined): string {
    if (!ownerId) {
      return 'Unknown Team';
    }

    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
  }

  getWaiverPriorityLabel(ownerId: string | null | undefined = this.userId): string {
    const team = this.teams().find(
      (candidate) => candidate.ownerId === ownerId
    );

    return typeof team?.waiverPriority === 'number'
      ? `Waiver Priority #${team.waiverPriority}`
      : 'Waiver Priority —';
  }

  private refreshRosterListeners(teams: FantasyTeam[]): void {
    const currentOwnerIds = new Set(teams.map((team) => team.ownerId));

    Object.entries(this.rosterListeners).forEach(([ownerId, unsubscribe]) => {
      if (!currentOwnerIds.has(ownerId)) {
        unsubscribe();
        delete this.rosterListeners[ownerId];

        const nextRosters = {
          ...this.rosters()
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
            [team.ownerId]: roster
          });
        }
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

      const playerId =
        player.id ??
        player.playerId ??
        player.nhlPlayerId;

      return playerId
        ? `skater-${playerId}`
        : '';
    }

    return asset.teamAbbreviation
      ? `goalie-unit-${asset.teamAbbreviation}`
      : '';
  }
}
