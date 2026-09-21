import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  NhlScoreGame,
  getNhlScoreForDate,
  getNhlScoreNow,
} from '../../../core/nhl/nhl-api.service';
import { refreshDashboardNhlRosterGameContexts } from '../../../core/league/dashboard-league-activity.service';
import type {
  DashboardNhlRosterEntry,
  DashboardNhlRosterGameContext,
  DashboardNhlRosterLocation,
  DashboardNhlTeamRosterPresence,
} from '../../../core/league/dashboard-league-activity.models';
import {
  formatNhlGameStatus,
  formatNhlScoreboardHeading,
  getDashboardNhlRosterGamePointDisplay,
  getNhlScoreboardRefreshDelay,
  isNhlScoreboardDateToday,
  isFavoriteTeamGame,
  isNhlScoreGameFinal,
  isNhlScoreGameLive,
  selectDashboardNhlGames,
} from './nhl-scoreboard.util';

@Component({
  selector: 'app-nhl-scoreboard',
  imports: [RouterLink],
  templateUrl: './nhl-scoreboard.html',
  styleUrl: './nhl-scoreboard.css',
})
export class NhlScoreboard implements OnDestroy {
  readonly favoriteTeamAbbreviation = input('');
  readonly rosteredTeamCounts = input<readonly DashboardNhlTeamRosterPresence[]>([]);

  readonly games = signal<NhlScoreGame[]>([]);
  readonly focusedDate = signal('');
  readonly previousDate = signal('');
  readonly nextDate = signal('');
  readonly requestedDate = signal<string | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly errorMessage = signal('');
  readonly lastUpdatedAt = signal<Date | null>(null);
  readonly selectedRosterTeam = signal('');
  readonly selectedRosterGame = signal<NhlScoreGame | null>(null);
  readonly rosterGameContexts = signal<DashboardNhlRosterGameContext[]>([]);
  readonly rosterPointsLoading = signal(false);
  readonly rosterPointsError = signal('');
  readonly rosterDialog = viewChild<ElementRef<HTMLDialogElement>>('rosterDialog');
  readonly gameStrip = viewChild<ElementRef<HTMLDivElement>>('gameStrip');

  readonly visibleGames = computed(() =>
    selectDashboardNhlGames(this.games(), this.favoriteTeamAbbreviation()),
  );

  readonly heading = computed(() =>
    formatNhlScoreboardHeading(this.focusedDate()),
  );

  readonly viewingToday = computed(() =>
    isNhlScoreboardDateToday(this.focusedDate()),
  );

  readonly hasLiveGames = computed(() =>
    this.games().some(isNhlScoreGameLive),
  );

  readonly rosteredPresenceByTeam = computed(() => new Map(
    this.rosteredTeamCounts().map((entry) => [
      entry.teamAbbreviation.trim().toUpperCase(),
      entry,
    ]),
  ));

  readonly selectedRosterPresence = computed(() =>
    this.rosteredPresenceByTeam().get(this.selectedRosterTeam()) ?? null,
  );

  readonly hasVisibleRosterPresence = computed(() =>
    this.visibleGames().some((game) =>
      this.getRosteredTeamCount(game.awayTeam.abbrev) > 0 ||
      this.getRosteredTeamCount(game.homeTeam.abbrev) > 0,
    ),
  );

  private refreshTimer: number | null = null;
  private requestGeneration = 0;
  private rosterRefreshGeneration = 0;
  private rosterTrigger: HTMLElement | null = null;
  private restoreRosterTriggerFocus = true;

  constructor() {
    void this.loadScores();
  }

  ngOnDestroy(): void {
    this.requestGeneration += 1;
    this.rosterRefreshGeneration += 1;
    this.clearRefreshTimer();

    const dialog = this.rosterDialog()?.nativeElement;

    if (dialog?.open) {
      dialog.close();
    }
  }

  async refreshScores(): Promise<void> {
    await this.loadScores(true, this.requestedDate());
  }

  async openPreviousScoreDate(): Promise<void> {
    await this.openScoreDate(this.previousDate());
  }

  async openNextScoreDate(): Promise<void> {
    await this.openScoreDate(this.nextDate());
  }

