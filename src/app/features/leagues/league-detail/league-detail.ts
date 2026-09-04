import {
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';
import { getFantasyTeamProfileIconId } from '../../../core/team/team.service';
import { auth } from '../../../core/firebase';
import { reauthenticateCurrentUserWithPassword } from '../../../core/auth/account-deletion.service';

import { FantasyCycle, FantasyMatchup } from '../../../core/cycle/cycle.models';

import {
  listenToCycleMatchups,
  listenToEarliestUnfinishedOwnerMatchup,
  listenToLatestCycle,
} from '../../../core/cycle/cycle.service';

import { FantasyDraft } from '../../../core/draft/draft.models';
import { getDraftLobbyState } from '../../../core/draft/draft-lobby.util';

import {
  activateScheduledDraftIfReady,
  getScheduledStartDate,
  isDraftStartTimeReached,
  listenToFantasyDraft,
} from '../../../core/draft/draft.service';

import {
  PRE_DRAFT_PROJECTION_WARMUP_MINUTES,
} from '../../../core/projection/projection-snapshot.service';

import {
  listenToPlayerAvailabilitySyncState,
  syncPlayerAvailabilityFromEspn,
} from '../../../core/player/player-availability-sync.service';

import { PlayerAvailabilitySyncState } from '../../../core/player/player-availability.models';

import {
  deleteLeaguePermanently,
  getLeagueById,
  League,
  removeLeagueMemberBeforeDraft,
  updateLeagueProfileIcon,
} from '../../../core/league/league.service';
import { buildLeagueInviteUrl } from '../../../core/league/invite-link-intent.service';

import { FantasyTeam, listenToLeagueTeams, updateTeamName } from '../../../core/team/team.service';

import { startPlayerAvailabilityListenerForLeague } from '../../../core/player/player-availability.service';
import { forgetRememberedLastLeagueId } from '../../../core/user/user-theme.service';
import { PlatformAdminService } from '../../../core/admin/platform-admin.service';
import { DialogFocusTrapDirective } from '../../../shared/accessibility/dialog-focus-trap.directive';
import { ViewportOverlayPortalDirective } from '../../../shared/accessibility/viewport-overlay-portal.directive';
import { LeagueQuickNavigation } from '../../../shared/league-quick-navigation/league-quick-navigation';
import { LeagueWire } from '../league-wire/league-wire';
import { getLeagueLogoAssetPath } from '../../../shared/league-logo/league-logo.data';
import {
  getProfileIconsForCategory,
  PROFILE_ICON_CATEGORIES,
  type ProfileIconCategoryId,
  type ProfileIconOption,
} from '../../../shared/profile-icon/profile-icon.data';
import { ClientHealthService } from '../../../core/observability/client-health.service';

const DRAFT_ROOM_NAVIGATION_TIMEOUT_MILLISECONDS = 8_000;
const DRAFT_ENTRY_RECOVERY_DELAY_MILLISECONDS = 7_000;

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
  selector: 'app-league-detail',
  imports: [FormsModule, RouterLink, ManagerAvatar, LeagueWire, DialogFocusTrapDirective, ViewportOverlayPortalDirective, LeagueQuickNavigation],
  templateUrl: './league-detail.html',
  styleUrl: './league-detail.css',
})
export class LeagueDetail implements OnDestroy {
  private readonly platformAdminService = inject(PlatformAdminService);
  private readonly clientHealth = inject(ClientHealthService);
  readonly isPlatformAdmin = this.platformAdminService.isAdmin;

  @ViewChild('memberRemovalTeamNameInput')
  private memberRemovalTeamNameInput?: ElementRef<HTMLInputElement>;

  @ViewChild('memberRemovalStatus')
  private memberRemovalStatus?: ElementRef<HTMLElement>;

  leagueId = '';
  userId = '';
  teamNameDraft = '';
  deleteLeagueNameDraft = '';
  deleteLeaguePasswordDraft = '';
  memberRemovalTeamNameDraft = '';
  memberRemovalPasswordDraft = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  draft = signal<FantasyDraft | null>(null);
  cycle = signal<FantasyCycle | null>(null);
  matchups = signal<FantasyMatchup[]>([]);
  currentOwnerMatchup = signal<FantasyMatchup | null>(null);
  injurySyncState = signal<PlayerAvailabilitySyncState | null>(null);

  loading = signal(true);
  isCommissioner = signal(false);
  copyMessage = signal('');
  errorMessage = signal('');
  showDraftStartedModal = signal(false);
  draftEntryInProgress = signal(false);
  draftEntryRecoveryVisible = signal(false);
  draftEntryError = signal('');
  dailyInjuryRefreshInProgress = signal(false);
  dailyInjuryRefreshMessage = signal('');
  dailyInjuryRefreshError = signal('');

