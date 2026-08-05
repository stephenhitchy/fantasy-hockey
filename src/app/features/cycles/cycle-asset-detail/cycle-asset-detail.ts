import { Component, computed, OnDestroy, signal } from '@angular/core';

import { ActivatedRoute, Router } from '@angular/router';

import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import { DraftableAsset, DraftPick } from '../../../core/draft/draft.models';

import { listenToDraftPicks } from '../../../core/draft/draft.service';

import { FantasyCycle } from '../../../core/cycle/cycle.models';

import { CycleAssetScoreSummary } from '../../../core/cycle/cycle-scoring.service';

import { listenToCycle, listenToCycleRosterPicks } from '../../../core/cycle/cycle.service';

import { getLeagueById, League } from '../../../core/league/league.service';

import { FantasyTeam, getLeagueTeams } from '../../../core/team/team.service';

import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  GoalieGameStats,
  SkaterGameStats,
} from '../../../core/scoring/scoring-engine';

import { getHistoricalScoringTestDate } from '../../../core/cycle/cycle-runtime.config';

import {
  listenToSharedCycleScoring,
} from '../../../core/live-scoring/live-scoring.service';

import { SharedCycleScoringSnapshot } from '../../../core/live-scoring/live-scoring.models';

import {
  HistoricalReplayControl,
  listenToHistoricalReplayControl,
} from '../../../core/replay/historical-replay.service';

import { defaultScoringRules, ScoringRules } from '../../../core/scoring/scoring-rules';

import {
  findSkaterBoxscoreLine,
  getGameBoxscore,
  getGamePlayByPlay,
  getNhlTeamSeasonSchedule,
  getRegularSeasonGameLog,
  getSkaterAssistBreakdown,
  getTeamGoalieUnitResult,
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlPlayerGameLogEntry,
  NhlTeamSeasonGame,
} from '../../../core/nhl/nhl-api.service';

import {
  buildCycleAssetSnapshotGames,
  parseReplaySnapshotSeason,
  resolveCycleAssetDetailSeason,
  resolveCycleAssetScoreSummary,
} from './cycle-asset-detail-snapshot.util';

interface DetailStatChip {
  label: string;
  value: string;
}

interface DetailBreakdownLine {
  label: string;
  points: number;
}

interface GameDetailData {
  boxscore: NhlGameBoxscoreResponse;
  playByPlay: NhlGamePlayByPlayResponse;
}

interface CycleAssetGameDetail {
  gameId: number;
  gameDate: string;
  teamGameNumber: number;
  cycleGameNumber: number;
  opponentAbbreviation: string;
  scheduleLabel: string;
  scoreLabel: string;
  statusLabel: string;
  final: boolean;
  counted: boolean;
  appeared: boolean;
  fantasyPoints: number | null;
  statChips: DetailStatChip[];
  breakdownLines: DetailBreakdownLine[];
}

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

@Component({
  selector: 'app-cycle-asset-detail',
  templateUrl: './cycle-asset-detail.html',
  styleUrl: './cycle-asset-detail.css',
})
export class CycleAssetDetail implements OnDestroy {
  leagueId = '';
  assetKey = '';
  userId = '';
  cycleNumber = 1;
  returnToUrl = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  cycle = signal<FantasyCycle | null>(null);
  picks = signal<DraftPick[]>([]);
  picksLoaded = signal(false);
  sharedScoringSnapshot = signal<SharedCycleScoringSnapshot | null>(null);
  historicalReplayControl = signal<HistoricalReplayControl | null>(null);

  loading = signal(true);
  detailLoading = signal(false);
  errorMessage = signal('');
  detailError = signal('');

  gameRows = signal<CycleAssetGameDetail[]>([]);

  private stopCycleListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private stopCycleRosterPicksListener: (() => void) | null = null;
  private stopSharedScoringListener: (() => void) | null = null;
  private stopHistoricalReplayListener: (() => void) | null = null;
  private liveDraftPicks: DraftPick[] = [];
  private cycleRosterSnapshotPicks: DraftPick[] = [];
  private effectivePicksKey: string | null = null;
  private detailLoadKey: string | null = null;
  private detailRequestId = 0;

  readonly draftPick = computed(
    () => this.picks().find((pick) => pick.asset.assetKey === this.assetKey) ?? null,
  );

  readonly asset = computed(() => this.draftPick()?.asset ?? null);

  readonly scoreSummary = computed(() =>
    resolveCycleAssetScoreSummary(
      this.sharedScoringSnapshot(),
      this.draftPick(),
      this.assetKey,
    ),
  );

  readonly totalFantasyPoints = computed(() => {
    const summaryScore = this.scoreSummary()?.currentScore;

    if (typeof summaryScore === 'number') {
      return Number(summaryScore.toFixed(1));
    }

    return Number(
      this.gameRows()
        .reduce((total, row) => total + (row.fantasyPoints ?? 0), 0)
        .toFixed(1),
    );
  });

  readonly countedGames = computed(() =>
    this.scoreSummary()?.gamesPlayed ?? this.gameRows().filter((row) => row.counted).length,
  );

  readonly actualGamesPlayed = computed(() =>
    this.scoreSummary()?.actualGamesPlayed ?? this.gameRows().filter((row) => row.appeared).length,
  );

  readonly scheduledGames = computed(() =>
    this.scoreSummary()?.scheduledGames ?? this.gameRows().length,
  );

  readonly gamesLeft = computed(() =>
    this.scoreSummary()?.gamesLeft ?? Math.max(0, this.scheduledGames() - this.countedGames()),
  );

  readonly frozenProjectionPoints = computed(() => {
    const asset = this.asset();

    if (!asset) {
      return null;
    }

    const value = asset.frozenCycleProjectionPoints ?? asset.projectedCyclePoints;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });

  readonly expectedPointsThroughCurrentGame = computed(() => {
    const projection = this.frozenProjectionPoints();
    const scheduledGames = Math.max(1, this.scheduledGames());
    const countedGames = Math.min(scheduledGames, Math.max(0, this.countedGames()));

    if (projection === null) {
      return null;
    }

    return Number(((projection * countedGames) / scheduledGames).toFixed(1));
  });

  readonly projectionDelta = computed(() => {
    const expectedThroughCurrentGame = this.expectedPointsThroughCurrentGame();

    return expectedThroughCurrentGame === null
      ? null
      : Number((this.totalFantasyPoints() - expectedThroughCurrentGame).toFixed(1));
  });

