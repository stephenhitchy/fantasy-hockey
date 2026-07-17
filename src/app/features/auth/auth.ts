import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { loginUser, registerUser } from '../../core/auth/auth.service';
import { buildPixelMarquee, PixelLogoItem } from '../../shared/pixel-theme/pixel-theme.data';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './auth.html',
  styleUrl: './auth.css'
})
export class Auth {
  email = '';
  password = '';
  username = '';
  isRegistering = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  loading = signal(false);
  mascotCelebrating = signal(false);

  readonly topRibbon: PixelLogoItem[] = buildPixelMarquee(0);
  readonly bottomRibbon: PixelLogoItem[] = buildPixelMarquee(11);

  readonly pageTitle = computed(() =>
    this.isRegistering() ? 'Create Your Franchise' : 'Enter the Rink'
  );

  readonly pageSubtitle = computed(() =>
    this.isRegistering()
      ? 'Build your profile, join the league, and get ready for opening night.'
      : 'Sign in to manage your roster, follow your six-game windows, and chase the Cup.'
  );

  readonly submitLabel = computed(() =>
    this.loading()
      ? (this.isRegistering() ? 'Creating...' : 'Logging in...')
      : (this.isRegistering() ? 'Create Profile' : 'Login')
  );

  constructor(private router: Router) {}

  async submit(): Promise<void> {
    if (this.loading()) {
      return;
    }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.loading.set(true);
    this.mascotCelebrating.set(false);

    try {
      if (this.isRegistering()) {
        await registerUser(this.email, this.password, this.username);
        this.successMessage.set('Profile created. Welcome to the league!');
      } else {
        await loginUser(this.email, this.password);
        this.successMessage.set('Login successful. Opening your dashboard...');
      }

      this.mascotCelebrating.set(true);
      await new Promise((resolve) => setTimeout(resolve, 850));
      await this.router.navigate(['/dashboard']);
    } catch (error: any) {
      this.errorMessage.set(error?.message || 'Unable to continue right now.');
      this.mascotCelebrating.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  toggleMode(): void {
    this.isRegistering.set(!this.isRegistering());
    this.errorMessage.set('');
    this.successMessage.set('');
    this.loading.set(false);
    this.mascotCelebrating.set(false);
  }
}
