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
  FantasyCycle,
  FantasyMatchup
} from '../../../core/cycle/cycle.models';

import {
  calculateCycleScoring,
  CycleAssetScoreSummary,
  CycleScoringResult
} from '../../../core/cycle/cycle-scoring.service';

import {
  defaultScoringRules
} from '../../../core/scoring/scoring-rules';

import {
  listenToCycleMatchups,
  listenToCycleRosterPicks,
  listenToLatestCycle
} from '../../../core/cycle/cycle.service';

import {
  DraftableAsset,
  DraftPick,
  DraftPosition
} from '../../../core/draft/draft.models';

import {
  activateIrRosterAsset,
  FantasyTransaction,
  listenToDraftPicks,
  listenToOwnerTransactions,
  moveRosterAssetToIr
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
  listenToLeagueTeams,
  updateTeamName
} from '../../../core/team/team.service';

import {
  ActiveRosterSlot,
  FantasyRoster,
  IrRosterSlot,
  RosterAsset,
  SkaterRosterAsset
} from '../../../core/team/roster.models';

import {
  NHLPlayer
} from '../../../core/player/player.models';

import {
  getOrCreateFantasyRoster,
  listenToFantasyRoster
} from '../../../core/team/roster.service';

function waitForAuthUser(): Promise<User | null> {
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

const TEST_CYCLE_START_DATE: Date | null =
  new Date('2026-01-10T12:00:00');

@Component({
  selector: 'app-team-settings',
  imports: [FormsModule, RouterLink],
  templateUrl: './team-settings.html',
  styleUrl: './team-settings.css'
})
export class TeamSettings implements OnDestroy {
  leagueId = '';
  userId = '';

  league = signal<League | null>(null);
  team = signal<FantasyTeam | null>(null);
  teams = signal<FantasyTeam[]>([]);
  roster = signal<FantasyRoster | null>(null);
  picks = signal<DraftPick[]>([]);
  cycleRosterPicks = signal<DraftPick[]>([]);
  playerPool = signal<DraftableAsset[]>([]);
  transactions = signal<FantasyTransaction[]>([]);
  latestCycle = signal<FantasyCycle | null>(null);
  latestMatchups = signal<FantasyMatchup[]>([]);
  cycleScoring = signal<CycleScoringResult | null>(null);

  teamName = '';
  loading = signal(true);
  saving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  scoringLoading = signal(false);
  scoringError = signal('');
  rosterMoveLoading = signal(false);
  rosterMoveMessage = signal('');
  rosterMoveError = signal('');

  readonly rosterPositions: RosterPositionGroup[] = [
    { position: 'LW', label: 'Left Wing' },
    { position: 'C', label: 'Center' },
    { position: 'RW', label: 'Right Wing' },
    { position: 'D', label: 'Defense' },
    { position: 'G', label: 'Goalie Unit' }
  ];

  private stopRosterListener: (() => void) | null = null;
  private stopTeamListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private stopTransactionsListener: (() => void) | null = null;
  private stopCycleRosterPicksListener: (() => void) | null = null;
  private stopLatestCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private scoringLoadKey: string | null = null;
  private scoringRequestId = 0;

  readonly currentMatchup = computed(() => {
    const userId = this.userId;

    if (!userId) {
      return null;
    }

    return this.latestMatchups().find(
      (matchup) =>
        matchup.teamAOwnerId === userId ||
        matchup.teamBOwnerId === userId
    ) ?? null;
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

  readonly rosterTotalCount = computed(() =>
    this.roster()?.activeSlots.length ?? 0
  );

  readonly irFilledCount = computed(() =>
    this.roster()?.irSlots.filter((slot) => slot.asset !== null).length ?? 0
  );

  readonly irTotalCount = computed(() =>
    this.roster()?.irSlots.length ?? 0
  );

  readonly teamPointDifferential = computed(() => {
    const team = this.team();

    if (!team) {
      return 0;
    }

    return (team.pointsFor ?? 0) - (team.pointsAgainst ?? 0);
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
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

    try {
      const [league, team] = await Promise.all([
        getLeagueById(leagueId),
        getFantasyTeam(leagueId, user.uid)
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
      this.teamName = team.teamName;

      await getOrCreateFantasyRoster(
        leagueId,
        user.uid
      );

      this.startLiveListeners(leagueId, user.uid);
      void this.loadPlayerPoolForProjectionFallback();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load this team.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  private startLiveListeners(
    leagueId: string,
    userId: string
  ): void {
    this.stopRosterListener?.();
    this.stopTeamListener?.();
    this.stopPicksListener?.();
    this.stopTransactionsListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopLatestCycleListener?.();
    this.stopMatchupsListener?.();

    this.stopRosterListener = listenToFantasyRoster(
      leagueId,
      userId,
      (roster) => {
        this.roster.set(roster);
      }
    );

    this.stopTeamListener = listenToLeagueTeams(
      leagueId,
      (teams) => {
        this.teams.set(teams);

        const currentTeam = teams.find(
          (candidate) => candidate.ownerId === userId
        );

        if (currentTeam) {
          this.team.set(currentTeam);
        }
      }
    );

    this.stopPicksListener = listenToDraftPicks(
      leagueId,
      (picks) => {
        this.picks.set(picks);
        void this.loadCurrentCycleScoringIfReady();
      }
    );

    this.stopTransactionsListener = listenToOwnerTransactions(
      leagueId,
      userId,
      (transactions) => {
        this.transactions.set(transactions);
      }
    );

    this.stopLatestCycleListener = listenToLatestCycle(
      leagueId,
      (cycle) => {
        this.latestCycle.set(cycle);
        this.latestMatchups.set([]);
        this.cycleRosterPicks.set([]);
        this.cycleScoring.set(null);
        this.scoringLoadKey = null;
        void this.loadCurrentCycleScoringIfReady();
        this.stopMatchupsListener?.();
        this.stopMatchupsListener = null;
        this.stopCycleRosterPicksListener?.();
        this.stopCycleRosterPicksListener = null;

        if (!cycle) {
          return;
        }

        this.stopCycleRosterPicksListener = listenToCycleRosterPicks(
          leagueId,
          cycle.cycleNumber,
          (picks) => {
            this.cycleRosterPicks.set(picks);
            this.scoringLoadKey = null;
            void this.loadCurrentCycleScoringIfReady();
          }
        );

        this.stopMatchupsListener = listenToCycleMatchups(
          leagueId,
          cycle.cycleNumber,
          (matchups) => {
            this.latestMatchups.set(matchups);
          }
        );
      }
    );
  }


  private async loadCurrentCycleScoringIfReady(): Promise<void> {
    const cycle = this.latestCycle();
    const league = this.league();
    const picks = this.cycleRosterPicks().length > 0
      ? this.cycleRosterPicks()
      : this.picks();

    if (!cycle || !league || picks.length === 0) {
      return;
    }

    const startDate =
      this.getProjectionWindowStartDate() ?? new Date();

    const season =
      this.getNhlSeasonForDate(startDate);

    const scoringRules =
      league.scoringRules ?? defaultScoringRules;

    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;

    const scoringKey = [
      cycle.id,
      cycle.cycleNumber,
      season,
      requiredGamesPerCycle,
      picks.map((pick) => pick.asset.assetKey).join('|')
    ].join('::');

    if (this.scoringLoadKey === scoringKey) {
      return;
    }

    this.scoringLoadKey = scoringKey;
    this.scoringLoading.set(true);
    this.scoringError.set('');

    const requestId = ++this.scoringRequestId;

    try {
      const result = await calculateCycleScoring({
        picks,
        cycleNumber: cycle.cycleNumber,
        season,
        requiredGamesPerCycle,
        scoringRules
      });

      if (requestId !== this.scoringRequestId) {
        return;
      }

      this.cycleScoring.set(result);
    } catch (error: unknown) {
      this.scoringLoadKey = null;
      this.scoringError.set(
        error instanceof Error
          ? error.message
          : 'Unable to load current roster scoring.'
      );
    } finally {
      if (requestId === this.scoringRequestId) {
        this.scoringLoading.set(false);
      }
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
          teamName: updatedName
        });
      }

      this.successMessage.set('Team name updated!');

      setTimeout(() => {
        this.successMessage.set('');
      }, 2200);
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to update team name.'
      );
    } finally {
      this.saving.set(false);
    }
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

  canMoveSlotToIr(slot: ActiveRosterSlot): boolean {
    return Boolean(
      slot.asset &&
      slot.asset.assetType === 'skater' &&
      this.getOpenIrSlotCount() > 0 &&
      !this.rosterMoveLoading()
    );
  }

  getMoveToIrDisabledText(slot: ActiveRosterSlot): string {
    if (!slot.asset) {
      return '';
    }

    if (slot.asset.assetType !== 'skater') {
      return 'Goalie units cannot be moved to IR.';
    }

    if (this.getOpenIrSlotCount() <= 0) {
      return 'No IR slots open.';
    }

    return '';
  }

  canActivateIrSlot(slot: IrRosterSlot): boolean {
    return Boolean(
      slot.asset &&
      this.getOpenActiveSlotForIrAsset(slot.asset) &&
      !this.rosterMoveLoading()
    );
  }

  getIrActivationHelp(slot: IrRosterSlot): string {
    if (!slot.asset) {
      return 'Open IR slot';
    }

    const openSlot = this.getOpenActiveSlotForIrAsset(slot.asset);

    if (!openSlot) {
      return `Needs an open ${slot.asset.position} slot to activate.`;
    }

    return `Can activate into ${slot.asset.position} Slot ${openSlot.slotNumber}.`;
  }

  async moveActiveSlotToIr(slotId: string): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    const roster = this.roster();
    const slot = roster?.activeSlots.find(
      (candidate) => candidate.slotId === slotId
    );

    if (!slot?.asset) {
      this.rosterMoveError.set('That active roster slot is empty.');
      return;
    }

    if (!this.canMoveSlotToIr(slot)) {
      this.rosterMoveError.set(
        this.getMoveToIrDisabledText(slot) || 'Unable to move that player to IR.'
      );
      return;
    }

    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const playerName = this.getRosterAssetName(slot.asset);

      await moveRosterAssetToIr({
        leagueId: this.leagueId,
        ownerId: this.userId,
        activeSlotId: slotId,
        effectiveCycleNumber,
        effectiveLabel
      });

      this.rosterMoveMessage.set(
        `${playerName} moved to IR. The current cycle stays locked, and your active roster change applies starting ${effectiveLabel}.`
      );
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error
          ? error.message
          : 'Unable to move this player to IR.'
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  async activateIrSlot(irSlotId: string): Promise<void> {
    this.rosterMoveMessage.set('');
    this.rosterMoveError.set('');

    const roster = this.roster();
    const irSlot = roster?.irSlots.find(
      (candidate) => candidate.slotId === irSlotId
    );

    if (!irSlot?.asset) {
      this.rosterMoveError.set('That IR slot is empty.');
      return;
    }

    const openActiveSlot = this.getOpenActiveSlotForIrAsset(irSlot.asset);

    if (!openActiveSlot) {
      this.rosterMoveError.set(
        `Open a ${irSlot.asset.position} slot before activating ${this.getRosterAssetName(irSlot.asset)} from IR.`
      );
      return;
    }

    this.rosterMoveLoading.set(true);

    try {
      const effectiveCycleNumber = this.getRosterMoveEffectiveCycleNumber();
      const effectiveLabel = `Cycle ${effectiveCycleNumber}`;
      const playerName = this.getRosterAssetName(irSlot.asset);

      await activateIrRosterAsset({
        leagueId: this.leagueId,
        ownerId: this.userId,
        irSlotId,
        activeSlotId: openActiveSlot.slotId,
        effectiveCycleNumber,
        effectiveLabel
      });

      this.rosterMoveMessage.set(
        `${playerName} activated from IR into ${openActiveSlot.position} Slot ${openActiveSlot.slotNumber}. This starts scoring with ${effectiveLabel}.`
      );
    } catch (error: unknown) {
      this.rosterMoveError.set(
        error instanceof Error
          ? error.message
          : 'Unable to activate this player from IR.'
      );
    } finally {
      this.rosterMoveLoading.set(false);
    }
  }

  getPositionSlots(position: DraftPosition): FantasyRoster['activeSlots'] {
    return this.roster()?.activeSlots.filter(
      (slot) => slot.position === position
    ) ?? [];
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
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

    return value > 0
      ? `+${rounded}`
      : rounded;
  }

  getMatchupScore(
    matchup: FantasyMatchup | null,
    ownerId: string | null
  ): number | null {
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

    return cycle
      ? `Cycle ${cycle.cycleNumber}`
      : 'Current Cycle';
  }

  getRosterAssetName(asset: unknown): string {
    const rosterAsset = asset as {
      assetType?: string;
      player?: { fullName?: string; firstName?: string; lastName?: string };
      teamName?: string;
    };

    if (rosterAsset.assetType === 'skater') {
      const fallbackName = [
        rosterAsset.player?.firstName,
        rosterAsset.player?.lastName
      ]
        .filter(Boolean)
        .join(' ');

      return (
        rosterAsset.player?.fullName ??
        fallbackName
      ) || 'Unknown Player';
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
      return rosterAsset.player?.nhlTeamAbbreviation ??
        rosterAsset.player?.teamAbbrev ??
        '—';
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
    const userPicks = this.picks().filter(
      (pick) => pick.ownerId === this.userId
    );

    if (assetKey) {
      const pickAsset = userPicks.find(
        (pick) => pick.asset.assetKey === assetKey
      )?.asset;

      if (pickAsset) {
        return pickAsset;
      }

      const poolAsset = this.playerPool().find(
        (availableAsset) => availableAsset.assetKey === assetKey
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
          pick.asset.teamAbbreviation === teamAbbreviation
      )?.asset;

      const poolAsset = this.playerPool().find(
        (availableAsset) =>
          availableAsset.assetType === 'team-goalie-unit' &&
          availableAsset.teamAbbreviation === teamAbbreviation
      );

      return pickAsset ?? poolAsset ?? {
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
        floorAdjustedDraftValue: rosterAsset.floorAdjustedDraftValue ?? null
      };
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

      return (
        rosterPlayerId !== null &&
        poolPlayerId !== null &&
        rosterPlayerId === poolPlayerId
      );
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
        floorAdjustedDraftValue: rosterAsset.floorAdjustedDraftValue ?? null
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
      [
        '/leagues',
        this.leagueId,
        'cycles',
        cycleNumber,
        'assets',
        projectionAsset.assetKey
      ],
      {
        queryParams: {
          returnTo: this.router.url
        }
      }
    );
  }

  getProjectedCycle(asset: unknown): number | null {
    return this.getRosterAssetProjection(asset)?.projectedCyclePoints ?? null;
  }

  getRosterAssetScoreSummary(
    asset: unknown
  ): CycleAssetScoreSummary | null {
    const projectionAsset = this.getRosterAssetProjection(asset);

    if (!projectionAsset) {
      return null;
    }

    return (
      this.cycleScoring()?.assetScores[projectionAsset.assetKey] ??
      null
    );
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

  private getRosterAssetStatus(asset: unknown):
    'active' | 'injured' | 'benched' | 'new' | 'moved' {
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

    return typeof reliability === 'number'
      ? Math.round(reliability).toString()
      : '—';
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
    return asset.assetType === 'skater'
      ? asset.player.fullName
      : `${asset.teamName} Goalie Unit`;
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
    return typeof team?.waiverPriority === 'number'
      ? `#${team.waiverPriority}`
      : '—';
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

  getTransactionTitle(transaction: FantasyTransaction): string {
    switch (transaction.type) {
      case 'add-open-slot':
        return `Added ${this.getTransactionAssetName(transaction.addedAsset)}`;

      case 'move-to-ir':
        return `Moved ${this.getTransactionAssetName(transaction.movedAsset)} to IR`;

      case 'activate-from-ir':
        return `Activated ${this.getTransactionAssetName(transaction.activatedAsset)} from IR`;

      case 'waiver-claim':
        return `Claimed ${this.getTransactionAssetName(transaction.waiverAsset)}`;

      case 'waiver-award':
        return `Won ${this.getTransactionAssetName(transaction.waiverAsset)} on waivers`;

      case 'waiver-cleared':
        return `${this.getTransactionAssetName(transaction.waiverAsset)} cleared waivers`;

      case 'add-drop':
      default:
        return `Added ${this.getTransactionAssetName(transaction.addedAsset)}`;
    }
  }

  getTransactionDetail(transaction: FantasyTransaction): string {
    switch (transaction.type) {
      case 'add-open-slot':
        return `Filled an open roster slot with ${this.getTransactionAssetName(transaction.addedAsset)}.`;

      case 'move-to-ir':
        return `${this.getTransactionAssetName(transaction.movedAsset)} moved from active roster to IR.`;

      case 'activate-from-ir':
        return `${this.getTransactionAssetName(transaction.activatedAsset)} moved from IR back to active roster.`;

      case 'waiver-claim':
        return 'Waiver claim submitted. Your roster only changes if the claim is awarded.';

      case 'waiver-award':
        return transaction.droppedAsset
          ? `Awarded by waiver priority. Dropped ${this.getTransactionAssetName(transaction.droppedAsset)}.`
          : 'Awarded by waiver priority into an open roster slot.';

      case 'waiver-cleared':
        return 'No claim was awarded, so this player became a normal free agent.';

      case 'add-drop':
      default:
        return `Dropped ${this.getTransactionAssetName(transaction.droppedAsset)}.`;
    }
  }

  getTransactionEffectiveLabel(transaction: FantasyTransaction): string {
    return transaction.effectiveLabel ||
      (typeof transaction.effectiveCycleNumber === 'number'
        ? `Cycle ${transaction.effectiveCycleNumber}`
        : 'Next cycle');
  }

  getTransactionDateLabel(value: unknown): string {
    const date = this.getDateFromUnknown(value);

    if (!date) {
      return 'Recently';
    }

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  private async loadPlayerPoolForProjectionFallback(): Promise<void> {
    try {
      this.playerPool.set(
        await loadDraftPlayerPool(true)
      );
    } catch (error: unknown) {
      console.warn(
        'Unable to load player pool projection fallback.',
        error
      );
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

      return playerId !== null
        ? `skater-${playerId}`
        : '';
    }

    return rosterAsset.teamAbbreviation
      ? `goalie-unit-${rosterAsset.teamAbbreviation}`
      : '';
  }



  private getOpenActiveSlotForIrAsset(
    asset: SkaterRosterAsset
  ): ActiveRosterSlot | null {
    return this.roster()?.activeSlots.find(
      (slot) => slot.position === asset.position && slot.asset === null
    ) ?? null;
  }

  private getProjectionWindowStartDate(): Date | null {
    if (TEST_CYCLE_START_DATE) {
      return TEST_CYCLE_START_DATE;
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

    if (
      typeof value === 'object' &&
      value !== null &&
      'toDate' in value
    ) {
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

    const seasonStartYear =
      month >= 7
        ? year
        : year - 1;

    return `${seasonStartYear}${seasonStartYear + 1}`;
  }

  private getPlayerId(player: unknown): number | string | null {
    const playerRecord = player as {
      id?: number | string;
      playerId?: number | string;
      nhlPlayerId?: number | string;
    } | null;

    return playerRecord?.id ??
      playerRecord?.playerId ??
      playerRecord?.nhlPlayerId ??
      null;
  }
}