  readonly pointsRemainingToProjection = computed(() => {
    const projection = this.frozenProjectionPoints();

    if (projection === null) {
      return null;
    }

    return Number(Math.max(0, projection - this.totalFantasyPoints()).toFixed(1));
  });

  readonly projectionCompletionPercent = computed(() => {
    const projection = this.frozenProjectionPoints();

    if (projection === null || projection <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(100, (this.totalFantasyPoints() / projection) * 100));
  });

  readonly countedMissedGames = computed(() =>
    this.gameRows().filter((row) => row.counted && !row.appeared).length,
  );

  readonly aggregateBreakdownLines = computed(() => {
    const totals = new Map<string, number>();

    for (const row of this.gameRows()) {
      for (const line of row.breakdownLines) {
        if (
          line.label === 'Saved Game Center score' ||
          line.label === 'Scoring reconciliation' ||
          line.label.toLowerCase().includes('did not play')
        ) {
          continue;
        }

        totals.set(line.label, (totals.get(line.label) ?? 0) + line.points);
      }
    }

    return [...totals.entries()]
      .map(([label, points]) => ({
        label,
        points: Number(points.toFixed(1)),
      }))
      .filter((line) => Math.abs(line.points) >= 0.05)
      .sort((first, second) => Math.abs(second.points) - Math.abs(first.points))
      .slice(0, 10);
  });

  readonly largestAggregateContribution = computed(() =>
    this.aggregateBreakdownLines().reduce(
      (largest, line) => Math.max(largest, Math.abs(line.points)),
      0,
    ),
  );

  readonly bestGame = computed(() => {
    const scoredGames = this.gameRows().filter(
      (row) => typeof row.fantasyPoints === 'number',
    );

    return scoredGames.sort(
      (first, second) => (second.fantasyPoints ?? 0) - (first.fantasyPoints ?? 0),
    )[0] ?? null;
  });

  readonly pointsPerAppearance = computed(() => {
    const appearances = this.actualGamesPlayed();

    return appearances > 0
      ? Number((this.totalFantasyPoints() / appearances).toFixed(1))
      : null;
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router,
  ) {
    this.loadPage();
  }

  ngOnDestroy(): void {
    this.stopCycleListener?.();
    this.stopPicksListener?.();
    this.stopCycleRosterPicksListener?.();
    this.stopSharedScoringListener?.();
    this.stopHistoricalReplayListener?.();
  }

  private refreshEffectivePicks(): void {
    const snapshotPicks = this.cycleRosterSnapshotPicks;
    const livePicks = this.liveDraftPicks;
    const effectivePicks = snapshotPicks.length > 0 ? snapshotPicks : livePicks;

    const source = snapshotPicks.length > 0 ? 'cycle-snapshot' : 'live-draft-picks';

    const nextKey = [
      source,
      effectivePicks.map((pick) => `${pick.overallPick}:${pick.asset.assetKey}`).join('|'),
    ].join('::');

    if (this.effectivePicksKey === nextKey) {
      return;
    }

    this.effectivePicksKey = nextKey;
    this.picks.set(effectivePicks);
    this.picksLoaded.set(true);
    this.detailLoadKey = null;
    this.gameRows.set([]);

    void this.loadAssetDetailsIfReady();
  }

  navigateBack(event?: Event): void {
    event?.preventDefault();

    void this.router.navigateByUrl(this.getBackUrl());
  }

  getBackUrl(): string {
    return this.returnToUrl || `/leagues/${this.leagueId}/cycles/${this.cycleNumber}`;
  }

  getBackLinkLabel(): string {
    if (this.returnToUrl.includes('/team')) {
      return 'Back to My Team';
    }

    if (this.returnToUrl.includes('/matchups/')) {
      return 'Back to Matchup';
    }

    if (this.returnToUrl.includes('/matchups')) {
      return 'Back to Matchup Overview';
    }

    if (this.returnToUrl.includes('/standings')) {
      return 'Back to League Standings';
    }

    if (this.returnToUrl.includes('/schedule-preview')) {
      return 'Back to Schedule Preview';
    }

    return `Back to Matchup ${this.cycleNumber}`;
  }

  private getSafeReturnUrl(value: string | null, leagueId: string): string {
    if (!value) {
      return '';
    }

    let decodedValue = value;

    try {
      decodedValue = decodeURIComponent(value);
    } catch {
      decodedValue = value;
    }

    if (!decodedValue.startsWith(`/leagues/${leagueId}`)) {
      return '';
    }

    if (decodedValue.includes('://')) {
      return '';
    }

    return decodedValue;
  }

  async loadPage(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');

    const assetKey = this.route.snapshot.paramMap.get('assetKey');

    const cycleNumberRaw = this.route.snapshot.paramMap.get('cycleNumber');

    const returnToRaw = this.route.snapshot.queryParamMap.get('returnTo');

    const parsedCycleNumber = Number(cycleNumberRaw ?? 1);

    const user = await waitForAuthUser();

    if (
      !leagueId ||
      !assetKey ||
      !user ||
      !Number.isInteger(parsedCycleNumber) ||
      parsedCycleNumber < 1
    ) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.assetKey = assetKey;
    this.userId = user.uid;
    this.cycleNumber = parsedCycleNumber;
    this.returnToUrl = this.getSafeReturnUrl(returnToRaw, leagueId);

    try {
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
      ]);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);

      this.stopCycleListener = listenToCycle(leagueId, this.cycleNumber, (cycle) => {
        this.cycle.set(cycle);
        void this.loadAssetDetailsIfReady();
      });

      this.stopSharedScoringListener = listenToSharedCycleScoring(
        leagueId,
        this.cycleNumber,
        (snapshot) => {
          this.sharedScoringSnapshot.set(snapshot);
          this.detailLoadKey = null;
          void this.loadAssetDetailsIfReady();
        },
        (error) => {
          console.warn('Unable to load the saved Game Center scoring snapshot.', error);
        },
      );

      this.stopHistoricalReplayListener = listenToHistoricalReplayControl(
        leagueId,
        (control) => {
          this.historicalReplayControl.set(control);
          this.detailLoadKey = null;
          void this.loadAssetDetailsIfReady();
        },
        (error) => {
          console.warn('Unable to load historical replay details.', error);
        },
      );

      this.stopCycleRosterPicksListener = listenToCycleRosterPicks(
        leagueId,
        this.cycleNumber,
        (picks) => {
          this.cycleRosterSnapshotPicks = picks;
          this.refreshEffectivePicks();
        },
      );