  renameTeamOpen = signal(false);
  renameTeamSaving = signal(false);
  renameTeamMessage = signal('');
  renameTeamError = signal('');
  profileIconPickerOpen = signal(false);
  profileIconSaving = signal(false);
  profileIconMessage = signal('');
  profileIconError = signal('');
  deleteLeaguePanelOpen = signal(false);
  deleteLeagueInProgress = signal(false);
  deleteLeagueError = signal('');
  memberRemovalTarget = signal<FantasyTeam | null>(null);
  memberRemovalInProgress = signal(false);
  memberRemovalMessage = signal('');
  memberRemovalError = signal('');

  readonly profileIconCategories = PROFILE_ICON_CATEGORIES;

  readonly now = signal(Date.now());

  private stopDraftListener: (() => void) | null = null;
  private stopTeamListener: (() => void) | null = null;
  private stopCycleListener: (() => void) | null = null;
  private stopMatchupsListener: (() => void) | null = null;
  private stopCurrentOwnerMatchupListener: (() => void) | null = null;
  private stopInjurySyncListener: (() => void) | null = null;

  private activationInProgress = false;
  private scheduledDraftCheckInProgress = false;
  private destroyed = false;
  private activationFailureCount = 0;
  private activationRetryNotBefore = 0;
  private redirectTimer: ReturnType<typeof setTimeout> | null = null;
  private draftEntryRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private hasEnteredDraftRoom = false;
  private memberRemovalReturnFocus: HTMLElement | null = null;

  private readonly countdownTimer = setInterval(() => {
    if (!this.destroyed) {
      this.now.set(Date.now());
    }
  }, 1000);

  private readonly scheduledDraftCheckTimer = setInterval(() => {
    void this.runScheduledDraftChecks();
  }, 5000);

  readonly myTeam = computed(
    () => this.teams().find((team) => team.ownerId === this.userId) ?? null,
  );

  readonly removableMemberTeams = computed(() =>
    this.teams().filter((team) => team.ownerId !== this.userId),
  );

  readonly preDraftMemberRemovalAvailable = computed(() => {
    const league = this.league();
    const draft = this.draft();

    if (!league || !this.isCommissioner() || this.cycle() || league.joinStatus === 'locked') {
      return false;
    }

    if (!draft) {
      return true;
    }

    return (
      draft.status === 'setup' &&
      draft.roundOneOrder.length === 0 &&
      draft.nextOverallPick === 1 &&
      draft.draftedAssetKeys.length === 0
    );
  });

  readonly selectedLeagueProfileIconId = computed(() =>
    getFantasyTeamProfileIconId(this.myTeam()),
  );

  profileIconsForCategory(categoryId: ProfileIconCategoryId): readonly ProfileIconOption[] {
    return getProfileIconsForCategory(categoryId);
  }

  readonly sortedTeams = computed(() =>
    [...this.teams()].sort((first, second) => {
      const firstWinPercentage = this.getWinPercentageValue(first);
      const secondWinPercentage = this.getWinPercentageValue(second);

      if (secondWinPercentage !== firstWinPercentage) {
        return secondWinPercentage - firstWinPercentage;
      }

      const firstDiff = (first.pointsFor ?? 0) - (first.pointsAgainst ?? 0);
      const secondDiff = (second.pointsFor ?? 0) - (second.pointsAgainst ?? 0);

      if (secondDiff !== firstDiff) {
        return secondDiff - firstDiff;
      }

      return first.teamName.localeCompare(second.teamName);
    }),
  );

  readonly currentCycleNumber = computed(() => this.cycle()?.cycleNumber ?? 1);

  readonly leagueLogoPath = computed(() => {
    const currentLeague = this.league();

    return getLeagueLogoAssetPath(
      currentLeague?.leagueLogoId,
      currentLeague?.leagueLogoPaletteId,
    );
  });

  readonly currentCycleLabel = computed(() => {
    const cycle = this.cycle();

    if (cycle?.phase === 'playoffs') {
      return cycle.playoffRoundLabel ?? `Playoff Matchup ${this.currentCycleNumber()}`;
    }

    return `Matchup ${this.currentCycleNumber()}`;
  });

  readonly scheduledStartDate = computed(() => getScheduledStartDate(this.draft()));

  readonly draftLobbyState = computed(() =>
    getDraftLobbyState({
      draftStatus: this.draft()?.status,
      scheduledStart: this.scheduledStartDate(),
      now: new Date(this.now()),
    }),
  );

  readonly isDraftLobbyOpen = computed(() => this.draftLobbyState() === 'open');

  readonly startTimeReached = computed(() => {
    const draft = this.draft();

    return draft?.status === 'scheduled' && isDraftStartTimeReached(draft, new Date(this.now()));
  });

  readonly shouldShowDraftStatus = computed(() => this.draft()?.status !== 'complete');

  readonly shouldShowInviteCode = computed(() => this.draft()?.status !== 'complete');

  readonly openTeamSpots = computed(() => {
    const maximumTeams = this.league()?.maxTeams ?? 0;
    return Math.max(0, maximumTeams - this.teams().length);
  });