  async openTodayScoreDate(): Promise<void> {
    await this.loadScores(false, null);
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

  getRosteredTeamCount(teamAbbreviation: string): number {
    return this.rosteredPresenceByTeam().get(teamAbbreviation.trim().toUpperCase())?.count ?? 0;
  }

  getRosteredTeamCountLabel(teamAbbreviation: string): string {
    const count = this.getRosteredTeamCount(teamAbbreviation);
    const rosterSpotLabel = count === 1 ? 'roster spot' : 'roster spots';
    return `View ${count} ${teamAbbreviation} ${rosterSpotLabel} across your leagues`;
  }

  getRosterLocationLabel(location: DashboardNhlRosterLocation): string {
    switch (location) {
      case 'bench':
        return 'Bench';
      case 'ir':
        return 'IR';
      default:
        return 'Active lineup';
    }
  }

  openRosterBreakdown(teamAbbreviation: string, game: NhlScoreGame, event: Event): void {
    const team = teamAbbreviation.trim().toUpperCase();

    if (!this.rosteredPresenceByTeam().has(team)) {
      return;
    }

    this.selectedRosterTeam.set(team);
    this.selectedRosterGame.set(game);
    this.rosterPointsError.set('');
    this.rosterTrigger = event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : null;
    this.restoreRosterTriggerFocus = true;

    const dialog = this.rosterDialog()?.nativeElement;

    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    void this.refreshRosterGamePoints();
  }

  async refreshRosterGamePoints(): Promise<void> {
    const selected = this.selectedRosterPresence();

    if (!selected) {
      return;
    }

    const generation = ++this.rosterRefreshGeneration;
    this.rosterPointsLoading.set(true);
    this.rosterPointsError.set('');

    let result;

    try {
      result = await refreshDashboardNhlRosterGameContexts(selected.entries);
    } catch {
      if (generation === this.rosterRefreshGeneration && this.selectedRosterGame()) {
        this.rosterPointsLoading.set(false);
        this.rosterPointsError.set(
          'Fantasy points could not refresh. The last saved values are still shown.',
        );
      }

      return;
    }

    if (generation !== this.rosterRefreshGeneration || !this.selectedRosterGame()) {
      return;
    }

    const updatedKeys = new Set(result.contexts.map((context) => this.getRosterGameContextKey(
      context.leagueId,
      context.cycleNumber,
      context.assetKey,
    )));
    this.rosterGameContexts.update((current) => [
      ...current.filter((context) => !updatedKeys.has(this.getRosterGameContextKey(
        context.leagueId,
        context.cycleNumber,
        context.assetKey,
      ))),
      ...result.contexts,
    ]);
    this.rosterPointsLoading.set(false);

    if (result.failedLeagueIds.length > 0) {
      this.rosterPointsError.set(
        result.failedLeagueIds.length === 1
          ? 'One league score could not refresh. The last saved value is still shown.'
          : 'Some league scores could not refresh. Their last saved values are still shown.',
      );
    }
  }

  closeRosterBreakdown(restoreFocus: boolean = true): void {
    this.restoreRosterTriggerFocus = restoreFocus;
    const dialog = this.rosterDialog()?.nativeElement;

    if (dialog?.open) {
      dialog.close();
      return;
    }

    this.finishRosterBreakdownClose();
  }

  finishRosterBreakdownClose(): void {
    this.rosterRefreshGeneration += 1;
    this.selectedRosterTeam.set('');
    this.selectedRosterGame.set(null);
    this.rosterPointsLoading.set(false);
    this.rosterPointsError.set('');

    if (this.restoreRosterTriggerFocus) {
      this.rosterTrigger?.focus();
    }

    this.rosterTrigger = null;
    this.restoreRosterTriggerFocus = true;
  }

  getRosterEntryRoute(entry: DashboardNhlRosterEntry): Array<string | number> {
    if (entry.matchupCycleNumber !== null && entry.matchupId) {
      return [
        '/leagues',
        entry.leagueId,
        'cycles',
        entry.matchupCycleNumber,
        'matchups',
        entry.matchupId,
      ];
    }

    return ['/leagues', entry.leagueId];
  }

  getRosterEntryPointLabel(entry: DashboardNhlRosterEntry): string {
    const game = this.selectedRosterGame();

    if (!game) {
      return 'Fantasy points unavailable';
    }

    return getDashboardNhlRosterGamePointDisplay({
      rosterLocation: entry.rosterLocation,
      gameId: game.id,
      gameState: game.gameState,
      ...this.getRosterEntryGameContext(entry),
    }).label;
  }

  getRosterEntryPointTone(entry: DashboardNhlRosterEntry): string {
    const game = this.selectedRosterGame();

    if (!game) {
      return 'pending';
    }

    return getDashboardNhlRosterGamePointDisplay({
      rosterLocation: entry.rosterLocation,
      gameId: game.id,
      gameState: game.gameState,
      ...this.getRosterEntryGameContext(entry),
    }).tone;
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

  private async openScoreDate(date: string): Promise<void> {
    if (!date) {
      return;
    }

    await this.loadScores(false, isNhlScoreboardDateToday(date) ? null : date);
  }

  private async loadScores(
    forceRefresh: boolean = false,
    targetDate: string | null = this.requestedDate(),
  ): Promise<void> {
    const generation = ++this.requestGeneration;
    this.clearRefreshTimer();

    if (this.games().length === 0) {
      this.loading.set(true);
    } else {
      this.refreshing.set(true);
    }

    this.errorMessage.set('');

    try {
      const response = targetDate
        ? await getNhlScoreForDate(targetDate, forceRefresh)
        : await getNhlScoreNow(forceRefresh);

      if (generation !== this.requestGeneration) {
        return;
      }

      const dateChanged = response.currentDate !== this.focusedDate();
      this.games.set(Array.isArray(response.games) ? response.games : []);
      this.focusedDate.set(response.currentDate ?? '');
      this.previousDate.set(response.prevDate ?? '');
      this.nextDate.set(response.nextDate ?? '');
      this.requestedDate.set(targetDate);
      this.lastUpdatedAt.set(new Date());

      if (dateChanged) {
        this.resetGameStripScroll();
      }
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
    if (typeof window === 'undefined' || !this.viewingToday()) {
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

  private getRosterEntryGameContext(entry: DashboardNhlRosterEntry): {
    scheduledGameIds: readonly number[];
    gameScores: Readonly<Record<string, number>>;
  } {
    const refreshed = entry.matchupCycleNumber === null
      ? null
      : this.rosterGameContexts().find((context) =>
        context.leagueId === entry.leagueId &&
        context.cycleNumber === entry.matchupCycleNumber &&
        context.assetKey === entry.assetKey,
      );

    return {
      scheduledGameIds: refreshed?.scheduledGameIds ?? entry.scheduledGameIds,
      gameScores: refreshed?.gameScores ?? entry.gameScores,
    };
  }

  private getRosterGameContextKey(
    leagueId: string,
    cycleNumber: number,
    assetKey: string,
  ): string {
    return `${leagueId}\u0000${cycleNumber}\u0000${assetKey}`;
  }

  private resetGameStripScroll(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.requestAnimationFrame(() => {
      const strip = this.gameStrip()?.nativeElement;

      if (strip) {
        strip.scrollLeft = 0;
      }
    });
  }
}
