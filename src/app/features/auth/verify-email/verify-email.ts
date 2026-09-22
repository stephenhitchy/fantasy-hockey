import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { applyActionCode, checkActionCode, type User } from 'firebase/auth';

import { waitForAuthState } from '../../../core/auth/auth-session.service';
import { logoutUser } from '../../../core/auth/auth.service';
import {
  normalizeEmailVerificationCode,
  normalizeEmailVerificationInvite,
  verificationEmailMatchesSession,
} from '../../../core/auth/email-verification-continuation.util';
import { auth } from '../../../core/firebase';
import {
  buildLeagueInvitePath,
  pendingLeagueInviteAccountMatch,
  readPendingLeagueInvite,
  startPendingLeagueInvite,
} from '../../../core/league/invite-link-intent.service';

type VerifyEmailStage =
  | 'verifying'
  | 'continuing'
  | 'sign-in'
  | 'account-mismatch'
  | 'verified'
  | 'error';

@Component({
  selector: 'app-verify-email',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './verify-email.html',
  styleUrl: './verify-email.css',
})
export class VerifyEmail {
  readonly stage = signal<VerifyEmailStage>('verifying');
  readonly errorMessage = signal('');
  readonly verifiedEmail = signal('');
  readonly inviteCode = signal('');

  private readonly actionCode: string;

  constructor(
    route: ActivatedRoute,
    private readonly router: Router,
  ) {
    this.actionCode = normalizeEmailVerificationCode(
      route.snapshot.queryParamMap.get('oobCode'),
    );
    this.inviteCode.set(
      normalizeEmailVerificationInvite(route.snapshot.queryParamMap.get('invite')),
    );

    // Remove the one-time code from the visible URL before any asynchronous
    // work so it cannot linger in browser history, screenshots, or referrers.
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '/verify-email');
    }

    void this.verifyAndContinue();
  }

  async continueToSignIn(): Promise<void> {
    if (auth.currentUser) {
      await logoutUser();
    }

    await this.router.navigate(['/'], {
      queryParams: this.inviteCode() ? { invite: '1' } : undefined,
      replaceUrl: true,
    });
  }

  async openVerifiedAccount(): Promise<void> {
    await this.router.navigate(auth.currentUser ? ['/dashboard'] : ['/'], {
      replaceUrl: true,
    });
  }

  private async verifyAndContinue(): Promise<void> {
    if (!this.actionCode) {
      this.stage.set('error');
      this.errorMessage.set(
        'This verification link is incomplete. Return to RinkRat and send a new email.',
      );
      return;
    }

    try {
      const actionInfo = await checkActionCode(auth, this.actionCode);
      const actionEmail = actionInfo.data.email?.trim() ?? '';

      await applyActionCode(auth, this.actionCode);
      this.verifiedEmail.set(actionEmail);
      await this.continueAfterVerification(actionEmail);
    } catch (error: unknown) {
      if (await this.resumeAlreadyVerifiedSession()) {
        return;
      }

      if (this.inviteCode() && this.isConsumedOrExpiredActionCode(error)) {
        this.preservePendingInvite();
        this.stage.set('sign-in');
        return;
      }

      this.stage.set('error');
      this.errorMessage.set(this.friendlyVerificationError(error));
    }
  }

  private async continueAfterVerification(actionEmail: string): Promise<void> {
    const user = await waitForAuthState(undefined, 5_000);
    const inviteCode = this.inviteCode();

    if (inviteCode) {
      this.preservePendingInvite(
        user && verificationEmailMatchesSession(actionEmail, user.email)
          ? user
          : null,
      );
    }

    if (!user) {
      this.stage.set('sign-in');
      return;
    }

    if (!verificationEmailMatchesSession(actionEmail, user.email)) {
      this.stage.set('account-mismatch');
      return;
    }

    await user.reload();
    await user.getIdToken(true);

    if (inviteCode) {
      await this.resumeLeagueInvite(inviteCode);
      return;
    }

    this.stage.set('verified');
  }

  private async resumeAlreadyVerifiedSession(): Promise<boolean> {
    const user = auth.currentUser ?? await waitForAuthState(undefined, 2_500);

    if (!user) {
      return false;
    }

    try {
      await user.reload();
    } catch {
      return false;
    }

    if (!user.emailVerified) {
      return false;
    }

    await user.getIdToken(true).catch(() => undefined);
    const inviteCode = this.inviteCode();

    if (inviteCode) {
      const pendingInvite = readPendingLeagueInvite(inviteCode);

      if (
        !pendingInvite ||
        pendingLeagueInviteAccountMatch(pendingInvite, user.uid) !== 'matching'
      ) {
        return false;
      }

      await this.resumeLeagueInvite(inviteCode);
    } else {
      this.verifiedEmail.set(user.email ?? 'your account email');
      this.stage.set('verified');
    }

    return true;
  }

  private preservePendingInvite(verifiedUser: User | null = null): void {
    const inviteCode = this.inviteCode();

    if (!inviteCode || (!verifiedUser && readPendingLeagueInvite(inviteCode))) {
      return;
    }

    startPendingLeagueInvite(inviteCode, {
      accountUid: verifiedUser?.uid ?? null,
      requiresTrainingCamp: false,
    });
  }

  private async resumeLeagueInvite(inviteCode: string): Promise<void> {
    const invitePath = buildLeagueInvitePath(inviteCode);

    if (!invitePath) {
      this.stage.set('error');
      this.errorMessage.set('The saved league invitation is no longer valid.');
      return;
    }

    this.stage.set('continuing');
    await this.router.navigateByUrl(invitePath, { replaceUrl: true });
  }

  private friendlyVerificationError(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';

    if (code.includes('expired-action-code')) {
      return 'This verification link expired. Return to RinkRat and send a new email.';
    }

    if (code.includes('invalid-action-code')) {
      return 'This verification link was already used or is no longer valid. Return to RinkRat and send a new one if your account is still unverified.';
    }

    if (code.includes('network-request-failed')) {
      return 'RinkRat could not reach the verification service. Check your connection and try the email link again.';
    }

    return error instanceof Error && error.message.trim()
      ? error.message
      : 'RinkRat could not verify this email link.';
  }

  private isConsumedOrExpiredActionCode(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';

    return code.includes('invalid-action-code') || code.includes('expired-action-code');
  }
}
