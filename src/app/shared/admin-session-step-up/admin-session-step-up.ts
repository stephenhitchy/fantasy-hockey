import { Component, EventEmitter, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PlatformAdminService } from '../../core/admin/platform-admin.service';
import {
  getFriendlyReauthenticationError,
  RecentAuthService,
} from '../../core/auth/recent-auth.service';

@Component({
  selector: 'app-admin-session-step-up',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './admin-session-step-up.html',
  styleUrl: './admin-session-step-up.css',
})
export class AdminSessionStepUp implements OnInit {
  @Output() readonly verified = new EventEmitter<void>();

  readonly checkingAccess = signal(true);
  readonly busy = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');

  password = '';

  constructor(
    readonly recentAuth: RecentAuthService,
    readonly platformAdmin: PlatformAdminService,
  ) {}

  async ngOnInit(): Promise<void> {
    await this.platformAdmin.refreshAccess();
    await this.recentAuth.refresh();
    this.checkingAccess.set(false);
  }

  async refreshStatus(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');
    await this.recentAuth.refresh(true);
  }

  async unlock(): Promise<void> {
    if (this.busy() || !this.password) {
      return;
    }

    this.busy.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const result = await this.recentAuth.reauthenticate(this.password);
      this.password = '';

      if (result.status !== 'recent') {
        throw new Error(result.message);
      }

      this.successMessage.set('Protected administrator actions are unlocked for 15 minutes.');
      this.verified.emit();
    } catch (error: unknown) {
      this.errorMessage.set(getFriendlyReauthenticationError(error));
    } finally {
      this.busy.set(false);
    }
  }

  remainingLabel(): string {
    const seconds = this.recentAuth.snapshot().expiresInSeconds;

    if (seconds === null) {
      return 'Not verified';
    }

    if (seconds < 60) {
      return 'Less than 1 minute remaining';
    }

    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'} remaining`;
  }
}
