import { Component, computed, OnDestroy, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';

import { listenToAuthState, logoutUser } from '../../core/auth/auth.service';
import { DialogFocusTrapDirective } from '../accessibility/dialog-focus-trap.directive';

@Component({
  selector: 'app-navbar',
  imports: [RouterLink, RouterLinkActive, DialogFocusTrapDirective],
  templateUrl: './navbar.html',
  styleUrl: './navbar.css',
})
export class Navbar implements OnDestroy {
  readonly moreOpen = signal(false);
  readonly currentUrl = signal('');
  readonly authenticated = signal(false);
  readonly signingOut = signal(false);
  readonly signOutError = signal('');
  readonly homeRoute = computed(() => (this.authenticated() ? '/dashboard' : '/'));

  private readonly routerEventsSubscription: Subscription;
  private readonly stopAuthListener: () => void;

  constructor(private readonly router: Router) {
    this.currentUrl.set(this.router.url);

    this.stopAuthListener = listenToAuthState((user) => {
      this.authenticated.set(Boolean(user));
    });

    this.routerEventsSubscription = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.currentUrl.set(event.urlAfterRedirects);
        this.closeMore();
      });
  }

  ngOnDestroy(): void {
    this.routerEventsSubscription.unsubscribe();
    this.stopAuthListener();
  }

  toggleMore(): void {
    this.moreOpen.update((isOpen) => !isOpen);
  }

  closeMore(): void {
    this.moreOpen.set(false);
  }

  isExactRoute(path: string): boolean {
    return this.currentUrl().split(/[?#]/)[0] === path;
  }

  async signOut(): Promise<void> {
    if (this.signingOut()) {
      return;
    }

    this.signOutError.set('');
    this.signingOut.set(true);
    this.closeMore();

    try {
      await logoutUser();
      await this.router.navigate(['/'], { replaceUrl: true });
    } catch (error: unknown) {
      this.signOutError.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not sign you out. Please try again.',
      );
    } finally {
      this.signingOut.set(false);
    }
  }
}
