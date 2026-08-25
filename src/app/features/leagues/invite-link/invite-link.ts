import { Component, computed, HostListener, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { User } from 'firebase/auth';

import { waitForAuthState } from '../../../core/auth/auth-session.service';
import { logoutUser } from '../../../core/auth/auth.service';
import { auth } from '../../../core/firebase';
import {
  bindPendingLeagueInviteToAccount,
  clearPendingLeagueInvite,
  isValidLeagueInviteCode,
  markPendingLeagueInviteRequiresTrainingCamp,
  markPendingLeagueInviteTrainingCampComplete,
  normalizeLeagueInviteCode,
  pendingLeagueInviteAccountMatch,
  readPendingLeagueInvite,
  resolveLeagueInviteContinuationStep,
  startPendingLeagueInvite,
  unbindPendingLeagueInviteAccount,
} from '../../../core/league/invite-link-intent.service';
import { joinLeagueByInviteCode } from '../../../core/league/league.service';
import {
  getVerificationEmailState,
  requestVerificationEmail,
  type VerificationEmailResponse,
} from '../../../core/notifications/email-notification.service';
import {
  getVerificationCooldownSeconds,
  getVerificationSendButtonLabel,
} from '../../../core/notifications/verification-email-state.util';
import { hasResolvedTrainingCampOnboarding } from '../../../core/onboarding/training-camp.service';
import { TelemetryService } from '../../../core/observability/telemetry.service';
import { TeamIdentityChallengeService } from '../../../core/user/team-identity-challenge.service';
import { getUserProfile } from '../../../core/user/user.service';
import { Navbar } from '../../../shared/navbar/navbar';

export type LeagueInviteLinkStage =
  | 'loading'
  | 'ready'
  | 'sign-in'
  | 'account-mismatch'
  | 'training-camp'
  | 'verification'
  | 'joining'
  | 'error'
  | 'invalid';

@Component({
  selector: 'app-league-invite-link',
  standalone: true,
  imports: [RouterLink, Navbar],
  templateUrl: './invite-link.html',
  styleUrl: './invite-link.css',
})
export class LeagueInviteLink implements OnDestroy {
  readonly stage = signal<LeagueInviteLinkStage>('loading');
  readonly errorMessage = signal('');
  readonly statusMessage = signal('');
  readonly verificationEmail = signal('');
  readonly sendingVerification = signal(false);
  readonly refreshingVerification = signal(false);
  readonly verificationEmailPreviouslySent = signal(false);
  readonly verificationEmailEligible = signal(false);
  readonly verificationCooldownSeconds = signal(0);
  readonly inviteCode = signal('');
  readonly verificationSendButtonLabel = computed(() =>
    getVerificationSendButtonLabel({
      sending: this.sendingVerification(),
      emailPreviouslySent: this.verificationEmailPreviouslySent(),
      cooldownSeconds: this.verificationCooldownSeconds(),
    }),
  );
  readonly verificationSendDisabled = computed(() =>
    this.sendingVerification() ||
    this.refreshingVerification() ||
    !this.verificationEmailEligible() ||
    this.verificationCooldownSeconds() > 0,
  );

  private currentUser: User | null = null;
  private flowInProgress = false;
  private destroyed = false;
  private lastAutomaticVerificationRefreshAt = 0;
  private verificationNextAllowedAtMillis = 0;
  private verificationCooldownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly telemetry: TelemetryService,
    private readonly challengeService: TeamIdentityChallengeService,
  ) {
    const inviteCode = normalizeLeagueInviteCode(
      this.route.snapshot.paramMap.get('inviteCode'),
    );
    this.inviteCode.set(inviteCode);

    if (!isValidLeagueInviteCode(inviteCode)) {
      this.stage.set('invalid');
      this.errorMessage.set(
        'This invitation link is incomplete or invalid. Ask the commissioner for a new link or six-character invite code.',
      );
      return;
    }

    void this.initialize();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearVerificationCooldownTimer();
  }

  @HostListener('window:focus')
  handleWindowFocus(): void {
    void this.refreshVerificationStatus(false);
  }

  @HostListener('document:visibilitychange')
  handleVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void this.refreshVerificationStatus(false);
    }
  }

  hasStoredIntent(): boolean {
    return Boolean(readPendingLeagueInvite(this.inviteCode()));
  }

  async beginJoin(): Promise<void> {
    if (this.flowInProgress || this.stage() === 'invalid') {
      return;
    }

    this.errorMessage.set('');
    this.statusMessage.set('');

    const user = await waitForAuthState(undefined, 8_000);
    const intent = startPendingLeagueInvite(this.inviteCode(), {
      accountUid: user?.uid ?? null,
    });

    if (!intent) {
      this.stage.set('invalid');
      this.errorMessage.set('This invitation code is invalid.');
      return;
    }

    this.telemetry.track('league_invite_intent_started', {
      signed_in: Boolean(user),
    });

    if (!user) {
      this.stage.set('sign-in');
      await this.openAuthentication();
      return;
    }

    this.currentUser = user;
    await this.resumePendingInvite();
  }

  async openAuthentication(): Promise<void> {
    await this.router.navigate(['/'], {
      queryParams: { invite: '1' },
    });
  }

  async joinWithCurrentAccount(): Promise<void> {
    const user = this.currentUser ?? (await waitForAuthState(undefined, 8_000));

    if (!user) {
      await this.openAuthentication();
      return;
    }

    const rebound = bindPendingLeagueInviteToAccount(user.uid, {
      inviteCode: this.inviteCode(),
      allowAccountSwitch: true,
    });

    if (!rebound) {
      this.errorMessage.set('The pending invitation could not be restored. Open the invite link again.');
      this.stage.set('error');
      return;
    }

    this.currentUser = user;
    await this.resumePendingInvite();
  }

  async useAnotherAccount(): Promise<void> {
    unbindPendingLeagueInviteAccount(this.inviteCode());

    try {
      await logoutUser();
    } finally {
      this.currentUser = null;
      await this.openAuthentication();
    }
  }

  async continueTrainingCamp(): Promise<void> {
    await this.router.navigate(['/training-camp'], {
      queryParams: { continue: 'league-invite' },
    });
  }

  async sendVerificationEmail(): Promise<void> {
    if (this.verificationSendDisabled()) {
      return;
    }

    this.errorMessage.set('');
    this.statusMessage.set('');
    this.sendingVerification.set(true);

    try {
      const result = await requestVerificationEmail();

      if (result.alreadyVerified) {
        this.statusMessage.set('Your email is verified. Joining the league now...');
        await this.refreshVerificationStatus(true);
        return;
      }

      this.applyVerificationEmailState(result);

      if (result.outcome === 'cooldown') {
        this.statusMessage.set(
          'A verification email was sent recently. You can send another when the countdown finishes.',
        );
      } else if (result.outcome === 'blocked') {
        this.errorMessage.set(
          'Finish Training Camp or choose Finish Later before sending the verification email.',
        );
      } else {
        this.statusMessage.set(
          `${result.firstSend ? 'Verification email sent.' : 'Another verification email sent.'} Check your inbox and spam folder, open the link, then return to this page.`,
        );
      }
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to send a verification email right now.',
      );
    } finally {
      this.sendingVerification.set(false);
    }
  }

  async refreshVerificationStatus(force = true): Promise<void> {
    if (this.stage() !== 'verification' || this.refreshingVerification()) {
      return;
    }

    const now = Date.now();

    if (!force && now - this.lastAutomaticVerificationRefreshAt < 5_000) {
      return;
    }

    this.lastAutomaticVerificationRefreshAt = now;
    const user = this.currentUser ?? auth.currentUser;

    if (!user) {
      this.stage.set('sign-in');
      return;
    }

    this.errorMessage.set('');
    this.refreshingVerification.set(true);

    try {
      await user.reload();

      if (!user.emailVerified) {
        if (force) {
          this.statusMessage.set(
            'Verification is not visible yet. Open the email link, then try again.',
          );
        }
        return;
      }

      await user.getIdToken(true);
      this.currentUser = user;
      this.statusMessage.set('Email verified. Checking your saved invitation...');
      await this.resumePendingInvite();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not refresh your verification status.',
      );
    } finally {
      this.refreshingVerification.set(false);
    }
  }

  async retry(): Promise<void> {
    await this.resumePendingInvite();
  }

  async cancelInvite(): Promise<void> {
    clearPendingLeagueInvite(this.inviteCode());
    this.telemetry.track('league_invite_intent_cancelled');

    const user = auth.currentUser;
    await this.router.navigate(user ? ['/dashboard'] : ['/']);
  }

  private async initialize(): Promise<void> {
    const intent = readPendingLeagueInvite(this.inviteCode());

    if (!intent) {
      this.stage.set('ready');
      return;
    }

    await this.resumePendingInvite();
  }

  private async resumePendingInvite(): Promise<void> {
    if (this.flowInProgress || this.destroyed) {
      return;
    }

    const intent = readPendingLeagueInvite(this.inviteCode());

    if (!intent) {
      this.stage.set('ready');
      return;
    }

    this.flowInProgress = true;
    this.errorMessage.set('');

    try {
      const user = await waitForAuthState(undefined, 8_000);
      this.currentUser = user;

      if (!user) {
        this.stage.set('sign-in');
        return;
      }

      const accountMatch = pendingLeagueInviteAccountMatch(intent, user.uid);

      if (accountMatch === 'mismatch') {
        this.stage.set('account-mismatch');
        return;
      }

      if (accountMatch === 'unbound') {
        const bound = bindPendingLeagueInviteToAccount(user.uid, {
          inviteCode: this.inviteCode(),
        });

        if (!bound) {
          throw new Error('The invitation could not be connected to this account.');
        }
      }

      const profile = await getUserProfile(user.uid);
      const trainingCampResolved = hasResolvedTrainingCampOnboarding(profile);

      if (!user.emailVerified) {
        try {
          await user.reload();

          if (user.emailVerified) {
            await user.getIdToken(true);
          }
        } catch {
          // A manual refresh remains available on the verification screen.
        }
      }

      const continuationStep = resolveLeagueInviteContinuationStep({
        trainingCampResolved,
        emailVerified: user.emailVerified,
      });

      if (continuationStep === 'training-camp') {
        const marked = markPendingLeagueInviteRequiresTrainingCamp(
          user.uid,
          this.inviteCode(),
        );

        if (!marked) {
          throw new Error('The invitation could not save your Training Camp step.');
        }

        this.stage.set('training-camp');
        await this.continueTrainingCamp();
        return;
      }

      const activeIntent = readPendingLeagueInvite(this.inviteCode());
      if (activeIntent?.requiresTrainingCamp) {
        markPendingLeagueInviteTrainingCampComplete(user.uid, this.inviteCode());
      }

      if (continuationStep === 'email-verification') {
        this.verificationEmail.set(user.email ?? 'your account email');
        this.verificationEmailEligible.set(true);
        this.statusMessage.set('');
        this.stage.set('verification');
        void this.loadVerificationEmailState();
        return;
      }

      await this.joinLeague(user, profile?.username ?? '');
    } catch (error: unknown) {
      this.stage.set('error');
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not continue this invitation.',
      );
    } finally {
      this.flowInProgress = false;
    }
  }

  private async joinLeague(user: User, knownUsername = ''): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.stage.set('joining');
    this.errorMessage.set('');

    try {
      const profile = knownUsername ? null : await getUserProfile(user.uid);
      const username = knownUsername || profile?.username || user.email || 'Unknown User';
      const leagueId = await joinLeagueByInviteCode(this.inviteCode(), username);

      clearPendingLeagueInvite(this.inviteCode());
      this.telemetry.track('league_invite_joined', {
        continuation: true,
      });
      void this.challengeService.refresh(user.uid, { force: true });
      await this.router.navigate(['/leagues', leagueId]);
    } catch (error: unknown) {
      const message = this.friendlyJoinError(error);

      if (this.isTerminalJoinFailure(message)) {
        clearPendingLeagueInvite(this.inviteCode());
      }

      this.telemetry.track('league_invite_join_failed', {
        terminal: this.isTerminalJoinFailure(message),
      });
      this.errorMessage.set(message);
      this.stage.set('error');
    }
  }

  private friendlyJoinError(error: unknown): string {
    const message = error instanceof Error ? error.message.trim() : '';
    return message || 'Unable to join the league right now. Check your connection and try again.';
  }

  private isTerminalJoinFailure(message: string): boolean {
    return /no league was found|no longer exists|no longer matches|invite has expired|invite is no longer active|league entry closed|league is full|at most \d+ active/i.test(
      message,
    );
  }

  private async loadVerificationEmailState(): Promise<void> {
    try {
      const state = await getVerificationEmailState();

      if (state.alreadyVerified) {
        this.statusMessage.set('Your email is verified. Joining the league now...');
        return;
      }

      this.applyVerificationEmailState(state);
    } catch {
      // The send button remains usable if the optional state lookup is interrupted.
    }
  }

  private applyVerificationEmailState(state: VerificationEmailResponse): void {
    this.verificationEmailEligible.set(state.eligible);
    this.verificationEmailPreviouslySent.set(state.emailPreviouslySent);
    this.verificationNextAllowedAtMillis = state.nextAllowedAtMillis;
    this.updateVerificationCooldown(state.cooldownSecondsRemaining);
  }

  private updateVerificationCooldown(fallbackSeconds = 0): void {
    this.clearVerificationCooldownTimer();

    if (this.verificationNextAllowedAtMillis <= 0 && fallbackSeconds > 0) {
      this.verificationNextAllowedAtMillis = Date.now() + fallbackSeconds * 1_000;
    }

    const update = () => {
      const remaining = getVerificationCooldownSeconds(
        this.verificationNextAllowedAtMillis,
      );
      this.verificationCooldownSeconds.set(remaining);

      if (remaining === 0) {
        this.verificationNextAllowedAtMillis = 0;
        this.clearVerificationCooldownTimer();
      }
    };

    update();

    if (this.verificationCooldownSeconds() > 0) {
      this.verificationCooldownTimer = setInterval(update, 1_000);
    }
  }

  private clearVerificationCooldownTimer(): void {
    if (this.verificationCooldownTimer) {
      clearInterval(this.verificationCooldownTimer);
      this.verificationCooldownTimer = null;
    }
  }
}
