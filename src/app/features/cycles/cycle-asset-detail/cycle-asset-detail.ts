import { Component, computed, OnDestroy, signal } from '@angular/core';

import { ActivatedRoute, Router } from '@angular/router';

import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import { DraftableAsset, DraftPick } from '../../../core/draft/draft.models';

import { listenToDraftPicks } from '../../../core/draft/draft.service';

import { FantasyCycle } from '../../../core/cycle/cycle.models';

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

interface DetailStatChip {
  label: string;
  value: string;
}

interface DetailBreakdownLine {
  label: string;
  points: number;
}

interface FinalGameData {
  boxscore: NhlGameBoxscoreResponse;
  playByPlay: NhlGamePlayByPlayResponse;
}

interface CycleAssetGameDetail {
  gameId: number;
  gameDate: string;
  teamGameNumber: number;
  cycleGameNumber: number;
  opponentAbbreviation: string;
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

  loading = signal(true);
  detailLoading = signal(false);
  errorMessage = signal('');
  detailError = signal('');

  gameRows = signal<CycleAssetGameDetail[]>([]);

  private stopCycleListener: (() => void) | null = null;
  private stopPicksListener: (() => void) | null = null;
  private stopCycleRosterPicksListener: (() => void) | null = null;
  private liveDraftPicks: DraftPick[] = [];
  private cycleRosterSnapshotPicks: DraftPick[] = [];
  private effectivePicksKey: string | null = null;
  private detailLoadKey: string | null = null;
  private detailRequestId = 0;

  readonly draftPick = computed(
    () => this.picks().find((pick) => pick.asset.assetKey === this.assetKey) ?? null,
  );

  readonly asset = computed(() => this.draftPick()?.asset ?? null);

  readonly totalFantasyPoints = computed(() =>
    Number(
      this.gameRows()
        .reduce((total, row) => total + (row.fantasyPoints ?? 0), 0)
        .toFixed(1),
    ),
  );

  readonly countedGames = computed(() => this.gameRows().filter((row) => row.counted).length);

  readonly actualGamesPlayed = computed(() => this.gameRows().filter((row) => row.appeared).length);

  readonly scheduledGames = computed(() => this.gameRows().length);

  readonly gamesLeft = computed(() => Math.max(0, this.scheduledGames() - this.countedGames()));

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

    return `Back to Cycle ${this.cycleNumber}`;
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

  getFrozenProjectionSourceLabel(asset: DraftableAsset): string {
    switch (asset.frozenProjectionSource) {
      case 'shared-snapshot':
        return `Automatic window projection v${asset.frozenProjectionVersion ?? '—'}`;
      case 'draft-pick':
        return 'Draft projection fallback';
      case 'roster':
        return 'Saved roster projection fallback';
      case 'legacy':
        return 'Stable season baseline fallback';
      default:
        return 'Legacy cycle projection';
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
    const requiredGamesPerCycle = this.getRequiredGamesPerCycle();

    const startGameNumber = (this.cycleNumber - 1) * requiredGamesPerCycle + 1;

    const endGameNumber = this.cycleNumber * requiredGamesPerCycle;

    return `NHL team games ${startGameNumber}–${endGameNumber}`;
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

    const season = this.getNhlSeasonForDate(this.getSeasonReferenceDate());

    const scoringRules = league.scoringRules ?? defaultScoringRules;

    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;

    const loadKey = [
      cycle.id,
      this.cycleNumber,
      asset.assetKey,
      season,
      requiredGamesPerCycle,
    ].join('::');

    if (this.detailLoadKey === loadKey) {
      return;
    }

    this.detailLoadKey = loadKey;
    this.detailLoading.set(true);
    this.detailError.set('');

    const requestId = ++this.detailRequestId;

    try {
      const schedule = await this.loadRegularSeasonSchedule(this.getAssetTeamLabel(asset), season);

      const games = this.getCycleGamesFromSchedule(schedule, requiredGamesPerCycle);

      const rows =
        asset.assetType === 'skater'
          ? await this.loadSkaterGameRows(asset, games, schedule, season, scoringRules)
          : await this.loadGoalieUnitGameRows(asset, games, schedule, scoringRules);

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

      const finalGameData = await this.loadFinalGameData(game.id);

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

      const finalGameData = await this.loadFinalGameData(game.id);

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

  private async loadFinalGameData(gameId: number): Promise<FinalGameData | null> {
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
