import { Component, computed, OnDestroy, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import { FantasyCycle, FantasyMatchup } from '../../../core/cycle/cycle.models';

import {
  CycleAssetScoreSummary,
  CycleScoringResult,
} from '../../../core/cycle/cycle-scoring.service';

import { defaultScoringRules } from '../../../core/scoring/scoring-rules';

import {
  listenToCycleMatchups,
  listenToCycleRosterPicks,
  listenToEarliestUnfinishedOwnerMatchup,
  listenToLatestCycle,
} from '../../../core/cycle/cycle.service';

import { DraftableAsset, DraftPick, DraftPosition } from '../../../core/draft/draft.models';

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
  type RosterDropSource,
} from '../../../core/draft/draft.service';

import { loadDraftPlayerPool } from '../../../core/draft/draft-player-pool.service';

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

import { getOrCreateFantasyRoster, listenToFantasyRoster } from '../../../core/team/roster.service';
import { getUserProfile, UserProfile } from '../../../core/user/user.service';
import { getPixelTeamTheme } from '../../../shared/pixel-theme/pixel-theme.data';

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

import { getHistoricalScoringTestDate } from '../../../core/cycle/cycle-runtime.config';

@Component({
  selector: 'app-team-settings',
  imports: [FormsModule, RouterLink],
  templateUrl: './team-settings.html',
  styleUrl: './team-settings.css',
})
export class TeamSettings implements OnDestroy {
  leagueId = '';
  userId = '';

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

  teamName = '';
  loading = signal(true);
  saving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  liveDataWarnings = signal<string[]>([]);
  scoringLoading = signal(false);
  scoringError = signal('');
  rosterMoveLoading = signal(false);
  rosterMoveMessage = signal('');
  rosterMoveError = signal('');
  irActivationSlotId = signal('');
  irActivationTargetSlotId = signal('');
  irBenchActivationSlotId = signal('');
  irBenchActivationTargetSlotId = signal('');
  benchSwapSlotId = signal('');
  benchSwapTargetSlotId = signal('');
  rosterDropSource = signal<RosterDropSource | null>(null);
  rosterDropSlotId = signal('');

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

  readonly currentMatchup = computed(() => {
    const userId = this.userId;

    if (!userId) {
      return null;
    }

    return (
      this.latestMatchups().find(
        (matchup) => matchup.teamAOwnerId === userId || matchup.teamBOwnerId === userId,
      ) ?? null
    );
  });