  readonly leagueFillPercentage = computed(() => {
    const maximumTeams = this.league()?.maxTeams ?? 0;

    if (maximumTeams <= 0) {
      return 0;
    }

    return Math.min(100, Math.round((this.teams().length / maximumTeams) * 100));
  });

  readonly inviteAvailabilityLabel = computed(() => {
    const openSpots = this.openTeamSpots();

    if (openSpots === 0) {
      return 'League is full';
    }

    return `${openSpots} open ${openSpots === 1 ? 'spot' : 'spots'}`;
  });

  readonly draftStatusLabel = computed(() => {
    const draft = this.draft();
    const scheduledStart = this.scheduledStartDate();

    if (!draft || !scheduledStart) {
      return 'Draft Not Scheduled';
    }

    if (draft.status === 'live') {
      return 'Draft Live';
    }

    if (draft.status === 'complete') {
      return 'Draft Complete';
    }

    if (this.startTimeReached()) {
      return draft.serverDraftReadinessStatus === 'ready'
        ? 'Opening Draft'
        : 'Draft Start Delayed';
    }

    if (this.isDraftLobbyOpen()) {
      return 'Draft Lobby Open';
    }

    return 'Draft Scheduled';
  });

  readonly draftStatusDescription = computed(() => {
    const draft = this.draft();
    const scheduledStart = this.scheduledStartDate();

    if (!draft || !scheduledStart) {
      return 'The commissioner has not selected a draft date and time yet.';
    }

    if (draft.status === 'live') {
      return 'The draft is currently in progress.';
    }

    if (draft.status === 'complete') {
      return 'All draft picks have been completed.';
    }

    if (this.startTimeReached()) {
      return draft.serverDraftReadinessStatus === 'ready'
        ? 'The exact server start is opening the live Draft now.'
        : 'The server did not verify the Draft board before zero, so the clock remains safely stopped while automatic retry continues.';
    }

    if (this.isDraftLobbyOpen()) {
      return 'The read-only Draft lobby is open. Review rankings and order, and prepare your private queue before picks begin.';
    }

    return 'The read-only Draft lobby opens one hour before the scheduled start.';
  });

  readonly countdownText = computed(() => {
    const draft = this.draft();
    const startDate = this.scheduledStartDate();

    if (!startDate) {
      return 'No countdown available.';
    }

    if (draft?.status === 'live') {
      return 'Picks are currently being made.';
    }

    if (draft?.status === 'complete') {
      return 'All picks are complete.';
    }

    const millisecondsRemaining = startDate.getTime() - this.now();

    if (millisecondsRemaining <= 0) {
      return 'Opening live draft...';
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
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    void this.platformAdminService.refreshAccess();
    this.loadLeague();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.countdownTimer);
    clearInterval(this.scheduledDraftCheckTimer);

    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
    }

    if (this.draftEntryRecoveryTimer) {
      clearTimeout(this.draftEntryRecoveryTimer);
    }

    this.stopDraftListener?.();
    this.stopTeamListener?.();
    this.stopCycleListener?.();
    this.stopMatchupsListener?.();
    this.stopCurrentOwnerMatchupListener?.();
    this.stopInjurySyncListener?.();
  }