      this.stopPicksListener = listenToDraftPicks(leagueId, (picks) => {
        this.liveDraftPicks = picks;
        this.refreshEffectivePicks();
      });
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load player detail.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.fullName : `${asset.teamName} Goalie Unit`;
  }

  getAssetTeamLabel(asset: DraftableAsset): string {
    return asset.assetType === 'skater' ? asset.player.nhlTeamAbbreviation : asset.teamAbbreviation;
  }

  getAssetLogoUrl(asset: DraftableAsset): string | undefined {
    return asset.assetType === 'skater' ? asset.player.teamLogoUrl : asset.teamLogoUrl;
  }

  getDraftedByLabel(): string {
    const pick = this.draftPick();

    if (!pick) {
      return 'Unknown Team';
    }

    return this.teams().find((team) => team.ownerId === pick.ownerId)?.teamName ?? 'Unknown Team';
  }

  getProjectionDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getFantasyPointDisplay(value: number | null): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getFrozenProjectionDisplay(asset: DraftableAsset): string {
    return this.getProjectionDisplay(
      asset.frozenCycleProjectionPoints ?? asset.projectedCyclePoints ?? null,
    );
  }

  getProjectionDeltaLabel(): string {
    const delta = this.projectionDelta();
    const countedGames = this.countedGames();

    if (delta === null) {
      return 'Projection pace is not available yet';
    }

    if (countedGames === 0) {
      return 'The six-game projection is frozen and waiting for Game 1';
    }

    if (Math.abs(delta) < 0.05) {
      return `Exactly on expected pace after ${countedGames} ${countedGames === 1 ? 'game' : 'games'}`;
    }

    return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} vs expected pace after ${countedGames} ${countedGames === 1 ? 'game' : 'games'}`;
  }

  getProjectionDeltaClass(): string {
    const delta = this.projectionDelta();

    if (delta === null || Math.abs(delta) < 0.05) {
      return 'projection-delta-even';
    }

    return delta > 0 ? 'projection-delta-ahead' : 'projection-delta-behind';
  }

  getBestGameLabel(): string {
    const row = this.bestGame();

    if (!row || typeof row.fantasyPoints !== 'number') {
      return 'No scored game yet';
    }

    return `${row.fantasyPoints.toFixed(1)} pts · Game ${row.cycleGameNumber}`;
  }

  getPointsPerAppearanceLabel(): string {
    const value = this.pointsPerAppearance();

    return value === null ? '—' : value.toFixed(1);
  }

  getExpectedPaceLabel(): string {
    const value = this.expectedPointsThroughCurrentGame();

    return value === null ? '—' : value.toFixed(1);
  }

  getProjectionRemainingLabel(): string {
    const projection = this.frozenProjectionPoints();
    const remaining = this.pointsRemainingToProjection();

    if (projection === null || remaining === null) {
      return '—';
    }

    return this.totalFantasyPoints() >= projection
      ? 'Projection reached'
      : `${remaining.toFixed(1)} pts`;
  }

  getProjectionRangeLabel(asset: DraftableAsset): string {
    const floor = asset.projectionFloorPoints;
    const ceiling = asset.projectionCeilingPoints;

    if (
      typeof floor !== 'number' ||
      !Number.isFinite(floor) ||
      typeof ceiling !== 'number' ||
      !Number.isFinite(ceiling)
    ) {
      return 'Range unavailable';
    }

    return `${floor.toFixed(1)}–${ceiling.toFixed(1)} pts`;
  }

  getAggregateContributionPercent(points: number): number {
    const maximum = this.largestAggregateContribution();

    if (maximum <= 0) {
      return 0;
    }

    return Math.max(5, Math.min(100, (Math.abs(points) / maximum) * 100));
  }

  getAggregateContributionClass(points: number): string {
    return points < 0 ? 'negative-contribution' : 'positive-contribution';
  }

  getGameTapeClass(row: CycleAssetGameDetail): string {
    return [
      'game-tape-cell',
      this.getGameRowClass(row),
      row.gameId === this.bestGame()?.gameId ? 'best-game-cell' : '',
    ].filter(Boolean).join(' ');
  }

  getGameStatusBadgeClass(row: CycleAssetGameDetail): string {
    if (!row.final) {
      return row.statusLabel.toLowerCase().includes('live')
        ? 'game-status-live'
        : 'game-status-upcoming';
    }

    if (row.appeared) {
      return 'game-status-played';
    }

    return row.counted ? 'game-status-missed' : 'game-status-pending';
  }

  getGameStatusShortLabel(row: CycleAssetGameDetail): string {
    if (!row.final) {
      return row.statusLabel.toLowerCase().includes('live') ? 'Live' : 'Upcoming';
    }

    return row.appeared ? 'Played' : row.counted ? 'Missed · 0' : 'Pending';
  }

  getGameHeadline(row: CycleAssetGameDetail): string {
    if (!row.final) {
      return row.statusLabel.toLowerCase().includes('live')
        ? 'Scoring is still changing'
        : 'Scheduled NHL team game';
    }

    if (!row.appeared && row.counted) {
      return 'Team played, player did not appear';
    }

    return row.appeared ? 'Fantasy points earned' : 'No counted result yet';
  }

  getTopBreakdownLines(row: CycleAssetGameDetail): DetailBreakdownLine[] {
    return [...row.breakdownLines]
      .sort((first, second) => Math.abs(second.points) - Math.abs(first.points))
      .slice(0, 3);
  }

  getRemainingBreakdownCount(row: CycleAssetGameDetail): number {
    return Math.max(0, row.breakdownLines.length - this.getTopBreakdownLines(row).length);
  }

  getGameExplanation(row: CycleAssetGameDetail): string {
    if (!row.final) {
      return row.statusLabel.toLowerCase().includes('live')
        ? 'This game is live. RinkRat will keep updating the saved score until the NHL result is final.'
        : 'This is one of the six scheduled NHL team games assigned to this roster slot.';
    }

    if (!row.appeared && row.counted) {
      return 'The NHL team played, so this used one of the roster slot’s six games. The player did not appear and receives 0 fantasy points.';
    }

    return 'The player appeared in this scheduled team game. The categories below show exactly how the saved fantasy score was built.';
  }

  getFrozenProjectionSourceLabel(asset: DraftableAsset): string {
    switch (asset.frozenProjectionSource) {
      case 'shared-snapshot':
        return `Automatic six-game projection v${asset.frozenProjectionVersion ?? '—'}`;
      case 'draft-pick':
        return 'Draft projection fallback';
      case 'roster':
        return 'Saved roster projection fallback';
      case 'legacy':
        return 'Stable season baseline fallback';
      default:
        return 'Legacy matchup projection';
    }
  }

  formatProjectionTimestamp(value: string | null | undefined): string {
    if (!value) {
      return 'Not recorded';
    }

    const timestamp = Date.parse(value);

    if (!Number.isFinite(timestamp)) {
      return 'Not recorded';
    }

    return new Date(timestamp).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  getCycleGameRangeLabel(): string {
    const summary = this.scoreSummary();
    const firstDate = summary?.firstScheduledGameDate;
    const lastDate = summary?.lastScheduledGameDate;

    if (firstDate && lastDate) {
      return firstDate === lastDate
        ? firstDate
        : `${firstDate} – ${lastDate}`;
    }

    return `This roster spot's ${this.getRequiredGamesPerCycle()} scheduled NHL team games`;
  }

  getDetailSourceNotice(): string {
    const replaySeason = this.getReplaySnapshotSeason();

    if (replaySeason) {
      return `Historical replay: matchup dates follow the ${this.formatSeasonLabel(replaySeason.targetSeason)} schedule, while the point details come from mapped ${this.formatSeasonLabel(replaySeason.sourceSeason)} NHL performances. This is the same saved server scoring snapshot used by Game Center.`;
    }

    if (!this.sharedScoringSnapshot()) {
      return 'RinkRat is waiting for the saved Game Center scoring snapshot. Schedule-based details are shown temporarily and will refresh automatically.';
    }

    return 'This breakdown uses the same saved server scoring snapshot shown in Game Center and refreshes when that snapshot updates.';
  }

  isHistoricalReplayDetail(): boolean {
    return this.getReplaySnapshotSeason() !== null;
  }

  getGameRowClass(row: CycleAssetGameDetail): string {
    if (!row.final) {
      return 'scheduled-game';
    }

    if (!row.appeared && row.counted) {
      return 'counted-dnp-game';
    }

    if (row.appeared) {
      return 'played-game';
    }

    return 'missed-game';
  }

  private async loadAssetDetailsIfReady(): Promise<void> {
    const cycle = this.cycle();
    const league = this.league();
    const asset = this.asset();

    if (!cycle || !league || !asset) {
      return;
    }

    const snapshot = this.sharedScoringSnapshot();
    const scoreSummary = this.scoreSummary();
    const season = this.getScoringDataSeason();
    const scoringRules = league.scoringRules ?? defaultScoringRules;
    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;
    const replayControl = this.historicalReplayControl();

    const loadKey = [
      cycle.id,
      this.cycleNumber,
      asset.assetKey,
      season,
      requiredGamesPerCycle,
      snapshot?.scoringFingerprint ?? 'no-shared-snapshot',
      scoreSummary?.windowId ?? 'no-window-summary',
      scoreSummary
        ? scoreSummary.scheduledGameIds
            .map((gameId) => {
              const gameIdKey = String(gameId);
              return `${gameId}:${scoreSummary.gameStates[gameIdKey] ?? 'scheduled'}:${scoreSummary.gameScores[gameIdKey] ?? ''}`;
            })
            .join('|')
        : '',
      replayControl?.simulatedDate ?? '',
      replayControl?.sourceSeason ?? '',
    ].join('::');

    if (this.detailLoadKey === loadKey) {
      return;
    }

    this.detailLoadKey = loadKey;
    this.detailLoading.set(true);
    this.detailError.set('');

    const requestId = ++this.detailRequestId;

    try {
      let rows: CycleAssetGameDetail[];

      if (scoreSummary && scoreSummary.scheduledGameIds.length > 0) {
        rows = await this.loadSnapshotGameRows(
          asset,
          scoreSummary,
          season,
          scoringRules,
        );
      } else {
        const schedule = await this.loadRegularSeasonSchedule(
          this.getAssetTeamLabel(asset),
          season,
        );
        const games = this.getCycleGamesFromSchedule(schedule, requiredGamesPerCycle);

        rows =
          asset.assetType === 'skater'
            ? await this.loadSkaterGameRows(asset, games, schedule, season, scoringRules)
            : await this.loadGoalieUnitGameRows(asset, games, schedule, scoringRules);
      }

      if (requestId !== this.detailRequestId) {
        return;
      }

      this.gameRows.set(rows);
    } catch (error: unknown) {
      this.detailLoadKey = null;

      this.detailError.set(
        error instanceof Error ? error.message : 'Unable to load player game details.',
      );
    } finally {
      if (requestId === this.detailRequestId) {
        this.detailLoading.set(false);
      }
    }
  }

  private async loadSnapshotGameRows(
    asset: DraftableAsset,
    summary: CycleAssetScoreSummary,
    season: string,
    scoringRules: ScoringRules,
  ): Promise<CycleAssetGameDetail[]> {
    return asset.assetType === 'skater'
      ? this.loadSnapshotSkaterGameRows(asset, summary, season, scoringRules)
      : this.loadSnapshotGoalieUnitGameRows(asset, summary, scoringRules);
  }

  private async loadSnapshotSkaterGameRows(
    asset: DraftableAsset,
    summary: CycleAssetScoreSummary,
    season: string,
    scoringRules: ScoringRules,
  ): Promise<CycleAssetGameDetail[]> {
    if (asset.assetType !== 'skater') {
      return [];
    }

    const gameLogByGameId = new Map<number, NhlPlayerGameLogEntry>();

    try {
      const gameLogResponse = await getRegularSeasonGameLog(asset.player.id, season);

      for (const gameLog of gameLogResponse.gameLog ?? []) {
        gameLogByGameId.set(gameLog.gameId, gameLog);
      }
    } catch (error: unknown) {
      console.warn('Unable to load the player game log for the saved scoring window.', error);
    }

    const rows: CycleAssetGameDetail[] = [];
    const snapshotGames = buildCycleAssetSnapshotGames(summary);
    const replayDetail = this.isHistoricalReplayDetail();

    for (let gameIndex = 0; gameIndex < snapshotGames.length; gameIndex += 1) {
      const snapshotGame = snapshotGames[gameIndex];
      const cycleGameNumber = gameIndex + 1;

      if (snapshotGame.state === 'scheduled') {
        rows.push(
          this.createSnapshotGameRow({
            gameId: snapshotGame.gameId,
            gameDate: snapshotGame.gameDate,
            cycleGameNumber,
            scheduleLabel: snapshotGame.scheduleLabel,
            scoreLabel: 'Scheduled NHL team game',
            statusLabel: 'Scheduled',
            final: false,
            counted: false,
            appeared: false,
            fantasyPoints: null,
            statChips: [],
            breakdownLines: [],
          }),
        );
        continue;
      }

      const gameData = await this.loadGameData(snapshotGame.gameId);
      const gameLog = gameLogByGameId.get(snapshotGame.gameId);
      const skaterLine = gameData
        ? findSkaterBoxscoreLine(gameData.boxscore, asset.player.id)
        : null;
      const appeared = snapshotGame.appeared || Boolean(skaterLine || gameLog);
      const authoritativeScore = snapshotGame.fantasyPoints ?? 0;

      if (!appeared && snapshotGame.state === 'final') {
        rows.push(
          this.createSnapshotGameRow({
            gameId: snapshotGame.gameId,
            gameDate: snapshotGame.gameDate,
            cycleGameNumber,
            scheduleLabel: snapshotGame.scheduleLabel,
            scoreLabel: this.getSnapshotGameSourceLabel(snapshotGame.state, replayDetail),
            statusLabel: 'Did Not Play — 0 pts counted',
            final: true,
            counted: true,
            appeared: false,
            fantasyPoints: authoritativeScore,
            statChips: [
              { label: 'Counted', value: 'Yes' },
              { label: 'Appeared', value: 'No' },
            ],
            breakdownLines: [
              {
                label: 'Did not play / injured / scratched',
                points: authoritativeScore,
              },
            ],
          }),
        );
        continue;
      }

      if (!skaterLine && !gameLog) {
        rows.push(
          this.createSnapshotGameRow({
            gameId: snapshotGame.gameId,
            gameDate: snapshotGame.gameDate,
            cycleGameNumber,
            scheduleLabel: snapshotGame.scheduleLabel,
            scoreLabel: this.getSnapshotGameSourceLabel(snapshotGame.state, replayDetail),
            statusLabel:
              snapshotGame.state === 'live'
                ? 'Live — detailed NHL stats are still updating'
                : 'Final — saved server score',
            final: snapshotGame.state === 'final',
            counted: snapshotGame.counted,
            appeared,
            fantasyPoints: authoritativeScore,
            statChips: [
              { label: 'Server Score', value: authoritativeScore.toFixed(1) },
              { label: 'Detail Data', value: 'Pending' },
            ],
            breakdownLines: [
              {
                label: 'Saved Game Center score',
                points: authoritativeScore,
              },
            ],
          }),
        );
        continue;
      }

      const assistBreakdown = gameData
        ? getSkaterAssistBreakdown(gameData.playByPlay, asset.player.id)
        : {
            primaryAssists: 0,
            secondaryAssists: 0,
          };
      const totalAssists = skaterLine?.assists ?? gameLog?.assists ?? 0;
      let primaryAssists = assistBreakdown.primaryAssists;
      let secondaryAssists = assistBreakdown.secondaryAssists;

      if (primaryAssists + secondaryAssists < totalAssists) {
        secondaryAssists += totalAssists - primaryAssists - secondaryAssists;
      }

      const stats: SkaterGameStats = {
        position: asset.position === 'D' ? 'D' : 'F',
        goals: skaterLine?.goals ?? gameLog?.goals ?? 0,
        primaryAssists,
        secondaryAssists,
        shotsOnGoal: skaterLine?.sog ?? gameLog?.shots ?? 0,
        hits: skaterLine?.hits ?? 0,
        blockedShots: skaterLine?.blockedShots ?? 0,
        plusMinus: skaterLine?.plusMinus ?? gameLog?.plusMinus ?? 0,
        powerPlayPoints: gameLog?.powerPlayPoints ?? skaterLine?.powerPlayGoals ?? 0,
        shortHandedPoints: gameLog?.shorthandedPoints ?? 0,
        gameWinningGoal: Boolean(gameLog?.gameWinningGoals),
        overtimeGoal: Boolean(gameLog?.otGoals),
        timeOnIceMinutes: this.getMinutesFromToi(skaterLine?.toi ?? gameLog?.toi),
      };
      const breakdown = calculateSkaterGameBreakdown(stats, scoringRules);

      rows.push(
        this.createSnapshotGameRow({
          gameId: snapshotGame.gameId,
          gameDate: snapshotGame.gameDate,
          cycleGameNumber,
          scheduleLabel: snapshotGame.scheduleLabel,
          scoreLabel: this.getSnapshotGameSourceLabel(snapshotGame.state, replayDetail),
          statusLabel: snapshotGame.state === 'live' ? 'Live' : 'Played',
          final: snapshotGame.state === 'final',
          counted: snapshotGame.counted,
          appeared: true,
          fantasyPoints: authoritativeScore,
          statChips: [
            { label: 'G', value: stats.goals.toString() },
            { label: '1A', value: stats.primaryAssists.toString() },
            { label: '2A', value: stats.secondaryAssists.toString() },
            { label: 'SOG', value: stats.shotsOnGoal.toString() },
            { label: 'Hits', value: stats.hits.toString() },
            { label: 'Blocks', value: stats.blockedShots.toString() },
            { label: '+/-', value: stats.plusMinus.toString() },
            { label: 'TOI', value: stats.timeOnIceMinutes.toFixed(1) },
          ],
          breakdownLines: this.reconcileBreakdownLines(
            this.mapBreakdownLines(breakdown.lines),
            breakdown.total,
            authoritativeScore,
          ),
        }),
      );
    }

    return rows;
  }

  private async loadSnapshotGoalieUnitGameRows(
    asset: DraftableAsset,
    summary: CycleAssetScoreSummary,
    scoringRules: ScoringRules,
  ): Promise<CycleAssetGameDetail[]> {
    if (asset.assetType === 'skater') {
      return [];
    }

    const rows: CycleAssetGameDetail[] = [];
    const snapshotGames = buildCycleAssetSnapshotGames(summary);
    const replayDetail = this.isHistoricalReplayDetail();

    for (let gameIndex = 0; gameIndex < snapshotGames.length; gameIndex += 1) {
      const snapshotGame = snapshotGames[gameIndex];
      const cycleGameNumber = gameIndex + 1;

      if (snapshotGame.state === 'scheduled') {
        rows.push(
          this.createSnapshotGameRow({
            gameId: snapshotGame.gameId,
            gameDate: snapshotGame.gameDate,
            cycleGameNumber,
            scheduleLabel: snapshotGame.scheduleLabel,
            scoreLabel: 'Scheduled NHL team game',
            statusLabel: 'Scheduled',
            final: false,
            counted: false,
            appeared: false,
            fantasyPoints: null,
            statChips: [],
            breakdownLines: [],
          }),
        );
        continue;
      }

      const authoritativeScore = snapshotGame.fantasyPoints ?? 0;
      const gameData = await this.loadGameData(snapshotGame.gameId);
      const goalieResult = gameData
        ? getTeamGoalieUnitResult(gameData.boxscore, asset.teamAbbreviation)
        : null;

      if (!goalieResult) {
        rows.push(
          this.createSnapshotGameRow({
            gameId: snapshotGame.gameId,
            gameDate: snapshotGame.gameDate,
            cycleGameNumber,
            scheduleLabel: snapshotGame.scheduleLabel,
            scoreLabel: this.getSnapshotGameSourceLabel(snapshotGame.state, replayDetail),
            statusLabel:
              snapshotGame.state === 'live'
                ? 'Live — goalie detail is still updating'
                : 'Final — saved server score',
            final: snapshotGame.state === 'final',
            counted: snapshotGame.counted,
            appeared: snapshotGame.appeared,
            fantasyPoints: authoritativeScore,
            statChips: [
              { label: 'Server Score', value: authoritativeScore.toFixed(1) },
              { label: 'Detail Data', value: 'Pending' },
            ],
            breakdownLines: [
              {
                label: 'Saved Game Center score',
                points: authoritativeScore,
              },
            ],
          }),
        );
        continue;
      }

      const savePercentage =
        goalieResult.shotsAgainst > 0 ? goalieResult.saves / goalieResult.shotsAgainst : 0;
      const stats: GoalieGameStats = {
        saves: goalieResult.saves,
        shotsAgainst: goalieResult.shotsAgainst,
        won: goalieResult.won,
        shutout: goalieResult.shutout,
      };
      const breakdown = calculateGoalieGameBreakdown(stats, scoringRules);

      rows.push(
        this.createSnapshotGameRow({
          gameId: snapshotGame.gameId,
          gameDate: snapshotGame.gameDate,
          cycleGameNumber,
          scheduleLabel: snapshotGame.scheduleLabel,
          scoreLabel: this.getSnapshotGameSourceLabel(snapshotGame.state, replayDetail),
          statusLabel:
            snapshotGame.state === 'live'
              ? 'Live'
              : goalieResult.won
                ? 'Win'
                : 'Loss',
          final: snapshotGame.state === 'final',
          counted: snapshotGame.counted,
          appeared: true,
          fantasyPoints: authoritativeScore,
          statChips: [
            { label: 'Saves', value: goalieResult.saves.toString() },
            { label: 'Shots', value: goalieResult.shotsAgainst.toString() },
            { label: 'SV%', value: `${(savePercentage * 100).toFixed(1)}%` },
            { label: 'SO', value: goalieResult.shutout ? 'Yes' : 'No' },
          ],
          breakdownLines: this.reconcileBreakdownLines(
            this.mapBreakdownLines(breakdown.lines),
            breakdown.total,
            authoritativeScore,
          ),
        }),
      );
    }

    return rows;
  }

  private async loadSkaterGameRows(
    asset: DraftableAsset,
    games: NhlTeamSeasonGame[],
    fullSchedule: NhlTeamSeasonGame[],
    season: string,
    scoringRules: ScoringRules,
  ): Promise<CycleAssetGameDetail[]> {
    if (asset.assetType !== 'skater') {
      return [];
    }

    const gameLogResponse = await getRegularSeasonGameLog(asset.player.id, season);

    const gameLogByGameId = new Map<number, NhlPlayerGameLogEntry>();

    for (const gameLog of gameLogResponse.gameLog ?? []) {
      gameLogByGameId.set(gameLog.gameId, gameLog);
    }

    const rows: CycleAssetGameDetail[] = [];

    for (let gameIndex = 0; gameIndex < games.length; gameIndex += 1) {
      const game = games[gameIndex];
      const final = this.isFinalGame(game);
      const teamGameNumber = this.getTeamGameNumber(fullSchedule, game);
      const cycleGameNumber = gameIndex + 1;

      if (!final) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            teamGameNumber,
            cycleGameNumber,
            'Scheduled',
            false,
            false,
            false,
            null,
            [],
            [],
          ),
        );
        continue;
      }

      const finalGameData = await this.loadGameData(game.id);

      const gameLog = gameLogByGameId.get(game.id);

      const skaterLine = finalGameData
        ? findSkaterBoxscoreLine(finalGameData.boxscore, asset.player.id)
        : null;

      if (!skaterLine && !gameLog) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            teamGameNumber,
            cycleGameNumber,
            'Did Not Play — 0 pts counted',
            true,
            true,
            false,
            0,
            [
              { label: 'Counted', value: 'Yes' },
              { label: 'Appeared', value: 'No' },
            ],
            [
              {
                label: 'Did not play / injured / scratched',
                points: 0,
              },
            ],
          ),
        );
        continue;
      }

      const assistBreakdown = finalGameData
        ? getSkaterAssistBreakdown(finalGameData.playByPlay, asset.player.id)
        : {
            primaryAssists: 0,
            secondaryAssists: 0,
          };

      const totalAssists = skaterLine?.assists ?? gameLog?.assists ?? 0;

      let primaryAssists = assistBreakdown.primaryAssists;

      let secondaryAssists = assistBreakdown.secondaryAssists;

      if (primaryAssists + secondaryAssists < totalAssists) {
        secondaryAssists += totalAssists - primaryAssists - secondaryAssists;
      }

      const stats: SkaterGameStats = {
        position: asset.position === 'D' ? 'D' : 'F',
        goals: skaterLine?.goals ?? gameLog?.goals ?? 0,
        primaryAssists,
        secondaryAssists,
        shotsOnGoal: skaterLine?.sog ?? gameLog?.shots ?? 0,
        hits: skaterLine?.hits ?? 0,
        blockedShots: skaterLine?.blockedShots ?? 0,
        plusMinus: skaterLine?.plusMinus ?? gameLog?.plusMinus ?? 0,
        powerPlayPoints: gameLog?.powerPlayPoints ?? skaterLine?.powerPlayGoals ?? 0,
        shortHandedPoints: gameLog?.shorthandedPoints ?? 0,
        gameWinningGoal: Boolean(gameLog?.gameWinningGoals),
        overtimeGoal: Boolean(gameLog?.otGoals),
        timeOnIceMinutes: this.getMinutesFromToi(skaterLine?.toi ?? gameLog?.toi),
      };

      const breakdown = calculateSkaterGameBreakdown(stats, scoringRules);

      rows.push(
        this.createBaseGameRow(
          asset,
          game,
          teamGameNumber,
          cycleGameNumber,
          'Played',
          true,
          true,
          true,
          breakdown.total,
          [
            { label: 'G', value: stats.goals.toString() },
            { label: '1A', value: stats.primaryAssists.toString() },
            { label: '2A', value: stats.secondaryAssists.toString() },
            { label: 'SOG', value: stats.shotsOnGoal.toString() },
            { label: 'Hits', value: stats.hits.toString() },
            { label: 'Blocks', value: stats.blockedShots.toString() },
            { label: '+/-', value: stats.plusMinus.toString() },
            { label: 'TOI', value: stats.timeOnIceMinutes.toFixed(1) },
          ],
          this.mapBreakdownLines(breakdown.lines),
        ),
      );
    }

    return rows;
  }

  private async loadGoalieUnitGameRows(
    asset: DraftableAsset,
    games: NhlTeamSeasonGame[],
    fullSchedule: NhlTeamSeasonGame[],
    scoringRules: ScoringRules,
  ): Promise<CycleAssetGameDetail[]> {
    if (asset.assetType === 'skater') {
      return [];
    }

    const rows: CycleAssetGameDetail[] = [];

    for (let gameIndex = 0; gameIndex < games.length; gameIndex += 1) {
      const game = games[gameIndex];
      const final = this.isFinalGame(game);
      const teamGameNumber = this.getTeamGameNumber(fullSchedule, game);
      const cycleGameNumber = gameIndex + 1;

      if (!final) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            teamGameNumber,
            cycleGameNumber,
            'Scheduled',
            false,
            false,
            false,
            null,
            [],
            [],
          ),
        );
        continue;
      }

      const finalGameData = await this.loadGameData(game.id);

      if (!finalGameData) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            teamGameNumber,
            cycleGameNumber,
            'Final Data Unavailable — 0 pts counted',
            true,
            true,
            false,
            0,
            [
              { label: 'Counted', value: 'Yes' },
              { label: 'Data', value: 'Unavailable' },
            ],
            [
              {
                label: 'Final goalie data unavailable',
                points: 0,
              },
            ],
          ),
        );
        continue;
      }

      const goalieResult = getTeamGoalieUnitResult(finalGameData.boxscore, asset.teamAbbreviation);

      if (!goalieResult) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            teamGameNumber,
            cycleGameNumber,
            'No Goalie Data — 0 pts counted',
            true,
            true,
            false,
            0,
            [
              { label: 'Counted', value: 'Yes' },
              { label: 'Goalie Data', value: 'No' },
            ],
            [
              {
                label: 'No goalie data found',
                points: 0,
              },
            ],
          ),
        );
        continue;
      }

      const savePercentage =
        goalieResult.shotsAgainst > 0 ? goalieResult.saves / goalieResult.shotsAgainst : 0;

      const stats: GoalieGameStats = {
        saves: goalieResult.saves,
        shotsAgainst: goalieResult.shotsAgainst,
        won: goalieResult.won,
        shutout: goalieResult.shutout,
      };

      const breakdown = calculateGoalieGameBreakdown(stats, scoringRules);

      rows.push(
        this.createBaseGameRow(
          asset,
          game,
          teamGameNumber,
          cycleGameNumber,
          goalieResult.won ? 'Win' : 'Loss',
          true,
          true,
          true,
          breakdown.total,
          [
            { label: 'Saves', value: goalieResult.saves.toString() },
            { label: 'Shots', value: goalieResult.shotsAgainst.toString() },
            { label: 'SV%', value: `${(savePercentage * 100).toFixed(1)}%` },
            { label: 'SO', value: goalieResult.shutout ? 'Yes' : 'No' },
          ],
          this.mapBreakdownLines(breakdown.lines),
        ),
      );
    }

    return rows;
  }

  private async loadRegularSeasonSchedule(
    teamAbbreviation: string,
    season: string,
  ): Promise<NhlTeamSeasonGame[]> {
    const schedule = await getNhlTeamSeasonSchedule(teamAbbreviation, season);

    return schedule
      .filter((game) => typeof game.gameType !== 'number' || game.gameType === 2)
      .sort((first, second) => {
        const dateCompare = first.gameDate.localeCompare(second.gameDate);

        if (dateCompare !== 0) {
          return dateCompare;
        }

        return first.id - second.id;
      });
  }

  private getCycleGamesFromSchedule(
    schedule: NhlTeamSeasonGame[],
    requiredGamesPerCycle: number,
  ): NhlTeamSeasonGame[] {
    const startIndex = Math.max(0, (this.cycleNumber - 1) * requiredGamesPerCycle);

    const endIndex = this.cycleNumber * requiredGamesPerCycle;

    return schedule.slice(startIndex, endIndex);
  }

  private getTeamGameNumber(schedule: NhlTeamSeasonGame[], game: NhlTeamSeasonGame): number {
    return schedule.findIndex((candidate) => candidate.id === game.id) + 1;
  }

  private async loadGameData(gameId: number): Promise<GameDetailData | null> {
    try {
      const [boxscore, playByPlay] = await Promise.all([
        getGameBoxscore(gameId),
        getGamePlayByPlay(gameId),
      ]);

      return {
        boxscore,
        playByPlay,
      };
    } catch (error: unknown) {
      console.warn('Unable to load game detail.', error);

      return null;
    }
  }

  private createSnapshotGameRow(input: {
    gameId: number;
    gameDate: string;
    cycleGameNumber: number;
    scheduleLabel: string;
    scoreLabel: string;
    statusLabel: string;
    final: boolean;
    counted: boolean;
    appeared: boolean;
    fantasyPoints: number | null;
    statChips: DetailStatChip[];
    breakdownLines: DetailBreakdownLine[];
  }): CycleAssetGameDetail {
    return {
      gameId: input.gameId,
      gameDate: input.gameDate,
      teamGameNumber: 0,
      cycleGameNumber: input.cycleGameNumber,
      opponentAbbreviation: input.scheduleLabel.replace(/^(?:vs|@)\s+/i, ''),
      scheduleLabel: input.scheduleLabel,
      scoreLabel: input.scoreLabel,
      statusLabel: input.statusLabel,
      final: input.final,
      counted: input.counted,
      appeared: input.appeared,
      fantasyPoints: input.fantasyPoints,
      statChips: input.statChips,
      breakdownLines: input.breakdownLines,
    };
  }

  private reconcileBreakdownLines(
    lines: DetailBreakdownLine[],
    calculatedScore: number,
    authoritativeScore: number,
  ): DetailBreakdownLine[] {
    const difference = Number((authoritativeScore - calculatedScore).toFixed(1));

    if (Math.abs(difference) < 0.05) {
      return lines;
    }

    return [
      ...lines,
      {
        label: 'Saved server scoring reconciliation',
        points: difference,
      },
    ];
  }

  private getSnapshotGameSourceLabel(
    state: 'scheduled' | 'live' | 'final',
    replayDetail: boolean,
  ): string {
    if (state === 'scheduled') {
      return 'Scheduled NHL team game';
    }

    if (replayDetail) {
      return state === 'live'
        ? 'Historical replay game is being released'
        : 'Historical replay source game';
    }

    return state === 'live' ? 'Live NHL game' : 'Final NHL result';
  }

  private getScoringDataSeason(): string {
    const fallbackSeason = this.getNhlSeasonForDate(this.getSeasonReferenceDate());

    return resolveCycleAssetDetailSeason({
      snapshotSeason: this.sharedScoringSnapshot()?.season,
      replaySourceSeason:
        this.historicalReplayControl()?.enabled === true
          ? this.historicalReplayControl()?.sourceSeason
          : null,
      fallbackSeason,
    });
  }

  private getReplaySnapshotSeason(): { targetSeason: string; sourceSeason: string } | null {
    const control = this.historicalReplayControl();

    if (
      control?.enabled === true &&
      /^\d{8}$/.test(control.targetSeason) &&
      /^\d{8}$/.test(control.sourceSeason)
    ) {
      return {
        targetSeason: control.targetSeason,
        sourceSeason: control.sourceSeason,
      };
    }

    return parseReplaySnapshotSeason(this.sharedScoringSnapshot()?.season);
  }

  private formatSeasonLabel(season: string): string {
    if (!/^\d{8}$/.test(season)) {
      return season;
    }

    return `${season.slice(0, 4)}–${season.slice(6)}`;
  }

  private createBaseGameRow(
    asset: DraftableAsset,
    game: NhlTeamSeasonGame,
    teamGameNumber: number,
    cycleGameNumber: number,
    statusLabel: string,
    final: boolean,
    counted: boolean,
    appeared: boolean,
    fantasyPoints: number | null,
    statChips: DetailStatChip[],
    breakdownLines: DetailBreakdownLine[],
  ): CycleAssetGameDetail {
    return {
      gameId: game.id,
      gameDate: game.gameDate,
      teamGameNumber,
      cycleGameNumber,
      opponentAbbreviation: this.getOpponentAbbreviation(asset, game),
      scheduleLabel: this.getScheduleLabel(asset, game),
      scoreLabel: this.getGameScoreLabel(game),
      statusLabel,
      final,
      counted,
      appeared,
      fantasyPoints,
      statChips,
      breakdownLines,
    };
  }

  private mapBreakdownLines(
    lines: Array<{ label: string; points: number }>,
  ): DetailBreakdownLine[] {
    return lines.map((line) => ({
      label: line.label,
      points: line.points,
    }));
  }

  private getOpponentAbbreviation(asset: DraftableAsset, game: NhlTeamSeasonGame): string {
    const teamAbbreviation = this.getAssetTeamLabel(asset).toUpperCase();

    return game.homeTeam.abbrev.toUpperCase() === teamAbbreviation
      ? game.awayTeam.abbrev
      : game.homeTeam.abbrev;
  }

  private getScheduleLabel(asset: DraftableAsset, game: NhlTeamSeasonGame): string {
    const teamAbbreviation = this.getAssetTeamLabel(asset).toUpperCase();

    return game.homeTeam.abbrev.toUpperCase() === teamAbbreviation
      ? `vs ${game.awayTeam.abbrev}`
      : `@ ${game.homeTeam.abbrev}`;
  }

  private getGameScoreLabel(game: NhlTeamSeasonGame): string {
    const hasScore =
      typeof game.homeTeam.score === 'number' && typeof game.awayTeam.score === 'number';

    if (!hasScore) {
      return `${game.awayTeam.abbrev} @ ${game.homeTeam.abbrev}`;
    }

    return `${game.awayTeam.abbrev} ${game.awayTeam.score} @ ${game.homeTeam.abbrev} ${game.homeTeam.score}`;
  }

  private isFinalGame(game: NhlTeamSeasonGame): boolean {
    const hasScores =
      typeof game.homeTeam.score === 'number' && typeof game.awayTeam.score === 'number';

    return game.gameState === 'OFF' || game.gameState === 'FINAL' || hasScores;
  }

  private getRequiredGamesPerCycle(): number {
    return (
      this.league()?.scoringRules?.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle
    );
  }

  private getSeasonReferenceDate(): Date {
    const replayDate = this.historicalReplayControl()?.simulatedDate;

    if (replayDate) {
      const parsedReplayDate = new Date(`${replayDate}T12:00:00Z`);

      if (!Number.isNaN(parsedReplayDate.getTime())) {
        return parsedReplayDate;
      }
    }

    const historicalTestDate = getHistoricalScoringTestDate();

    if (historicalTestDate) {
      return historicalTestDate;
    }

    const cycleDate = this.getDateFromUnknown(this.cycle()?.startedAt);

    return cycleDate ?? new Date();
  }

  private getDateFromUnknown(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'object' && value !== null && 'toDate' in value) {
      const timestampLike = value as {
        toDate?: () => Date;
      };

      if (typeof timestampLike.toDate === 'function') {
        return timestampLike.toDate();
      }
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsedDate = new Date(value);

      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return null;
  }

  private getNhlSeasonForDate(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    const seasonStartYear = month >= 7 ? year : year - 1;

    return `${seasonStartYear}${seasonStartYear + 1}`;
  }

  private getMinutesFromToi(toi: string | undefined): number {
    if (!toi) {
      return 0;
    }

    const [minutesRaw, secondsRaw] = toi.split(':');
    const minutes = Number(minutesRaw);
    const seconds = Number(secondsRaw);

    if (Number.isNaN(minutes) || Number.isNaN(seconds)) {
      return 0;
    }

    return Number((minutes + seconds / 60).toFixed(2));
  }
}
