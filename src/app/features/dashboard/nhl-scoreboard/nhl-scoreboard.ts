import { Component, OnDestroy, computed, input, signal } from '@angular/core';
import {
  NhlScoreGame,
  getNhlScoreNow,
} from '../../../core/nhl/nhl-api.service';
import {
  formatNhlGameStatus,
  formatNhlScoreboardHeading,
  getNhlScoreboardRefreshDelay,
  isFavoriteTeamGame,
  isNhlScoreGameFinal,
  isNhlScoreGameLive,
  selectDashboardNhlGames,
} from './nhl-scoreboard.util';

@Component({
  selector: 'app-nhl-scoreboard',
  imports: [],
  templateUrl: './nhl-scoreboard.html',
  styleUrl: './nhl-scoreboard.css',
})
export class NhlScoreboard implements OnDestroy {
  readonly favoriteTeamAbbreviation = input('');

  readonly games = signal<NhlScoreGame[]>([]);
  readonly focusedDate = signal('');
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errorMessage = signal('');
  readonly lastUpdatedAt = signal<Date | null>(null);

  readonly visibleGames = computed(() =>
    selectDashboardNhlGames(this.games(), this.favoriteTeamAbbreviation()),
  );

  readonly heading = computed(() =>
    formatNhlScoreboardHeading(this.focusedDate()),
  );

  readonly hasLiveGames = computed(() =>
    this.games().some(isNhlScoreGameLive),
  );

  private refreshTimer: number | null = null;
  private requestGeneration = 0;

  constructor() {
    void this.loadScores();
  }

  ngOnDestroy(): void {
    this.requestGeneration += 1;
    this.clearRefreshTimer();
  }

  async refreshScores(): Promise<void> {
    await this.loadScores(true);
  }

  getGameStatus(game: NhlScoreGame): string {
    return formatNhlGameStatus(game);
  }

  isLive(game: NhlScoreGame): boolean {
    return isNhlScoreGameLive(game);
  }

  isFinal(game: NhlScoreGame): boolean {
    return isNhlScoreGameFinal(game);
  }

  isFavoriteGame(game: NhlScoreGame): boolean {
    return isFavoriteTeamGame(game, this.favoriteTeamAbbreviation());
  }

  getTeamScore(game: NhlScoreGame, side: 'away' | 'home'): string {
    const score = side === 'away'
      ? game.awayTeam.score
      : game.homeTeam.score;

    return typeof score === 'number' ? String(score) : '–';
  }

  getBroadcastLabel(game: NhlScoreGame): string {
    return game.tvBroadcasts?.find((broadcast) => broadcast.network)?.network ?? '';
  }

  getUpdatedLabel(): string {
    const value = this.lastUpdatedAt();

    if (!value) {
      return '';
    }

    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(value);
  }

  private async loadScores(forceRefresh: boolean = false): Promise<void> {
    const generation = ++this.requestGeneration;
    this.clearRefreshTimer();

    if (this.games().length === 0) {
      this.loading.set(true);
    } else {
      this.refreshing.set(true);
    }

    this.errorMessage.set('');

    try {
      const response = await getNhlScoreNow(forceRefresh);

      if (generation !== this.requestGeneration) {
        return;
      }

      this.games.set(Array.isArray(response.games) ? response.games : []);
      this.focusedDate.set(response.currentDate ?? '');
      this.lastUpdatedAt.set(new Date());
    } catch (error: unknown) {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'The NHL scoreboard is temporarily unavailable.',
      );
    } finally {
      if (generation !== this.requestGeneration) {
        return;
      }

      this.loading.set(false);
      this.refreshing.set(false);
      this.scheduleRefresh();
    }
  }

  private scheduleRefresh(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.refreshTimer = window.setTimeout(() => {
      void this.loadScores(true);
    }, getNhlScoreboardRefreshDelay(this.games()));
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === null || typeof window === 'undefined') {
      return;
    }

    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}