  async loadLeague(): Promise<void> {
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
      startPlayerAvailabilityListenerForLeague(leagueId);
      this.isCommissioner.set(league.commissionerId === user.uid);

      this.stopInjurySyncListener?.();
      this.stopInjurySyncListener = listenToPlayerAvailabilitySyncState(leagueId, (state) => {
        this.injurySyncState.set(state);
      });

      if (this.isCommissioner()) {
        void this.requestTodayInjuryRefresh();
      }

      this.stopDraftListener?.();
      this.stopTeamListener?.();
      this.stopCycleListener?.();
      this.stopMatchupsListener?.();
      this.stopCurrentOwnerMatchupListener?.();

      this.stopDraftListener = listenToFantasyDraft(leagueId, (draft) => {
        this.draft.set(draft);
        void this.runScheduledDraftChecks();
      });

      this.stopTeamListener = listenToLeagueTeams(leagueId, (teams) => {
        this.teams.set(teams);

        if (!this.renameTeamOpen()) {
          this.teamNameDraft = this.myTeam()?.teamName ?? '';
        }

        void this.runScheduledDraftChecks();
      });

      this.stopCycleListener = listenToLatestCycle(leagueId, (cycle) => {
        this.cycle.set(cycle);
        this.listenToCurrentCycleMatchups(cycle);
      });

      this.stopCurrentOwnerMatchupListener = listenToEarliestUnfinishedOwnerMatchup(
        leagueId,
        user.uid,
        (matchup) => {
          this.currentOwnerMatchup.set(matchup);
        },
        (error) => {
          console.warn('Unable to resolve the current owner matchup.', error);
        },
      );
    } catch (error: unknown) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to load this league.');
    } finally {
      this.loading.set(false);
    }
  }

  memberRemovalAvailabilityMessage(): string {
    if (this.cycle()) {
      return 'Competition has started. Existing teams and history must remain intact.';
    }

    if (this.league()?.joinStatus === 'locked' || this.draft()?.status === 'scheduled') {
      return 'Membership locked when Draft setup was saved. Existing teams cannot be deleted.';
    }

    if (this.draft()?.status === 'live' || this.draft()?.status === 'complete') {
      return 'The Draft has started. Existing teams, picks, and competition history must remain intact.';
    }

    if ((this.draft()?.roundOneOrder.length ?? 0) > 0) {
      return 'Draft order has been saved. Existing teams cannot be deleted.';
    }

    return 'Member removal is unavailable until League HQ finishes loading current authority.';
  }

  openMemberRemoval(team: FantasyTeam, event: Event): void {
    if (this.memberRemovalInProgress()) {
      return;
    }

    this.memberRemovalMessage.set('');
    this.memberRemovalError.set('');

    if (!this.preDraftMemberRemovalAvailable()) {
      this.memberRemovalError.set(this.memberRemovalAvailabilityMessage());
      return;
    }

    if (team.ownerId === this.userId) {
      this.memberRemovalError.set('The commissioner cannot remove their own team.');
      return;
    }

    this.memberRemovalReturnFocus = event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : null;
    this.memberRemovalTarget.set(team);
    this.memberRemovalTeamNameDraft = '';
    this.memberRemovalPasswordDraft = '';

    window.setTimeout(() => {
      if (!this.destroyed) {
        this.memberRemovalTeamNameInput?.nativeElement.focus();
      }
    });
  }

  closeMemberRemoval(): void {
    if (this.memberRemovalInProgress()) {
      return;
    }

    const returnFocus = this.memberRemovalReturnFocus;
    this.memberRemovalTarget.set(null);
    this.memberRemovalTeamNameDraft = '';
    this.memberRemovalPasswordDraft = '';
    this.memberRemovalError.set('');
    this.memberRemovalReturnFocus = null;

    window.setTimeout(() => returnFocus?.focus());
  }

  canConfirmMemberRemoval(): boolean {
    const target = this.memberRemovalTarget();

    return Boolean(
      target &&
      this.preDraftMemberRemovalAvailable() &&
      this.memberRemovalTeamNameDraft.trim() === target.teamName &&
      this.memberRemovalPasswordDraft.length > 0 &&
      this.clientHealth.competitiveActionsReady() &&
      !this.memberRemovalInProgress(),
    );
  }

  async confirmMemberRemoval(): Promise<void> {
    const target = this.memberRemovalTarget();

    if (!target || !this.leagueId || !this.isCommissioner()) {
      this.memberRemovalError.set('Choose a current league member before continuing.');
      return;
    }

    if (!this.preDraftMemberRemovalAvailable()) {
      this.memberRemovalError.set(this.memberRemovalAvailabilityMessage());
      return;
    }

    if (!this.clientHealth.competitiveActionsReady()) {
      this.memberRemovalError.set(this.clientHealth.competitiveActionBlockReason());
      return;
    }

    if (this.memberRemovalTeamNameDraft.trim() !== target.teamName) {
      this.memberRemovalError.set(`Type “${target.teamName}” exactly before removing this member.`);
      return;
    }

    if (!this.memberRemovalPasswordDraft) {
      this.memberRemovalError.set('Enter your current password before removing this member.');
      return;
    }

    if (!this.teams().some((team) => team.ownerId === target.ownerId)) {
      this.memberRemovalError.set('This member is no longer in the league. Refresh League HQ.');
      return;
    }

    this.memberRemovalError.set('');
    this.memberRemovalMessage.set('');
    this.memberRemovalInProgress.set(true);

    try {
      await reauthenticateCurrentUserWithPassword(this.memberRemovalPasswordDraft);
      this.memberRemovalPasswordDraft = '';
      const result = await removeLeagueMemberBeforeDraft({
        leagueId: this.leagueId,
        targetOwnerId: target.ownerId,
        confirmationTeamName: this.memberRemovalTeamNameDraft,
      });

      if (this.destroyed) {
        return;
      }

      this.league.update((league) => league
        ? {
            ...league,
            teamCount: result.teamCount,
            joinStatus: result.joinStatus,
            joinLockedAt: result.joinStatus === 'open' ? null : league.joinLockedAt,
            joinLockedReason: result.joinStatus === 'open' ? null : league.joinLockedReason,
          }
        : league);
      this.memberRemovalTarget.set(null);
      this.memberRemovalTeamNameDraft = '';
      this.memberRemovalReturnFocus = null;
      this.memberRemovalMessage.set(
        `${result.removedTeamName} was removed. The league now has ${result.teamCount} of ${result.maxTeams} teams.`,
      );

      window.setTimeout(() => {
        if (!this.destroyed) {
          this.memberRemovalStatus?.nativeElement.focus();
        }
      });
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.memberRemovalError.set(
          error instanceof Error
            ? error.message
            : 'The member could not be removed. No league data was changed.',
        );
      }
    } finally {
      if (!this.destroyed) {
        this.memberRemovalInProgress.set(false);
      }
    }
  }

  toggleDeleteLeaguePanel(): void {
    if (this.deleteLeagueInProgress()) {
      return;
    }

    const nextOpen = !this.deleteLeaguePanelOpen();
    this.deleteLeaguePanelOpen.set(nextOpen);
    this.deleteLeagueError.set('');

    if (!nextOpen) {
      this.deleteLeagueNameDraft = '';
      this.deleteLeaguePasswordDraft = '';
    }
  }

  canDeleteLeague(): boolean {
    const currentLeagueName = this.league()?.name ?? '';

    return Boolean(
      this.isCommissioner() &&
      currentLeagueName &&
      this.deleteLeagueNameDraft.trim() === currentLeagueName &&
      this.deleteLeaguePasswordDraft.length > 0 &&
      !this.deleteLeagueInProgress()
    );
  }

  async permanentlyDeleteLeague(): Promise<void> {
    const currentLeague = this.league();

    if (!currentLeague || !this.leagueId || !this.isCommissioner()) {
      this.deleteLeagueError.set(
        'Only the league commissioner can permanently delete this league.',
      );
      return;
    }

    if (this.deleteLeagueNameDraft.trim() !== currentLeague.name) {
      this.deleteLeagueError.set(
        `Type “${currentLeague.name}” exactly before deleting the league.`,
      );
      return;
    }

    if (!this.deleteLeaguePasswordDraft) {
      this.deleteLeagueError.set('Enter your current password before deleting the league.');
      return;
    }

    this.deleteLeagueError.set('');
    this.deleteLeagueInProgress.set(true);

    try {
      await reauthenticateCurrentUserWithPassword(this.deleteLeaguePasswordDraft);
      this.deleteLeaguePasswordDraft = '';
      await deleteLeaguePermanently(this.leagueId, this.deleteLeagueNameDraft);

      this.stopDraftListener?.();
      this.stopTeamListener?.();
      this.stopCycleListener?.();
      this.stopMatchupsListener?.();
      this.stopCurrentOwnerMatchupListener?.();
      this.stopInjurySyncListener?.();

      forgetRememberedLastLeagueId(this.leagueId);

      await this.router.navigate(['/dashboard'], {
        replaceUrl: true,
        state: { deletedLeagueName: currentLeague.name },
      });
    } catch (error: unknown) {
      this.deleteLeagueError.set(
        error instanceof Error
          ? error.message
          : 'The league could not be deleted. Please try again.',
      );
      this.deleteLeagueInProgress.set(false);
    }
  }

  openProfileIconPicker(): void {
    this.renameTeamOpen.set(false);
    this.profileIconMessage.set('');
    this.profileIconError.set('');
    this.profileIconPickerOpen.set(true);
  }

  closeProfileIconPicker(): void {
    if (this.profileIconSaving()) {
      return;
    }

    this.profileIconPickerOpen.set(false);
    this.profileIconError.set('');
  }

  async selectLeagueProfileIcon(icon: ProfileIconOption): Promise<void> {
    if (this.profileIconSaving() || icon.id === this.selectedLeagueProfileIconId()) {
      return;
    }

    if (!this.leagueId || !this.userId) {
      this.profileIconError.set('Your league account is still loading.');
      return;
    }

    this.profileIconMessage.set('');
    this.profileIconError.set('');
    this.profileIconSaving.set(true);

    try {
      await updateLeagueProfileIcon(this.leagueId, icon.id);
      this.teams.update((teams) =>
        teams.map((team) =>
          team.ownerId === this.userId ? { ...team, profileIconId: icon.id } : team,
        ),
      );
      this.profileIconMessage.set(`${icon.label} is now your icon in this league.`);
      this.profileIconPickerOpen.set(false);

      setTimeout(() => {
        this.profileIconMessage.set('');
      }, 2600);
    } catch (error: unknown) {
      this.profileIconError.set(
        error instanceof Error ? error.message : 'Unable to update your league icon.',
      );
    } finally {
      this.profileIconSaving.set(false);
    }
  }

  openRenameTeam(): void {
    this.profileIconPickerOpen.set(false);
    this.teamNameDraft = this.myTeam()?.teamName ?? '';
    this.renameTeamMessage.set('');
    this.renameTeamError.set('');
    this.renameTeamOpen.set(true);
  }

  cancelRenameTeam(): void {
    this.teamNameDraft = this.myTeam()?.teamName ?? '';
    this.renameTeamMessage.set('');
    this.renameTeamError.set('');
    this.renameTeamOpen.set(false);
  }

  async saveMyTeamName(): Promise<void> {
    const updatedName = this.teamNameDraft.trim();

    this.renameTeamMessage.set('');
    this.renameTeamError.set('');

    if (!this.leagueId || !this.userId) {
      this.renameTeamError.set('Your league account is still loading.');
      return;
    }

    if (!updatedName) {
      this.renameTeamError.set('Please enter a team name.');
      return;
    }

    if (updatedName.length > 60) {
      this.renameTeamError.set('Team names must be 60 characters or fewer.');
      return;
    }

    this.renameTeamSaving.set(true);

    try {
      await updateTeamName(this.leagueId, this.userId, updatedName);

      this.teams.update((teams) =>
        teams.map((team) =>
          team.ownerId === this.userId ? { ...team, teamName: updatedName } : team,
        ),
      );

      this.teamNameDraft = updatedName;
      this.renameTeamOpen.set(false);
      this.renameTeamMessage.set('Team name updated.');

      setTimeout(() => {
        this.renameTeamMessage.set('');
      }, 2400);
    } catch (error: unknown) {
      this.renameTeamError.set(
        error instanceof Error ? error.message : 'Unable to update your team name.',
      );
    } finally {
      this.renameTeamSaving.set(false);
    }
  }

  getDailyInjuryStatusLabel(): string {
    const state = this.injurySyncState();

    if (this.dailyInjuryRefreshInProgress() || state?.status === 'running') {
      return 'Updating Today’s Report';
    }

    if (this.dailyInjuryRefreshError()) {
      return 'Using Last Saved Report';
    }

    if (state?.lastDailySyncKey && state.lastDailySyncKey === this.getUtcDailyKey()) {
      return 'Updated Today';
    }

    if (state?.lastSuccessfulSyncAt) {
      return 'Last Saved Report';
    }

    return 'Waiting for First Update';
  }

  getDailyInjuryStatusDescription(): string {
    if (this.dailyInjuryRefreshInProgress()) {
      return 'The secure server is checking whether today’s app-wide ESPN injury report is already current.';
    }

    if (this.dailyInjuryRefreshError()) {
      return this.dailyInjuryRefreshError();
    }

    if (this.dailyInjuryRefreshMessage()) {
      return this.dailyInjuryRefreshMessage();
    }

    const state = this.injurySyncState();

    if (state?.status === 'running') {
      return 'Today’s shared injury refresh is already running.';
    }

    if (state?.status === 'error') {
      return (
        state.message ||
        'Today’s refresh failed. The most recent saved injury report is still being used.'
      );
    }

    if (state?.lastSuccessfulSyncAt) {
      return 'The single shared injury report is available to every league and manager in the app.';
    }

    return 'The first league visit each UTC day refreshes one shared report for the entire app.';
  }

  getUtcDailyKey(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10);
  }

  async requestTodayInjuryRefresh(): Promise<void> {
    if (!this.leagueId || !this.isCommissioner() || this.dailyInjuryRefreshInProgress()) {
      return;
    }

    this.dailyInjuryRefreshInProgress.set(true);
    this.dailyInjuryRefreshError.set('');
    this.dailyInjuryRefreshMessage.set('Checking the single app-wide injury report for today.');

    try {
      const result = await syncPlayerAvailabilityFromEspn({
        leagueId: this.leagueId,
        trigger: 'daily-visit',
      });

      this.dailyInjuryRefreshMessage.set(
        result.skipped
          ? result.message
          : `Today’s app-wide injury report is ready. ${result.matchedCount} injured skaters were matched.`,
      );
    } catch (error: unknown) {
      this.dailyInjuryRefreshMessage.set('');
      this.dailyInjuryRefreshError.set(
        error instanceof Error
          ? `Today’s refresh could not run: ${error.message} The last saved report remains available.`
          : 'Today’s injury refresh could not run. The last saved report remains available.',
      );
    } finally {
      this.dailyInjuryRefreshInProgress.set(false);
    }
  }

  getDraftInjurySyncStatusLabel(): string {
    if (this.injurySyncState()?.status === 'running') {
      return 'Refreshing Now';
    }

    if (this.injurySyncState()?.status === 'success') {
      return 'Report Ready';
    }

    if (this.injurySyncState()?.status === 'error') {
      return 'Using Last Saved Report';
    }

    return 'Waiting for First Sync';
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
      return (
        state.message ||
        'The last refresh failed, so the most recent saved report will remain available.'
      );
    }

    return `The server checks the shared daily injury report and prepares league rankings ${PRE_DRAFT_PROJECTION_WARMUP_MINUTES} minutes before the scheduled start.`;
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
      timeStyle: 'short',
    })}`;
  }

  async enterDraftRoom(): Promise<void> {
    if (this.hasEnteredDraftRoom) {
      return;
    }

    if (this.draftEntryInProgress()) {
      this.draftEntryRecoveryVisible.set(true);
      return;
    }

    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
      this.redirectTimer = null;
    }

    this.draftEntryInProgress.set(true);
    this.draftEntryError.set('');
    this.scheduleDraftEntryRecovery();

    let navigationTimeout: ReturnType<typeof setTimeout> | null = null;

    try {
      const navigationSucceeded = await Promise.race([
        this.router.navigate(['/leagues', this.leagueId, 'draft']),
        new Promise<boolean>((resolve) => {
          navigationTimeout = setTimeout(
            () => resolve(false),
            DRAFT_ROOM_NAVIGATION_TIMEOUT_MILLISECONDS,
          );
        }),
      ]);

      if (navigationSucceeded) {
        this.hasEnteredDraftRoom = true;
        this.showDraftStartedModal.set(false);
        this.clearDraftEntryRecoveryTimer();
        return;
      }

      this.draftEntryError.set(
        'The Draft Room did not open. Try again or use the reload option below.',
      );
      this.draftEntryRecoveryVisible.set(true);
    } catch (error: unknown) {
      this.draftEntryError.set(
        error instanceof Error
          ? `The Draft Room could not open: ${error.message}`
          : 'The Draft Room could not open. Try again or reload directly into it.',
      );
      this.draftEntryRecoveryVisible.set(true);
    } finally {
      if (navigationTimeout) {
        clearTimeout(navigationTimeout);
      }
      this.draftEntryInProgress.set(false);
    }
  }

  async reloadIntoDraftRoom(): Promise<void> {
    if (this.hasEnteredDraftRoom || this.draftEntryInProgress()) {
      return;
    }

    this.draftEntryInProgress.set(true);
    this.draftEntryError.set('');
    this.clearDraftEntryTimers();

    const draftUrl = this.router.serializeUrl(
      this.router.createUrlTree(['/leagues', this.leagueId, 'draft']),
    );

    if (typeof window !== 'undefined') {
      try {
        window.location.assign(draftUrl);
        return;
      } catch (error: unknown) {
        this.draftEntryInProgress.set(false);
        this.draftEntryError.set(
          error instanceof Error
            ? `The Draft Room reload was blocked: ${error.message}`
            : 'The Draft Room reload was blocked. Try opening it again.',
        );
        this.draftEntryRecoveryVisible.set(true);
        return;
      }
    }

    const navigationSucceeded = await this.router.navigateByUrl(draftUrl);

    if (!navigationSucceeded) {
      this.draftEntryInProgress.set(false);
      this.draftEntryError.set('The Draft Room still could not open. Refresh this page once.');
      this.draftEntryRecoveryVisible.set(true);
    }
  }

  formatDraftStart(): string {
    const startDate = this.scheduledStartDate();

    if (!startDate) {
      return 'Not scheduled';
    }

    return startDate.toLocaleString(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
    });
  }

  async copyInviteLink(): Promise<void> {
    const inviteUrl = buildLeagueInviteUrl(this.league()?.inviteCode);

    if (!inviteUrl) {
      return;
    }

    await this.copyInviteText(inviteUrl, 'Invite link copied!');
  }

  async copyInviteCode(): Promise<void> {
    const code = this.league()?.inviteCode;

    if (!code) {
      return;
    }

    await this.copyInviteText(code, 'Invite code copied!');
  }

  private async copyInviteText(value: string, successMessage: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = value;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        textArea.remove();
      }

      this.copyMessage.set(successMessage);
    } catch {
      this.copyMessage.set('Copy failed. Select and copy the league code manually.');
    }

    setTimeout(() => {
      this.copyMessage.set('');
    }, 2500);
  }

  getTeamName(ownerId: string | null): string {
    if (!ownerId) {
      return 'Bye';
    }

    return this.teams().find((team) => team.ownerId === ownerId)?.teamName ?? 'Unknown Team';
  }

  getTeamRecord(team: FantasyTeam | null | undefined): string {
    if (!team) {
      return '0-0-0';
    }

    return `${team.wins ?? 0}-${team.losses ?? 0}-${team.ties ?? 0}`;
  }

  getWinPercentage(team: FantasyTeam): string {
    return this.getWinPercentageValue(team).toFixed(3).replace(/^0/, '');
  }

  getPointDifferential(team: FantasyTeam): number {
    return Number(((team.pointsFor ?? 0) - (team.pointsAgainst ?? 0)).toFixed(1));
  }

  getSignedDisplayNumber(value: number): string {
    const rounded = value.toFixed(1);

    return value > 0 ? `+${rounded}` : rounded;
  }

  getDisplayNumber(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '0.0';
    }

    return value.toFixed(1);
  }

  getCurrentOwnerMatchupLink(): Array<string | number> {
    const matchup = this.currentOwnerMatchup();

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

    return ['/leagues', this.leagueId, 'cycles', this.currentCycleNumber()];
  }

  getCurrentCycleStatusLabel(): string {
    const cycle = this.cycle();

    if (cycle?.status === 'complete') {
      return 'Complete';
    }

    if (cycle?.status === 'active') {
      return 'Active';
    }

    if (this.draft()?.status === 'complete') {
      return 'Preparing';
    }

    return 'Locked';
  }

  getCurrentCycleDescription(): string {
    const cycle = this.cycle();

    if (cycle?.status === 'complete') {
      return cycle.phase === 'playoffs'
        ? `${this.currentCycleLabel()} is complete. Open the playoff bracket to see the updated path and final placements.`
        : `${this.currentCycleLabel()} is complete. The next matchup period will open automatically when the league flow continues.`;
    }

    if (cycle?.status === 'active') {
      return `${this.currentCycleLabel()} is active. Matchups are ready for scoring.`;
    }

    if (this.draft()?.status === 'complete') {
      return 'The draft is complete. The server is creating Matchup 1 and the opening schedule automatically.';
    }

    return 'Finish the draft before starting the fantasy season.';
  }

  getMatchupScore(matchup: FantasyMatchup, ownerId: string | null): number {
    if (!ownerId) {
      return 0;
    }

    if (ownerId === matchup.teamAOwnerId) {
      return matchup.teamAScore;
    }

    if (ownerId === matchup.teamBOwnerId) {
      return matchup.teamBScore;
    }

    return 0;
  }

  getMatchupResultLabel(matchup: FantasyMatchup): string {
    if (matchup.status !== 'complete') {
      return 'Live';
    }

    if (!matchup.winnerOwnerId) {
      return 'Tie';
    }

    if (matchup.tieBrokenByHigherSeed) {
      return `${this.getTeamName(matchup.winnerOwnerId)} advanced on seed`;
    }

    return `${this.getTeamName(matchup.winnerOwnerId)} won`;
  }

  shouldShowSeasonStartCard(): boolean {
    return this.draft()?.status === 'complete' && !this.cycle();
  }

  private listenToCurrentCycleMatchups(cycle: FantasyCycle | null): void {
    this.stopMatchupsListener?.();
    this.stopMatchupsListener = null;

    if (!cycle) {
      this.matchups.set([]);
      return;
    }

    this.stopMatchupsListener = listenToCycleMatchups(
      this.leagueId,
      cycle.cycleNumber,
      (matchups) => {
        this.matchups.set(matchups);
      },
    );
  }

  private getWinPercentageValue(team: FantasyTeam): number {
    const wins = team.wins ?? 0;
    const losses = team.losses ?? 0;
    const ties = team.ties ?? 0;
    const gamesPlayed = wins + losses + ties;

    if (gamesPlayed <= 0) {
      return 0;
    }

    return (wins + ties * 0.5) / gamesPlayed;
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
      await this.handleScheduledDraft();
    } finally {
      this.scheduledDraftCheckInProgress = false;
    }
  }

  private async handleScheduledDraft(): Promise<void> {
    const draft = this.draft();

    if (!draft || this.hasEnteredDraftRoom) {
      return;
    }

    if (draft.status === 'live') {
      this.openDraftStartedModal();
      return;
    }

    if (draft.status !== 'scheduled' || !isDraftStartTimeReached(draft)) {
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
      const activatedDraft = await activateScheduledDraftIfReady(
        this.leagueId,
        auth.currentUser?.uid,
      );

      if (activatedDraft?.status === 'live') {
        this.activationFailureCount = 0;
        this.activationRetryNotBefore = 0;
        this.draft.set(activatedDraft);
        this.openDraftStartedModal();
      }
    } catch (error: unknown) {
      this.activationFailureCount += 1;

      const retryDelayMilliseconds = Math.min(
        5 * 60_000,
        15_000 * 2 ** Math.max(0, this.activationFailureCount - 1),
      );

      this.activationRetryNotBefore = Date.now() + retryDelayMilliseconds;

      const detail = error instanceof Error ? error.message : 'Unable to open the scheduled draft.';
      const retrySeconds = Math.ceil(retryDelayMilliseconds / 1000);

      this.errorMessage.set(
        `${detail} The next activation check will wait about ${retrySeconds} seconds.`,
      );
    } finally {
      this.activationInProgress = false;
    }
  }

  private openDraftStartedModal(): void {
    if (this.hasEnteredDraftRoom) {
      return;
    }

    this.showDraftStartedModal.set(true);
    this.scheduleDraftEntryRecovery();

    if (this.redirectTimer) {
      return;
    }

    this.redirectTimer = setTimeout(() => {
      this.redirectTimer = null;
      void this.enterDraftRoom();
    }, 2500);
  }

  private scheduleDraftEntryRecovery(): void {
    if (this.draftEntryRecoveryTimer || this.draftEntryRecoveryVisible()) {
      return;
    }

    this.draftEntryRecoveryTimer = setTimeout(() => {
      this.draftEntryRecoveryTimer = null;

      if (!this.hasEnteredDraftRoom) {
        this.draftEntryRecoveryVisible.set(true);
      }
    }, DRAFT_ENTRY_RECOVERY_DELAY_MILLISECONDS);
  }

  private clearDraftEntryRecoveryTimer(): void {
    if (!this.draftEntryRecoveryTimer) {
      return;
    }

    clearTimeout(this.draftEntryRecoveryTimer);
    this.draftEntryRecoveryTimer = null;
  }

  private clearDraftEntryTimers(): void {
    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
      this.redirectTimer = null;
    }

    this.clearDraftEntryRecoveryTimer();
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
