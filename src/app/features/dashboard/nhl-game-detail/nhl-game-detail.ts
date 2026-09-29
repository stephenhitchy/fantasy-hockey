import { Location } from '@angular/common';
import { Component, OnDestroy, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import {
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlGameTeamSummary,
  NhlGoalieBoxscoreLine,
  NhlSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
} from '../../../core/nhl/nhl-api.service';
import {
  calculateSkaterGameBreakdown,
  type GamePointBreakdown,
} from '../../../core/scoring/scoring-engine';
import { buildNhlSkaterGameScoringFacts } from '../../../core/scoring/nhl-game-fantasy-points.util';
import { defaultScoringRules } from '../../../core/scoring/scoring-rules';
import {
  buildNhlGamePeriodScores,
  buildNhlGameScoringEvents,
  buildNhlGameTeamComparison,
  buildNhlGameTopPerformers,
  formatNhlGameDetailDate,
  formatNhlGameDetailStatus,
  formatNhlSavePercentage,
  getNhlGamePlayerHeadshot,
  getNhlGamePlayerName,
  getNhlGameTeamName,
  isNhlGameLiveState,
  parseNhlGameId,
} from './nhl-game-detail.util';

type TeamSide = 'awayTeam' | 'homeTeam';

interface NhlSkaterFantasyPointView {
  breakdown: GamePointBreakdown;
  phase: 'live' | 'final';
}

@Component({
  selector: 'app-nhl-game-detail',
  imports: [RouterLink],
  templateUrl: './nhl-game-detail.html',
  styleUrl: './nhl-game-detail.css',
})
export class NhlGameDetail implements OnDestroy {
  readonly gameId = signal<number | null>(null);
  readonly boxscore = signal<NhlGameBoxscoreResponse | null>(null);
  readonly playByPlay = signal<NhlGamePlayByPlayResponse | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly boxscoreError = signal('');
  readonly playByPlayError = signal('');
  readonly lastUpdatedAt = signal<Date | null>(null);
  readonly selectedTeamSide = signal<TeamSide>('awayTeam');

  readonly awayTeam = computed(() => this.boxscore()?.awayTeam ?? null);
  readonly homeTeam = computed(() => this.boxscore()?.homeTeam ?? null);
  readonly gameStatus = computed(() => {
    const boxscore = this.boxscore();
    return boxscore ? formatNhlGameDetailStatus(boxscore) : '';
  });
  readonly gameDate = computed(() => {
    const boxscore = this.boxscore();
    return boxscore ? formatNhlGameDetailDate(boxscore) : '';
  });
  readonly periodScores = computed(() =>
    buildNhlGamePeriodScores(this.playByPlay(), this.boxscore()),
  );
  readonly scoringEvents = computed(() =>
    buildNhlGameScoringEvents(this.playByPlay(), this.boxscore()),
  );
  readonly teamComparison = computed(() =>
    buildNhlGameTeamComparison(this.boxscore(), this.playByPlay()),
  );
  readonly topPerformers = computed(() =>
    buildNhlGameTopPerformers(this.boxscore(), this.playByPlay()),
  );
  readonly selectedTeam = computed(() =>
    this.boxscore()?.[this.selectedTeamSide()] ?? null,
  );
  readonly selectedTeamStats = computed(() =>
    this.boxscore()?.playerByGameStats?.[this.selectedTeamSide()] ?? null,
  );
  readonly selectedSkaters = computed(() => {
    const team = this.selectedTeamStats();
    return [...(team?.forwards ?? []), ...(team?.defense ?? [])];
  });
  readonly selectedGoalies = computed(() => this.selectedTeamStats()?.goalies ?? []);
  readonly skaterFantasyPointsByPlayerId = computed(() => {
    const boxscore = this.boxscore();
    const playByPlay = this.playByPlay();
    const views = new Map<number, NhlSkaterFantasyPointView>();

    if (!boxscore) {
      return views;
    }

    for (const side of ['awayTeam', 'homeTeam'] as const) {
      const team = boxscore.playerByGameStats?.[side];

      for (const player of [...(team?.forwards ?? []), ...(team?.defense ?? [])]) {
        const facts = buildNhlSkaterGameScoringFacts(player, boxscore, playByPlay);

        if (!facts) {
          continue;
        }

        views.set(player.playerId, {
          breakdown: calculateSkaterGameBreakdown(facts.stats, defaultScoringRules),
          phase: facts.phase,
        });
      }
    }

    return views;
  });
  readonly hasAnyData = computed(() => Boolean(this.boxscore() || this.playByPlay()));
  readonly hasCompleteFailure = computed(() =>
    !this.loading() && !this.hasAnyData() && Boolean(this.boxscoreError() && this.playByPlayError()),
  );

  private readonly routeSubscription: Subscription;
  private refreshTimer: number | null = null;
  private requestGeneration = 0;
  private enteredFromScoreboard = false;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly location: Location,
  ) {
    this.enteredFromScoreboard = Boolean(
      this.router.getCurrentNavigation()?.extras.state?.['fromNhlScoreboard'] ??
      (typeof history !== 'undefined' && history.state?.fromNhlScoreboard),
    );

    this.routeSubscription = this.route.paramMap.subscribe((params) => {
      const gameId = parseNhlGameId(params.get('gameId'));
      this.openGame(gameId);
    });
  }

  ngOnDestroy(): void {
    this.requestGeneration += 1;
    this.routeSubscription.unsubscribe();
    this.clearRefreshTimer();
  }

  goBack(): void {
    if (this.enteredFromScoreboard) {
      this.location.back();
      return;
    }

    void this.router.navigate(['/dashboard']);
  }

  retry(): void {
    const gameId = this.gameId();

    if (gameId !== null) {
      void this.loadGame(gameId, true);
    }
  }

  selectTeam(side: TeamSide): void {
    this.selectedTeamSide.set(side);
  }

  getTeamName(team: NhlGameTeamSummary | null): string {
    return getNhlGameTeamName(team ?? undefined);
  }

  getTeamScore(team: NhlGameTeamSummary | null): string {
    return typeof team?.score === 'number' ? String(team.score) : '–';
  }

  getVenueLabel(): string {
    const game = this.boxscore();

    if (!game) {
      return '';
    }

    return [game.venue?.default, game.venueLocation?.default]
      .map((value) => value?.trim() ?? '')
      .filter(Boolean)
      .join(' · ');
  }

  getUpdatedLabel(): string {
    const updated = this.lastUpdatedAt();

    if (!updated) {
      return '';
    }

    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(updated);
  }

  getPlayerName(player: NhlSkaterBoxscoreLine | NhlGoalieBoxscoreLine): string {
    return getNhlGamePlayerName(player.playerId, player.name.default, this.playByPlay());
  }

  getPlayerHeadshot(playerId: number): string {
    return getNhlGamePlayerHeadshot(playerId, this.playByPlay());
  }

  getSavePercentage(value: number | undefined): string {
    return formatNhlSavePercentage(value);
  }

  getFaceoffPercentage(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '—';
    }

    return `${Math.round(value * 100)}%`;
  }

  getPlusMinus(value: number): string {
    return value > 0 ? `+${value}` : String(value);
  }

  getPenaltyMinutes(player: NhlSkaterBoxscoreLine | NhlGoalieBoxscoreLine): string {
    return typeof player.pim === 'number' ? String(player.pim) : '—';
  }

  getSkaterFantasyPoints(playerId: number): NhlSkaterFantasyPointView | null {
    return this.skaterFantasyPointsByPlayerId().get(playerId) ?? null;
  }

  formatFantasyPoints(value: number): string {
    return value.toFixed(1);
  }

  hideBrokenImage(event: Event): void {
    if (event.currentTarget instanceof HTMLImageElement) {
      event.currentTarget.hidden = true;
    }
  }

  private openGame(gameId: number | null): void {
    this.requestGeneration += 1;
    this.clearRefreshTimer();
    this.gameId.set(gameId);
    this.boxscore.set(null);
    this.playByPlay.set(null);
    this.boxscoreError.set('');
    this.playByPlayError.set('');
    this.lastUpdatedAt.set(null);
    this.selectedTeamSide.set('awayTeam');

    if (gameId === null) {
      this.loading.set(false);
      this.boxscoreError.set('This NHL game link is invalid.');
      this.playByPlayError.set('This NHL game link is invalid.');
      return;
    }

    void this.loadGame(gameId);
  }

  private async loadGame(gameId: number, forceRefresh: boolean = false): Promise<void> {
    const generation = ++this.requestGeneration;
    this.clearRefreshTimer();

    if (this.hasAnyData()) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }

    this.boxscoreError.set('');
    this.playByPlayError.set('');

    const [boxscoreResult, playByPlayResult] = await Promise.allSettled([
      getGameBoxscore(gameId, forceRefresh),
      getGamePlayByPlay(gameId, forceRefresh),
    ]);

    if (generation !== this.requestGeneration || this.gameId() !== gameId) {
      return;
    }

    let loadedSomething = false;

    if (boxscoreResult.status === 'fulfilled' &&
      (boxscoreResult.value.id === undefined || boxscoreResult.value.id === gameId)) {
      this.boxscore.set(boxscoreResult.value);
      loadedSomething = true;
    } else {
      this.boxscoreError.set('The NHL box score is temporarily unavailable.');
    }

    if (playByPlayResult.status === 'fulfilled' &&
      (playByPlayResult.value.id === undefined || playByPlayResult.value.id === gameId)) {
      this.playByPlay.set(playByPlayResult.value);
      loadedSomething = true;
    } else {
      this.playByPlayError.set('The NHL scoring summary is temporarily unavailable.');
    }

    if (loadedSomething) {
      this.lastUpdatedAt.set(new Date());
    }

    this.loading.set(false);
    this.refreshing.set(false);
    this.scheduleLiveRefresh();
  }

  private scheduleLiveRefresh(): void {
    const gameState = this.boxscore()?.gameState ?? this.playByPlay()?.gameState;

    if (typeof window === 'undefined' || !isNhlGameLiveState(gameState)) {
      return;
    }

    this.refreshTimer = window.setTimeout(() => {
      const gameId = this.gameId();

      if (gameId !== null) {
        void this.loadGame(gameId, true);
      }
    }, 30_000);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === null || typeof window === 'undefined') {
      return;
    }

    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}
