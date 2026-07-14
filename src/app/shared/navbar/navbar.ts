import {
  Component,
  computed,
  HostListener,
  OnDestroy,
  signal
} from '@angular/core';

import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive
} from '@angular/router';

import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';

import { logoutUser } from '../../core/auth/auth.service';

@Component({
  selector: 'app-navbar',
  imports: [
    RouterLink,
    RouterLinkActive
  ],
  templateUrl: './navbar.html',
  styleUrl: './navbar.css'
})
export class Navbar implements OnDestroy {
  readonly moreOpen = signal(false);
  readonly currentUrl = signal('');

  readonly leagueId = computed(() => {
    const match = this.currentUrl().match(
      /\/leagues\/([^/?#]+)/
    );

    if (!match?.[1]) {
      return '';
    }

    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  });

  readonly isLeagueContext = computed(() =>
    Boolean(this.leagueId())
  );

  private readonly routerEventsSubscription: Subscription;

  constructor(private router: Router) {
    this.currentUrl.set(this.router.url);

    this.routerEventsSubscription = this.router.events
      .pipe(
        filter(
          (event): event is NavigationEnd =>
            event instanceof NavigationEnd
        )
      )
      .subscribe((event) => {
        this.currentUrl.set(event.urlAfterRedirects);
        this.closeMore();
      });
  }

  ngOnDestroy(): void {
    this.routerEventsSubscription.unsubscribe();
  }

  @HostListener('document:keydown.escape')
  handleEscape(): void {
    this.closeMore();
  }

  toggleMore(): void {
    this.moreOpen.update((isOpen) => !isOpen);
  }

  closeMore(): void {
    this.moreOpen.set(false);
  }

  isExactRoute(path: string): boolean {
    const urlWithoutQuery = this.currentUrl().split(/[?#]/)[0];

    return urlWithoutQuery === path;
  }

  isLeagueHomeActive(): boolean {
    const leagueId = this.leagueId();

    return Boolean(
      leagueId &&
      this.isExactRoute(`/leagues/${encodeURIComponent(leagueId)}`)
    );
  }

  isLeagueSectionActive(section: string): boolean {
    const leagueId = this.leagueId();
    const urlWithoutQuery = this.currentUrl().split(/[?#]/)[0];

    return Boolean(
      leagueId &&
      urlWithoutQuery.startsWith(
        `/leagues/${encodeURIComponent(leagueId)}/${section}`
      )
    );
  }

  async logout(): Promise<void> {
    this.closeMore();
    await logoutUser();
    await this.router.navigate(['/']);
  }
}