  readonly currentOpponentOwnerId = computed(() => {
    const matchup = this.currentMatchup();

    if (!matchup) {
      return null;
    }

    if (matchup.teamAOwnerId === this.userId) {
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

  readonly rosterTotalCount = computed(() => this.roster()?.activeSlots.length ?? 0);

  readonly benchFilledCount = computed(
    () => this.roster()?.benchSlots.filter((slot) => slot.asset !== null).length ?? 0,
  );

  readonly benchTotalCount = computed(() => this.roster()?.benchSlots.length ?? 0);

  readonly irFilledCount = computed(
    () => this.roster()?.irSlots.filter((slot) => slot.asset !== null).length ?? 0,
  );

  readonly irTotalCount = computed(() => this.roster()?.irSlots.length ?? 0);

  readonly teamPointDifferential = computed(() => {
    const team = this.team();

    if (!team) {
      return 0;
    }

    return (team.pointsFor ?? 0) - (team.pointsAgainst ?? 0);
  });


  readonly leagueRank = computed(() => {
    const ownerId = this.userId;

    if (!ownerId) {
      return null;
    }

    const rankIndex = buildFantasyStandings(this.teams()).findIndex(
      (standing) => standing.ownerId === ownerId,
    );

    return rankIndex >= 0 ? rankIndex + 1 : null;
  });

  readonly recentTransactions = computed(() =>
    this.transactions()
      .filter((transaction) => this.shouldShowTransactionInLedger(transaction))
      .slice(0, 10),
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    this.loadTeam();
  }

  ngOnDestroy(): void {
    this.stopRosterListener?.();
    this.stopTeamListener?.();
    this.stopPicksListener?.();
    this.stopTransactionsListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopLatestCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopCurrentNavigationMatchupListener?.();
    this.stopSharedScoringListener?.();
  }

  async loadTeam(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;
    this.errorMessage.set('');
    this.liveDataWarnings.set([]);

    try {
      const [league, team, profile] = await Promise.all([
        getLeagueById(leagueId),
        getFantasyTeam(leagueId, user.uid),
        getUserProfile(user.uid).catch(() => null),
      ]);

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

      await getOrCreateFantasyRoster(leagueId, user.uid);

      this.startLiveListeners(leagueId, user.uid);
      void this.loadPlayerPoolForProjectionFallback();
    } catch (error: unknown) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to load this team.');
    } finally {
      this.loading.set(false);
    }
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

  private startLiveListeners(leagueId: string, userId: string): void {
    this.stopRosterListener?.();
    this.stopTeamListener?.();
    this.stopPicksListener?.();
    this.stopTransactionsListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopLatestCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopCurrentNavigationMatchupListener?.();

    this.stopRosterListener = listenToFantasyRoster(
      leagueId,
      userId,
      (roster) => {
        this.clearLiveDataWarning('Roster');
        this.roster.set(roster);
      },
      (error) => {
        this.recordLiveDataWarning('Roster', error);
      },
    );

    this.stopTeamListener = listenToLeagueTeams(
      leagueId,
      (teams) => {
        this.clearLiveDataWarning('League teams');
        this.teams.set(teams);

        const currentTeam = teams.find((candidate) => candidate.ownerId === userId);

        if (currentTeam) {
          this.team.set(currentTeam);
        }
      },
      (error) => {
        this.recordLiveDataWarning('League teams', error);
      },
    );

    this.stopPicksListener = listenToDraftPicks(
      leagueId,
      (picks) => {
        this.clearLiveDataWarning('Draft picks');
        this.picks.set(picks);
        void this.loadCurrentCycleScoringIfReady();
      },
      (error) => {
        this.recordLiveDataWarning('Draft picks', error);
      },
    );

    this.stopTransactionsListener = listenToOwnerTransactions(
      leagueId,
      userId,
      (transactions) => {
        this.clearLiveDataWarning('Transactions');
        this.transactions.set(transactions);
      },
      (error) => {
        this.recordLiveDataWarning('Transactions', error);
      },
    );

    this.stopCurrentNavigationMatchupListener = listenToEarliestUnfinishedOwnerMatchup(
      leagueId,
      userId,
      (matchup) => {
        this.clearLiveDataWarning('Current matchup navigation');
        this.currentNavigationMatchup.set(matchup);
      },
      (error) => {
        this.recordLiveDataWarning('Current matchup navigation', error);
      },
    );

    this.stopLatestCycleListener = listenToLatestCycle(
      leagueId,
      (cycle) => {
        this.clearLiveDataWarning('Current cycle');
        this.latestCycle.set(cycle);
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
            this.clearLiveDataWarning('Shared scoring');
            this.cycleScoring.set(snapshot?.result ?? null);
            this.scoringLoading.set(false);
            this.scoringError.set('');
          },
          (error) => {
            this.recordLiveDataWarning('Shared scoring', error);
            this.scoringLoading.set(false);
            this.scoringError.set(error.message);
          },
        );

        this.stopCycleRosterPicksListener = listenToCycleRosterPicks(
          leagueId,
          cycle.cycleNumber,
          (picks) => {
            this.clearLiveDataWarning('Cycle roster');
            this.cycleRosterPicks.set(picks);
            void this.loadCurrentCycleScoringIfReady();
          },
          (error) => {
            this.recordLiveDataWarning('Cycle roster', error);
          },
        );

        this.stopMatchupsListener = listenToCycleMatchups(
          leagueId,
          cycle.cycleNumber,
          (matchups) => {
            this.clearLiveDataWarning('Current matchup');
            this.latestMatchups.set(matchups);
          },
          (error) => {
            this.recordLiveDataWarning('Current matchup', error);
          },
        );
      },
      (error) => {
        this.recordLiveDataWarning('Current cycle', error);
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

  async saveTeamName(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

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
      await updateTeamName(this.leagueId, user.uid, updatedName);

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
    return `Cycle ${this.getRosterMoveEffectiveCycleNumber()}`;
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
      return `${availability.label} · IR eligible`;
    }

    return `${availability.label} · Activation recommended when a roster slot is available`;
  }

  canMoveSlotToIr(slot: ActiveRosterSlot): boolean {
    return Boolean(
      slot.asset &&
      slot.asset.assetType === 'skater' &&
      this.isPlayerIrEligible(slot.asset) &&
      this.getOpenIrSlotCount() > 0 &&
      !slot.pendingMove &&
      !this.rosterMoveLoading(),
    );
  }

  getMoveToIrDisabledText(slot: ActiveRosterSlot): string {
    if (!slot.asset) {
      return '';
    }

    if (slot.pendingMove) {
      return 'A move is already queued for this slot.';
    }

    if (slot.asset.assetType !== 'skater') {
      return 'Goalie units cannot be moved to IR.';
    }

    const availability = this.getPlayerAvailability(slot.asset);

    if (availability && !availability.irEligible) {
      return getPlayerIrIneligibleReason(availability);
    }

    if (this.getOpenIrSlotCount() <= 0) {
      return 'No IR slots open.';
    }

    return '';
  }

  canActivateIrSlot(slot: IrRosterSlot): boolean {
    return Boolean(
      slot.asset &&
      this.getActiveSlotsForIrAsset(slot.asset).length > 0 &&
      !this.rosterMoveLoading(),
    );
  }

  getIrActivationHelp(slot: IrRosterSlot): string {
    if (!slot.asset) {
      return 'Open IR slot';
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

    return availability && !availability.irEligible
      ? `${availability.label}. Choose a ${slot.asset.position} player to replace.`
      : `Choose a ${slot.asset.position} player to replace. The replaced player goes to waivers.`;
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

  beginIrActivation(irSlotId: string): void {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');
    this.rosterDropSource.set(null);
    this.rosterDropSlotId.set('');

    const irSlot = this.getIrSlots().find((slot) => slot.slotId === irSlotId);

    if (!irSlot?.asset) {
      this.rosterMoveError.set('That IR slot is empty.');
      return;
    }

    const targetSlots = this.getActiveSlotsForIrAsset(irSlot.asset);

    if (targetSlots.length === 0) {
      this.rosterMoveError.set(`No ${irSlot.asset.position} roster slots were found.`);
      return;
    }

    const openSlot = targetSlots.find((slot) => slot.asset === null);

    this.irActivationSlotId.set(irSlotId);
    this.irActivationTargetSlotId.set(openSlot?.slotId ?? targetSlots[0].slotId);
  }

  cancelIrActivation(): void {
    if (this.rosterMoveLoading()) {
      return;
    }

    this.irActivationSlotId.set('');
    this.irActivationTargetSlotId.set('');
  }

  selectIrActivationTarget(slotId: string): void {
    this.irActivationTargetSlotId.set(slotId);
  }

  isIrActivationTargetSelected(slotId: string): boolean {
    return this.irActivationTargetSlotId() === slotId;
  }

  canConfirmIrActivation(): boolean {
    const irSlot = this.getPendingIrActivationSlot();
    const targetSlotId = this.irActivationTargetSlotId();

    if (!irSlot?.asset || !targetSlotId || this.rosterMoveLoading()) {
      return false;
    }

    return this.getActiveSlotsForIrAsset(irSlot.asset).some((slot) => slot.slotId === targetSlotId);
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

    return `${this.getRosterAssetTeamLabel(slot.asset)} · ${slot.position} Slot ${slot.slotNumber} · Will be placed on waivers`;
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
      slotLabel: `IR Slot ${slot.slotNumber}`,
      asset: slot.asset,
    };
  }

  beginRosterDrop(sourceRosterArea: RosterDropSource, slotId: string): void {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

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
            : 'That IR slot is already empty.',
      );
      return;
    }

    this.irActivationSlotId.set('');
    this.irActivationTargetSlotId.set('');
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
    return Boolean(this.getPendingRosterDrop() && !this.rosterMoveLoading());
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

    const pendingDrop = this.getPendingRosterDrop();

    if (!pendingDrop) {
      this.rosterMoveError.set(
        'That player or goalie unit is no longer in the selected roster slot.',
      );
      this.cancelRosterDrop();
      return;
    }

    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const assetName = this.getRosterAssetName(pendingDrop.asset);
      const sourceLabel = this.getRosterDropSourceLabel(pendingDrop.sourceRosterArea);

      const execution = await dropRosterAssetToWaivers({
        leagueId: this.leagueId,
        ownerId: this.userId,
        sourceRosterArea: pendingDrop.sourceRosterArea,
        slotId: pendingDrop.slotId,
        effectiveCycleNumber,
        effectiveLabel,
      });

      this.rosterMoveMessage.set(
        pendingDrop.sourceRosterArea === 'active' && execution.mode === 'immediate'
          ? `${assetName} was dropped from your ${sourceLabel} and placed on waivers. Its untouched Cycle ${execution.effectiveCycleNumber} assignment was removed immediately, so the open slot can still be filled for that cycle.`
          : pendingDrop.sourceRosterArea === 'active'
            ? `${assetName} was dropped from your ${sourceLabel} and placed on waivers. The player’s already-started individual window remains locked, and a replacement begins in ${effectiveLabel}.`
            : `${assetName} was dropped from your ${sourceLabel} and placed on waivers immediately.`,
      );

      this.rosterDropSource.set(null);
      this.rosterDropSlotId.set('');
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error ? error.message : 'Unable to drop this player or goalie unit.',
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  canMoveBenchSlotToIr(slot: BenchRosterSlot): boolean {
    return Boolean(
      slot.asset &&
      slot.asset.assetType === 'skater' &&
      this.isPlayerIrEligible(slot.asset) &&
      this.getOpenIrSlotCount() > 0 &&
      !this.rosterMoveLoading(),
    );
  }

  async moveBenchSlotToIr(slotId: string): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    const slot = this.roster()?.benchSlots.find((candidate) => candidate.slotId === slotId);
    if (!slot?.asset || slot.asset.assetType !== 'skater') {
      this.rosterMoveError.set('That bench skater is no longer available.');
      return;
    }

    this.rosterMoveLoading.set(true);
    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      await moveBenchRosterAssetToIr({
        leagueId: this.leagueId,
        ownerId: this.userId,
        benchSlotId: slotId,
        effectiveCycleNumber,
        effectiveLabel: `Cycle ${effectiveCycleNumber}`,
      });
      this.rosterMoveMessage.set(
        `${this.getRosterAssetName(slot.asset)} moved from the bench to IR. Bench assets do not score, so the ownership move is immediate.`,
      );
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error ? error.message : 'Unable to move this bench player to IR.',
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  beginBenchSwap(benchSlotId: string): void {
    const benchSlot = this.roster()?.benchSlots.find((slot) => slot.slotId === benchSlotId);
    if (!benchSlot?.asset) {
      this.rosterMoveError.set('That bench slot is empty.');
      return;
    }

    const targets = this.getPositionSlots(benchSlot.asset.position).filter((slot) => !slot.pendingMove);
    if (targets.length === 0) {
      this.rosterMoveError.set(`No ${benchSlot.asset.position} active slot is available for a queued swap.`);
      return;
    }

    this.rosterMoveError.set('');
    this.rosterMoveMessage.set('');
    this.benchSwapSlotId.set(benchSlotId);
    this.benchSwapTargetSlotId.set(targets[0].slotId);
  }

  cancelBenchSwap(): void {
    if (this.rosterMoveLoading()) {
      return;
    }
    this.benchSwapSlotId.set('');
    this.benchSwapTargetSlotId.set('');
  }

  getPendingBenchSwapSlot(): BenchRosterSlot | null {
    const slotId = this.benchSwapSlotId();
    return this.roster()?.benchSlots.find((slot) => slot.slotId === slotId) ?? null;
  }

  getBenchSwapTargetSlots(): ActiveRosterSlot[] {
    const benchSlot = this.getPendingBenchSwapSlot();
    return benchSlot?.asset
      ? this.getPositionSlots(benchSlot.asset.position).filter((slot) => !slot.pendingMove)
      : [];
  }

  selectBenchSwapTarget(slotId: string): void {
    if (this.getBenchSwapTargetSlots().some((slot) => slot.slotId === slotId)) {
      this.benchSwapTargetSlotId.set(slotId);
    }
  }

  canConfirmBenchSwap(): boolean {
    return Boolean(
      this.getPendingBenchSwapSlot()?.asset &&
      this.getBenchSwapTargetSlots().some(
        (slot) => slot.slotId === this.benchSwapTargetSlotId(),
      ) &&
      !this.rosterMoveLoading(),
    );
  }

  async confirmBenchSwap(): Promise<void> {
    const benchSlot = this.getPendingBenchSwapSlot();
    const targetSlot = this.getBenchSwapTargetSlots().find(
      (slot) => slot.slotId === this.benchSwapTargetSlotId(),
    );

    if (!benchSlot?.asset || !targetSlot) {
      this.rosterMoveError.set('Choose a valid bench asset and active slot.');
      return;
    }

    this.rosterMoveLoading.set(true);
    this.rosterMoveError.set('');
    try {
      const execution = await queueActiveBenchSwap({
        leagueId: this.leagueId,
        ownerId: this.userId,
        activeSlotId: targetSlot.slotId,
        benchSlotId: benchSlot.slotId,
      });

      this.rosterMoveMessage.set(
        execution.mode === 'immediate'
          ? `${this.getRosterAssetName(benchSlot.asset)} moved into ${targetSlot.position} Slot ${targetSlot.slotNumber} immediately. Neither individual window had started, so the swap applies to Cycle ${execution.effectiveCycleNumber}.`
          : `${this.getRosterAssetName(benchSlot.asset)} is queued for ${targetSlot.position} Slot ${targetSlot.slotNumber}. At least one individual window has started, so the swap begins in Cycle ${execution.effectiveCycleNumber}.`,
      );
      this.benchSwapSlotId.set('');
      this.benchSwapTargetSlotId.set('');
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error ? error.message : 'Unable to queue the bench swap.',
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  beginIrBenchActivation(irSlotId: string): void {
    const roster = this.roster();
    const irSlot = roster?.irSlots.find((slot) => slot.slotId === irSlotId);
    if (!irSlot?.asset) {
      this.rosterMoveError.set('That IR slot is empty.');
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
    return !!irSlot?.asset &&
      !!targetSlot &&
      !this.isBenchSlotReservedForActiveSwap(targetSlot) &&
      !this.rosterMoveLoading();
  }

  async confirmIrBenchActivation(): Promise<void> {
    const irSlot = this.getPendingIrBenchActivationSlot();
    const targetSlot = this.getIrBenchActivationTargets().find(
      (slot) => slot.slotId === this.irBenchActivationTargetSlotId(),
    );
    if (!irSlot?.asset || !targetSlot) {
      this.rosterMoveError.set('Choose a valid IR player and bench destination.');
      return;
    }

    this.rosterMoveLoading.set(true);
    this.rosterMoveError.set('');
    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      await activateIrRosterAssetToBench({
        leagueId: this.leagueId,
        ownerId: this.userId,
        irSlotId: irSlot.slotId,
        benchSlotId: targetSlot.slotId,
        effectiveCycleNumber,
        effectiveLabel: `Cycle ${effectiveCycleNumber}`,
      });
      const replacedAsset = targetSlot.asset;
      this.rosterMoveMessage.set(replacedAsset
        ? `${this.getRosterAssetName(irSlot.asset)} moved from IR to ${targetSlot.slotId}. ${this.getRosterAssetName(replacedAsset)} was placed on waivers.`
        : `${this.getRosterAssetName(irSlot.asset)} moved from IR to ${targetSlot.slotId}.`);
      this.irBenchActivationSlotId.set('');
      this.irBenchActivationTargetSlotId.set('');
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error ? error.message : 'Unable to move this player from IR to the bench.',
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  async moveActiveSlotToIr(slotId: string): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    const roster = this.roster();
    const slot = roster?.activeSlots.find((candidate) => candidate.slotId === slotId);

    if (!slot?.asset) {
      this.rosterMoveError.set('That active roster slot is empty.');
      return;
    }

    if (!this.canMoveSlotToIr(slot)) {
      this.rosterMoveError.set(
        this.getMoveToIrDisabledText(slot) || 'Unable to move that player to IR.',
      );
      return;
    }

    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const playerName = this.getRosterAssetName(slot.asset);
      const availabilityLabel = this.getPlayerAvailability(slot.asset)?.label ?? 'IR eligible';

      const execution = await moveRosterAssetToIr({
        leagueId: this.leagueId,
        ownerId: this.userId,
        activeSlotId: slotId,
        effectiveCycleNumber,
        effectiveLabel,
      });

      this.rosterMoveMessage.set(
        execution.mode === 'immediate'
          ? `${playerName} moved to IR with a ${availabilityLabel} designation. The untouched Cycle ${execution.effectiveCycleNumber} assignment was removed immediately, so a bench player or free agent can fill that slot now.`
          : `${playerName} moved to IR with a ${availabilityLabel} designation. The player’s already-started individual window remains locked, and a replacement begins in ${effectiveLabel}.`,
      );
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error ? error.message : 'Unable to move this player to IR.',
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  async confirmIrActivation(): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    const irSlot = this.getPendingIrActivationSlot();
    const targetSlotId = this.irActivationTargetSlotId();

    if (!irSlot?.asset) {
      this.rosterMoveError.set('That IR slot is empty.');
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

    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const playerName = this.getRosterAssetName(irSlot.asset);
      const replacedPlayerName = targetSlot.asset ? this.getRosterAssetName(targetSlot.asset) : '';

      const execution = await activateIrRosterAsset({
        leagueId: this.leagueId,
        ownerId: this.userId,
        irSlotId: irSlot.slotId,
        activeSlotId: targetSlot.slotId,
        effectiveCycleNumber,
        effectiveLabel,
      });

      const activationLabel = execution.effectiveCycleNumber
        ? `Cycle ${execution.effectiveCycleNumber}`
        : effectiveLabel;

      this.rosterMoveMessage.set(
        execution.mode === 'immediate'
          ? replacedPlayerName
            ? `${playerName} activated from IR into ${targetSlot.position} Slot ${targetSlot.slotNumber} immediately. ${replacedPlayerName} was placed on waivers, and the untouched individual window now belongs to ${playerName} in ${activationLabel}.`
            : `${playerName} activated from IR into ${targetSlot.position} Slot ${targetSlot.slotNumber} immediately for ${activationLabel}.`
          : replacedPlayerName
            ? `${playerName} moved into ${targetSlot.position} Slot ${targetSlot.slotNumber}. ${replacedPlayerName} was placed on waivers, while the already-started scoring window remains unchanged until ${activationLabel}.`
            : `${playerName} moved into ${targetSlot.position} Slot ${targetSlot.slotNumber}. Scoring eligibility begins with ${activationLabel}.`,
      );

      this.irActivationSlotId.set('');
      this.irActivationTargetSlotId.set('');
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error ? error.message : 'Unable to activate this player from IR.',
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  getPositionSlots(position: DraftPosition): FantasyRoster['activeSlots'] {
    return this.roster()?.activeSlots.filter((slot) => slot.position === position) ?? [];
  }

  getManagerName(): string {
    const profile = this.profile();
    const currentUser = auth.currentUser;

    return (
      profile?.username?.trim() ||
      currentUser?.displayName?.trim() ||
      currentUser?.email?.split('@')[0] ||
      'Manager'
    );
  }

  getFavoriteTeamLogoUrl(): string {
    return getPixelTeamTheme(this.profile()?.favoriteTeamAbbreviation).logoUrl;
  }

  getFavoriteTeamName(): string {
    return getPixelTeamTheme(this.profile()?.favoriteTeamAbbreviation).name;
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

    const searchableText = `${availability.externalStatus ?? ''} ${availability.note ?? ''}`.toLowerCase();
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

    return injuryLabels.find(([pattern]) => pattern.test(searchableText))?.[1] ?? availability.label;
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
      return [
        '/leagues',
        this.leagueId,
        'cycles',
        matchup.cycleNumber,
        'matchups',
        matchup.id,
      ];
    }

    return [
      '/leagues',
      this.leagueId,
      'cycles',
      this.latestCycle()?.cycleNumber ?? 1,
    ];
  }

  getCurrentMatchupStatusText(): string {
    const cycle = this.latestCycle();
    const matchup = this.currentMatchup();

    if (!cycle) {
      return 'No cycle has started yet.';
    }

    if (!matchup) {
      return `${this.getCycleLabel()} does not have a matchup for your team yet.`;
    }

    if (matchup.status === 'complete' || cycle.status === 'complete') {
      return `${this.getCycleLabel()} matchup is complete.`;
    }

    return `${this.getCycleLabel()} is active.`;
  }

  getCycleLabel(): string {
    const cycle = this.latestCycle();

    return cycle ? `Cycle ${cycle.cycleNumber}` : 'Current Cycle';
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

    return 'Unknown Asset';
  }

  getRosterAssetTeamLabel(asset: unknown): string {
    const rosterAsset = asset as {
      assetType?: string;
      player?: { nhlTeamAbbreviation?: string; teamAbbrev?: string };
      teamAbbreviation?: string;
    };

    if (rosterAsset.assetType === 'skater') {
      return rosterAsset.player?.nhlTeamAbbreviation ?? rosterAsset.player?.teamAbbrev ?? '—';
    }

    return rosterAsset.teamAbbreviation ?? '—';
  }

  getRosterAssetLogoUrl(asset: unknown): string | undefined {
    const rosterAsset = asset as {
      assetType?: string;
      player?: { teamLogoUrl?: string };
      teamLogoUrl?: string;
    };

    return rosterAsset.assetType === 'skater'
      ? rosterAsset.player?.teamLogoUrl
      : rosterAsset.teamLogoUrl;
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
    const userPicks = this.picks().filter((pick) => pick.ownerId === this.userId);

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

  openRosterAssetDetail(asset: unknown): void {
    const projectionAsset = this.getRosterAssetProjection(asset);
    const cycleNumber = this.latestCycle()?.cycleNumber ?? 1;

    if (!projectionAsset) {
      return;
    }

    void this.router.navigate(
      ['/leagues', this.leagueId, 'cycles', cycleNumber, 'assets', projectionAsset.assetKey],
      {
        queryParams: {
          returnTo: this.router.url,
        },
      },
    );
  }

  getProjectedCycle(asset: unknown): number | null {
    return this.getRosterAssetProjection(asset)?.projectedCyclePoints ?? null;
  }

  getRosterAssetScoreSummary(asset: unknown): CycleAssetScoreSummary | null {
    const projectionAsset = this.getRosterAssetProjection(asset);

    if (!projectionAsset) {
      return null;
    }

    return this.cycleScoring()?.assetScores[projectionAsset.assetKey] ?? null;
  }

  getRosterAssetCurrentCycleScore(asset: unknown): number {
    return this.getRosterAssetScoreSummary(asset)?.currentScore ?? 0;
  }

  getRosterAssetGamesPlayed(asset: unknown): number {
    return this.getRosterAssetScoreSummary(asset)?.gamesPlayed ?? 0;
  }

  getRosterAssetGamesLeft(asset: unknown): number {
    const summary = this.getRosterAssetScoreSummary(asset);

    if (summary) {
      return summary.gamesLeft;
    }

    return (
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle
    );
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
      return `Scores starting Cycle ${(this.latestCycle()?.cycleNumber ?? 0) + 1}`;
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

    return `Next window: ${this.getRosterAssetName(slot.pendingMove.incomingAsset)}`;
  }

  getTransactionAssetName(asset: DraftableAsset | RosterAsset | null | undefined): string {
    if (!asset) {
      return 'Unknown Asset';
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
    ].includes(transaction.type);
  }

  getTransactionAddedAsset(
    transaction: FantasyTransaction,
  ): DraftableAsset | RosterAsset | null {
    if (transaction.type === 'waiver-award') {
      return transaction.waiverAsset ?? null;
    }

    return transaction.addedAsset ?? null;
  }

  getTransactionDroppedAsset(transaction: FantasyTransaction): RosterAsset | null {
    return transaction.droppedAsset ?? null;
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
        return `Moved ${this.getTransactionAssetName(transaction.movedAsset)} to IR`;

      case 'activate-from-ir':
        return `Activated ${this.getTransactionAssetName(transaction.activatedAsset)} from IR`;

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
        return `Queued ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'queue-waiver-award':
        return `Reserved ${this.getTransactionAssetName(transaction.waiverAsset)} from waivers`;

      case 'slot-move-activated':
        return `Activated ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'queue-active-bench-swap':
        return `Queued ${this.getTransactionAssetName(transaction.movedAsset)} to start`;

      case 'active-bench-swap-activated':
        return `Started ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'move-bench-to-ir':
        return `Moved ${this.getTransactionAssetName(transaction.movedAsset)} from bench to IR`;

      case 'activate-ir-to-bench':
        return `Moved ${this.getTransactionAssetName(transaction.activatedAsset)} from IR to bench`;

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
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved from active roster to IR.`;

      case 'activate-from-ir':
        return transaction.droppedAsset
          ? `${this.getTransactionAssetName(transaction.activatedAsset)} moved from IR to the active roster. ${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers.`
          : `${this.getTransactionAssetName(transaction.activatedAsset)} moved from IR back to active roster.`;

      case 'drop-to-waivers':
        return `${this.getTransactionAssetName(transaction.droppedAsset)} was released from the ${
          transaction.sourceRosterArea === 'ir'
            ? 'IR'
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
        return `${this.getTransactionAssetName(transaction.droppedAsset)} keeps the current six-game slot window. The incoming player is reserved until that slot advances.`;

      case 'queue-add-open-slot':
        return 'The incoming player is reserved and will activate when this active roster slot reaches its next boundary.';

      case 'queue-waiver-award':
        return transaction.droppedAsset
          ? `The waiver winner is reserved. ${this.getTransactionAssetName(transaction.droppedAsset)} remains in the current slot window until the boundary.`
          : 'The waiver winner is reserved for the selected open slot boundary.';

      case 'slot-move-activated':
        return transaction.droppedAsset
          ? `${this.getTransactionAssetName(transaction.addedAsset)} started the new slot window. ${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers.`
          : `${this.getTransactionAssetName(transaction.addedAsset)} started the new slot window.`;

      case 'queue-active-bench-swap':
        return `${this.getTransactionAssetName(transaction.movedAsset)} remains on the bench until the active slot and incoming asset both reach a fair untouched cycle boundary. ${this.getTransactionAssetName(transaction.droppedAsset)} remains active until then.`;

      case 'active-bench-swap-activated':
        return `${this.getTransactionAssetName(transaction.addedAsset)} began the active slot window. ${this.getTransactionAssetName(transaction.droppedAsset)} moved to the bench.`;

      case 'move-bench-to-ir':
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved from the bench to IR and opened a flexible bench spot.`;

      case 'activate-ir-to-bench':
        return transaction.droppedAsset
          ? `${this.getTransactionAssetName(transaction.activatedAsset)} moved from IR to the bench. ${this.getTransactionAssetName(transaction.droppedAsset)} was placed on waivers.`
          : `${this.getTransactionAssetName(transaction.activatedAsset)} moved from IR into an open bench spot.`;

      case 'cancel-queued-move':
        return `${this.getTransactionAssetName(transaction.addedAsset)} was released from its reservation before the slot boundary.`;

      case 'add-drop':
      default:
        return transaction.sourceRosterArea === 'bench'
          ? `${this.getTransactionAssetName(transaction.addedAsset)} replaced ${this.getTransactionAssetName(transaction.droppedAsset)} on the bench. The dropped asset was placed on waivers.`
          : `Dropped ${this.getTransactionAssetName(transaction.droppedAsset)}.`;
    }
  }

  getTransactionEffectiveLabel(transaction: FantasyTransaction): string {
    return (
      transaction.effectiveLabel ||
      (typeof transaction.effectiveCycleNumber === 'number'
        ? `Cycle ${transaction.effectiveCycleNumber}`
        : 'Next cycle')
    );
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

  private async loadPlayerPoolForProjectionFallback(): Promise<void> {
    try {
      this.playerPool.set(await loadDraftPlayerPool(true));
    } catch (error: unknown) {
      console.warn('Unable to load player pool projection fallback.', error);
    }
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
}
