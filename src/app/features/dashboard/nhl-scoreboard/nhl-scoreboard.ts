import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
  formatNhlGameDate,
  formatNhlGameStatus,
  formatNhlScoreboardHeading,
  clampNhlScoreboardRailIndex,
  getDashboardNhlRosterGamePointDisplay,
  getDashboardNhlRosterEntryRoute,
  getNhlScoreboardRailIndex,
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
  readonly activeGameIndex = signal(0);
  readonly canScrollToPreviousGame = signal(false);
  readonly canScrollToNextGame = signal(false);
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

  readonly activeGameNumber = computed(() => this.visibleGames().length === 0
    ? 0
    : clampNhlScoreboardRailIndex(
      this.activeGameIndex(),
      this.visibleGames().length,
    ) + 1,
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

  private requestGeneration = 0;
  private rosterRefreshGeneration = 0;
  private gameStripPositionFrame: number | null = null;
  private rosterTrigger: HTMLElement | null = null;
  private restoreRosterTriggerFocus = true;
  private pendingScrollRestore: number | null = null;
  private gameCardPointer: {
    gameId: number;
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    moved: boolean;
  } | null = null;
  private lastGameCardDragAt = 0;

  constructor(private readonly router: Router) {
    const restoredState = this.consumeSavedScoreboardState();
    this.pendingScrollRestore = restoredState?.scrollLeft ?? null;
    const targetDate = restoredState?.date && !isNhlScoreboardDateToday(restoredState.date)
      ? restoredState.date
      : null;
    void this.loadScores(false, targetDate);
  }

  ngOnDestroy(): void {
    this.requestGeneration += 1;
    this.rosterRefreshGeneration += 1;

    if (this.gameStripPositionFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.gameStripPositionFrame);
      this.gameStripPositionFrame = null;
    }

    const dialog = this.rosterDialog()?.nativeElement;

    if (dialog?.open) {
      dialog.close();
    }
  }

  @HostListener('window:resize')
  handleViewportResize(): void {
    this.scheduleGameStripPositionUpdate();
  }

  async openPreviousScoreDate(): Promise<void> {
    await this.openScoreDate(this.previousDate());
  }

  async openNextScoreDate(): Promise<void> {
    await this.openScoreDate(this.nextDate());
  }

  async openTodayScoreDate(): Promise<void> {
    this.pendingScrollRestore = null;
    await this.loadScores(false, null);
  }

  async refreshScores(): Promise<void> {
    await this.loadScores(true, this.requestedDate());
  }

  getGameStatus(game: NhlScoreGame): string {
    return formatNhlGameStatus(game);
  }

  getGameDateLabel(game: NhlScoreGame): string {
    return formatNhlGameDate(game);
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

  getGameDetailsLabel(game: NhlScoreGame): string {
    return `Open ${game.awayTeam.abbrev} at ${game.homeTeam.abbrev} NHL game details`;
  }

  openPreviousGame(): void {
    if (!this.canScrollToPreviousGame()) {
      return;
    }

    this.scrollToGame(this.activeGameIndex() - 1);
  }

  openNextGame(): void {
    if (!this.canScrollToNextGame()) {
      return;
    }

    this.scrollToGame(this.activeGameIndex() + 1);
  }

  handleGameStripKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key === 'ArrowLeft' && this.canScrollToPreviousGame()) {
      event.preventDefault();
      this.openPreviousGame();
    } else if (event.key === 'ArrowRight' && this.canScrollToNextGame()) {
      event.preventDefault();
      this.openNextGame();
    }
  }

  handleGameStripScroll(): void {
    const strip = this.gameStrip()?.nativeElement;
    const pointer = this.gameCardPointer;

    if (strip && pointer && Math.abs(strip.scrollLeft - pointer.startScrollLeft) > 2) {
      pointer.moved = true;
      this.lastGameCardDragAt = Date.now();
    }

    this.updateGameStripPosition();
  }

  beginGameCardPointer(game: NhlScoreGame, event: PointerEvent): void {
    if (!event.isPrimary) {
      return;
    }

    this.gameCardPointer = {
      gameId: game.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: this.gameStrip()?.nativeElement.scrollLeft ?? 0,
      moved: false,
    };
  }

  trackGameCardPointer(game: NhlScoreGame, event: PointerEvent): void {
    const pointer = this.gameCardPointer;

    if (
      !pointer ||
      pointer.gameId !== game.id ||
      pointer.pointerId !== event.pointerId
    ) {
      return;
    }

    const horizontalDistance = Math.abs(event.clientX - pointer.startX);
    const verticalDistance = Math.abs(event.clientY - pointer.startY);

    if (horizontalDistance > 10 || verticalDistance > 10) {
      pointer.moved = true;
    }
  }

  finishGameCardPointer(event: PointerEvent): void {
    const pointer = this.gameCardPointer;

    if (!pointer || pointer.pointerId !== event.pointerId) {
      return;
    }

    const strip = this.gameStrip()?.nativeElement;
    const railMoved = strip
      ? Math.abs(strip.scrollLeft - pointer.startScrollLeft) > 2
      : false;

    if (pointer.moved || railMoved) {
      this.lastGameCardDragAt = Date.now();
    }

    this.gameCardPointer = null;
  }

  openGameDetails(game: NhlScoreGame, event: MouseEvent): void {
    const isKeyboardActivation = event.detail === 0;
    const followedDrag = Date.now() - this.lastGameCardDragAt < 700;

    if (!isKeyboardActivation && followedDrag) {
      event.preventDefault();
      return;
    }

    this.saveScoreboardState();
    void this.router.navigate(['/nhl', 'games', game.id], {
      queryParams: this.focusedDate() ? { date: this.focusedDate() } : undefined,
      state: { fromNhlScoreboard: true },
    });
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

  private async refreshRosterGamePoints(): Promise<void> {
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
    return getDashboardNhlRosterEntryRoute(entry);
  }

  getRosterEntryLinkLabel(entry: DashboardNhlRosterEntry): string {
    const destination = entry.matchupCycleNumber !== null && entry.matchupId
      ? 'matchup'
      : 'league';
    return `Open ${entry.assetName} in ${entry.leagueName} ${destination}`;
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

    this.pendingScrollRestore = null;
    await this.loadScores(false, isNhlScoreboardDateToday(date) ? null : date);
  }

  private async loadScores(
    forceRefresh: boolean = false,
    targetDate: string | null = this.requestedDate(),
  ): Promise<void> {
    const generation = ++this.requestGeneration;
    this.requestedDate.set(targetDate);

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
      this.lastUpdatedAt.set(new Date());
      this.scheduleGameStripPositionUpdate();

      if (this.pendingScrollRestore !== null) {
        this.restoreGameStripScroll(this.pendingScrollRestore);
        this.pendingScrollRestore = null;
      } else if (dateChanged) {
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
    }
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
        this.updateGameStripPosition();
      }
    });
  }

  private restoreGameStripScroll(scrollLeft: number): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const strip = this.gameStrip()?.nativeElement;

        if (strip) {
          strip.scrollLeft = Math.max(0, scrollLeft);
          this.updateGameStripPosition();
        }
      });
    });
  }

  private scrollToGame(index: number): void {
    const strip = this.gameStrip()?.nativeElement;

    if (!strip) {
      return;
    }

    const cards = this.getGameCards(strip);
    const targetIndex = clampNhlScoreboardRailIndex(index, cards.length);
    const targetCard = cards[targetIndex];

    if (!targetCard) {
      return;
    }

    const targetLeft = this.getGameCardOffset(strip, targetCard);
    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    strip.scrollTo({
      left: Math.min(maxScrollLeft, Math.max(0, targetLeft)),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
    this.activeGameIndex.set(targetIndex);
    this.updateGameStripBoundaries(strip);
  }

  private updateGameStripPosition(): void {
    const strip = this.gameStrip()?.nativeElement;

    if (!strip) {
      this.activeGameIndex.set(0);
      this.canScrollToPreviousGame.set(false);
      this.canScrollToNextGame.set(false);
      return;
    }

    const cards = this.getGameCards(strip);
    const offsets = cards.map((card) => this.getGameCardOffset(strip, card));
    this.activeGameIndex.set(getNhlScoreboardRailIndex(strip.scrollLeft, offsets));
    this.updateGameStripBoundaries(strip);
  }

  private updateGameStripBoundaries(strip: HTMLDivElement): void {
    const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const boundaryTolerance = 2;
    this.canScrollToPreviousGame.set(strip.scrollLeft > boundaryTolerance);
    this.canScrollToNextGame.set(strip.scrollLeft < maxScrollLeft - boundaryTolerance);
  }

  private getGameCards(strip: HTMLDivElement): HTMLElement[] {
    return Array.from(strip.querySelectorAll<HTMLElement>('.nhl-game-card'));
  }

  private getGameCardOffset(strip: HTMLDivElement, card: HTMLElement): number {
    return strip.scrollLeft + card.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  }

  private scheduleGameStripPositionUpdate(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.gameStripPositionFrame !== null) {
      window.cancelAnimationFrame(this.gameStripPositionFrame);
    }

    this.gameStripPositionFrame = window.requestAnimationFrame(() => {
      this.gameStripPositionFrame = null;
      this.updateGameStripPosition();
    });
  }

  private saveScoreboardState(): void {
    if (typeof sessionStorage === 'undefined') {
      return;
    }

    try {
      sessionStorage.setItem('rinkrat:nhl-scoreboard-view:v1', JSON.stringify({
        date: this.focusedDate(),
        scrollLeft: Math.max(0, this.gameStrip()?.nativeElement.scrollLeft ?? 0),
        savedAt: Date.now(),
      }));
    } catch {
      // Browser privacy settings can disable session storage. Navigation still works.
    }
  }

  private consumeSavedScoreboardState(): {
    date: string;
    scrollLeft: number;
  } | null {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }

    try {
      const key = 'rinkrat:nhl-scoreboard-view:v1';
      const rawValue = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);

      if (!rawValue) {
        return null;
      }

      const value = JSON.parse(rawValue) as {
        date?: unknown;
        scrollLeft?: unknown;
        savedAt?: unknown;
      };

      if (
        typeof value.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
        typeof value.scrollLeft !== 'number' ||
        !Number.isFinite(value.scrollLeft) ||
        typeof value.savedAt !== 'number' ||
        Date.now() - value.savedAt > 30 * 60 * 1000
      ) {
        return null;
      }

      return {
        date: value.date,
        scrollLeft: Math.max(0, value.scrollLeft),
      };
    } catch {
      return null;
    }
  }
}
