import {
  Component,
  computed,
  OnDestroy,
  signal
} from '@angular/core';

import {
  ActivatedRoute,
  Router,
  RouterLink
} from '@angular/router';

import {
  onAuthStateChanged,
  User
} from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  DraftableAsset,
  DraftPick
} from '../../../core/draft/draft.models';

import {
  listenToDraftPicks
} from '../../../core/draft/draft.service';

import {
  FantasyCycle
} from '../../../core/cycle/cycle.models';

import {
  listenToCycleOne
} from '../../../core/cycle/cycle.service';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

import {
  calculateGoalieGameBreakdown,
  calculateSkaterGameBreakdown,
  GoalieGameStats,
  PointBreakdownLine,
  SkaterGameStats
} from '../../../core/scoring/scoring-engine';

import {
  defaultScoringRules,
  ScoringRules
} from '../../../core/scoring/scoring-rules';

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
  NhlTeamSeasonGame
} from '../../../core/nhl/nhl-api.service';

const CYCLE_PROJECTION_WINDOW_DAYS = 14;

interface DetailStatChip {
  label: string;
  value: string;
}

interface CycleAssetGameDetail {
  gameId: number;
  gameDate: string;
  opponentAbbreviation: string;
  scoreLabel: string;
  statusLabel: string;
  final: boolean;
  played: boolean;
  fantasyPoints: number | null;
  statChips: DetailStatChip[];
  breakdownLines: PointBreakdownLine[];
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
  imports: [RouterLink],
  templateUrl: './cycle-asset-detail.html',
  styleUrl: './cycle-asset-detail.css'
})
export class CycleAssetDetail implements OnDestroy {
  leagueId = '';
  assetKey = '';
  userId = '';

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
  private detailLoadKey: string | null = null;
  private detailRequestId = 0;

  readonly draftPick = computed(() =>
    this.picks().find(
      (pick) => pick.asset.assetKey === this.assetKey
    ) ?? null
  );

  readonly asset = computed(() =>
    this.draftPick()?.asset ?? null
  );

  readonly totalFantasyPoints = computed(() =>
    Number(
      this.gameRows()
        .reduce(
          (total, row) =>
            total + (row.fantasyPoints ?? 0),
          0
        )
        .toFixed(1)
    )
  );

  readonly gamesPlayed = computed(() =>
    this.gameRows().filter((row) => row.played).length
  );

  readonly scheduledGames = computed(() =>
    this.gameRows().length
  );

  readonly gamesLeft = computed(() =>
    Math.max(
      0,
      this.scheduledGames() - this.gamesPlayed()
    )
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadPage();
  }

  ngOnDestroy(): void {
    this.stopCycleListener?.();
    this.stopPicksListener?.();
  }

  async loadPage(): Promise<void> {
    const leagueId =
      this.route.snapshot.paramMap.get('leagueId');

    const assetKey =
      this.route.snapshot.paramMap.get('assetKey');

    const user = await waitForAuthUser();

    if (!leagueId || !assetKey || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.assetKey = assetKey;
    this.userId = user.uid;

    try {
      const [league, teams] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId)
      ]);

      if (!league) {
        this.errorMessage.set('League not found.');
        return;
      }

      this.league.set(league);
      this.teams.set(teams);

      this.stopCycleListener = listenToCycleOne(
        leagueId,
        (cycle) => {
          this.cycle.set(cycle);
          void this.loadAssetDetailsIfReady();
        }
      );

      this.stopPicksListener = listenToDraftPicks(
        leagueId,
        (picks) => {
          this.picks.set(picks);
          this.picksLoaded.set(true);
          void this.loadAssetDetailsIfReady();
        }
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load player detail.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  getAssetName(asset: DraftableAsset): string {
    return asset.assetType === 'skater'
      ? asset.player.fullName
      : `${asset.teamName} Goalie Unit`;
  }

  getAssetTeamLabel(asset: DraftableAsset): string {
    return asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation;
  }

  getAssetLogoUrl(asset: DraftableAsset): string | undefined {
    return asset.assetType === 'skater'
      ? asset.player.teamLogoUrl
      : asset.teamLogoUrl;
  }

  getDraftedByLabel(): string {
    const pick = this.draftPick();

    if (!pick) {
      return 'Unknown Team';
    }

    return this.teams().find(
      (team) => team.ownerId === pick.ownerId
    )?.teamName ?? 'Unknown Team';
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

  getCycleWindowLabel(): string {
    const startDate = this.getCycleWindowStartDate();
    const endDate = this.getCycleWindowEndDate();

    if (!startDate || !endDate) {
      return 'Cycle window unavailable';
    }

    return `${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`;
  }

  getGameRowClass(row: CycleAssetGameDetail): string {
    if (!row.final) {
      return 'scheduled-game';
    }

    if (row.played) {
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

    const startDate =
      this.getCycleWindowStartDate() ?? new Date();

    const endDate =
      this.getCycleWindowEndDateFromStart(startDate);

    const season =
      this.getNhlSeasonForDate(startDate);

    const scoringRules =
      league.scoringRules ?? defaultScoringRules;

    const requiredGamesPerCycle =
      scoringRules.requiredGamesPerCycle ??
      defaultScoringRules.requiredGamesPerCycle;

    const loadKey = [
      cycle.id,
      asset.assetKey,
      this.getDateKey(startDate),
      this.getDateKey(endDate),
      requiredGamesPerCycle
    ].join('::');

    if (this.detailLoadKey === loadKey) {
      return;
    }

    this.detailLoadKey = loadKey;
    this.detailLoading.set(true);
    this.detailError.set('');

    const requestId = ++this.detailRequestId;

    try {
      const schedule =
        await getNhlTeamSeasonSchedule(
          this.getAssetTeamLabel(asset),
          season
        );

      const games = schedule
        .filter((game) =>
          this.isGameInCycleWindow(
            game.gameDate,
            startDate,
            endDate
          )
        )
        .slice(0, requiredGamesPerCycle);

      const rows =
        asset.assetType === 'skater'
          ? await this.loadSkaterGameRows(
              asset,
              games,
              season,
              scoringRules
            )
          : await this.loadGoalieUnitGameRows(
              asset,
              games,
              scoringRules
            );

      if (requestId !== this.detailRequestId) {
        return;
      }

      this.gameRows.set(rows);
    } catch (error: unknown) {
      this.detailLoadKey = null;

      this.detailError.set(
        error instanceof Error
          ? error.message
          : 'Unable to load player game details.'
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
    season: string,
    scoringRules: ScoringRules
  ): Promise<CycleAssetGameDetail[]> {
    if (asset.assetType !== 'skater') {
      return [];
    }

    const gameLogResponse =
      await getRegularSeasonGameLog(
        asset.player.id,
        season
      );

    const gameLogByGameId =
      new Map<number, NhlPlayerGameLogEntry>();

    for (const gameLog of gameLogResponse.gameLog ?? []) {
      gameLogByGameId.set(gameLog.gameId, gameLog);
    }

    const rows: CycleAssetGameDetail[] = [];

    for (const game of games) {
      const final = this.isFinalGame(game);
      const gameLog = gameLogByGameId.get(game.id);

      if (!final) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            'Scheduled',
            false,
            false,
            null,
            [],
            []
          )
        );
        continue;
      }

      const finalGameData =
        await this.loadFinalGameData(game.id);

      const skaterLine = finalGameData
        ? findSkaterBoxscoreLine(
            finalGameData.boxscore,
            asset.player.id
          )
        : null;

      if (!skaterLine && !gameLog) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            'Did Not Play',
            true,
            false,
            null,
            [],
            []
          )
        );
        continue;
      }

      const assistBreakdown = finalGameData
        ? getSkaterAssistBreakdown(
            finalGameData.playByPlay,
            asset.player.id
          )
        : {
            primaryAssists: 0,
            secondaryAssists: 0
          };

      const totalAssists =
        skaterLine?.assists ??
        gameLog?.assists ??
        0;

      let primaryAssists =
        assistBreakdown.primaryAssists;

      let secondaryAssists =
        assistBreakdown.secondaryAssists;

      if (primaryAssists + secondaryAssists < totalAssists) {
        secondaryAssists +=
          totalAssists -
          primaryAssists -
          secondaryAssists;
      }

      const stats: SkaterGameStats = {
        position: asset.position === 'D' ? 'D' : 'F',
        goals: skaterLine?.goals ?? gameLog?.goals ?? 0,
        primaryAssists,
        secondaryAssists,
        shotsOnGoal: skaterLine?.sog ?? gameLog?.shots ?? 0,
        hits: skaterLine?.hits ?? 0,
        blockedShots: skaterLine?.blockedShots ?? 0,
        plusMinus:
          skaterLine?.plusMinus ??
          gameLog?.plusMinus ??
          0,
        powerPlayPoints:
          gameLog?.powerPlayPoints ??
          skaterLine?.powerPlayGoals ??
          0,
        shortHandedPoints:
          gameLog?.shorthandedPoints ?? 0,
        gameWinningGoal:
          Boolean(gameLog?.gameWinningGoals),
        overtimeGoal:
          Boolean(gameLog?.otGoals),
        timeOnIceMinutes:
          this.getMinutesFromToi(
            skaterLine?.toi ?? gameLog?.toi
          )
      };

      const breakdown =
        calculateSkaterGameBreakdown(
          stats,
          scoringRules
        );

      rows.push(
        this.createBaseGameRow(
          asset,
          game,
          'Played',
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
            { label: 'TOI', value: stats.timeOnIceMinutes.toFixed(1) }
          ],
          breakdown.lines
        )
      );
    }

    return rows;
  }

  private async loadGoalieUnitGameRows(
    asset: DraftableAsset,
    games: NhlTeamSeasonGame[],
    scoringRules: ScoringRules
  ): Promise<CycleAssetGameDetail[]> {
    if (asset.assetType === 'skater') {
      return [];
    }

    const rows: CycleAssetGameDetail[] = [];

    for (const game of games) {
      const final = this.isFinalGame(game);

      if (!final) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            'Scheduled',
            false,
            false,
            null,
            [],
            []
          )
        );
        continue;
      }

      const finalGameData =
        await this.loadFinalGameData(game.id);

      if (!finalGameData) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            'Final Data Unavailable',
            true,
            false,
            null,
            [],
            []
          )
        );
        continue;
      }

      const goalieResult =
        getTeamGoalieUnitResult(
          finalGameData.boxscore,
          asset.teamAbbreviation
        );

      if (!goalieResult) {
        rows.push(
          this.createBaseGameRow(
            asset,
            game,
            'No Goalie Data',
            true,
            false,
            null,
            [],
            []
          )
        );
        continue;
      }

      const savePercentage =
        goalieResult.shotsAgainst > 0
          ? goalieResult.saves / goalieResult.shotsAgainst
          : 0;

      const stats: GoalieGameStats = {
        saves: goalieResult.saves,
        shotsAgainst: goalieResult.shotsAgainst,
        won: goalieResult.won,
        shutout: goalieResult.shutout
      };

      const breakdown =
        calculateGoalieGameBreakdown(
          stats,
          scoringRules
        );

      rows.push(
        this.createBaseGameRow(
          asset,
          game,
          goalieResult.won ? 'Win' : 'Loss',
          true,
          true,
          breakdown.total,
          [
            { label: 'Saves', value: goalieResult.saves.toString() },
            { label: 'Shots', value: goalieResult.shotsAgainst.toString() },
            { label: 'SV%', value: `${(savePercentage * 100).toFixed(1)}%` },
            { label: 'SO', value: goalieResult.shutout ? 'Yes' : 'No' }
          ],
          breakdown.lines
        )
      );
    }

    return rows;
  }

  private async loadFinalGameData(
    gameId: number
  ): Promise<{
    boxscore: NhlGameBoxscoreResponse;
    playByPlay: NhlGamePlayByPlayResponse;
  } | null> {
    try {
      const [boxscore, playByPlay] = await Promise.all([
        getGameBoxscore(gameId),
        getGamePlayByPlay(gameId)
      ]);

      return {
        boxscore,
        playByPlay
      };
    } catch (error: unknown) {
      console.warn(
        'Unable to load game detail.',
        error
      );

      return null;
    }
  }

  private createBaseGameRow(
    asset: DraftableAsset,
    game: NhlTeamSeasonGame,
    statusLabel: string,
    final: boolean,
    played: boolean,
    fantasyPoints: number | null,
    statChips: DetailStatChip[],
    breakdownLines: PointBreakdownLine[]
  ): CycleAssetGameDetail {
    return {
      gameId: game.id,
      gameDate: game.gameDate,
      opponentAbbreviation:
        this.getOpponentAbbreviation(asset, game),
      scoreLabel:
        this.getGameScoreLabel(game),
      statusLabel,
      final,
      played,
      fantasyPoints,
      statChips,
      breakdownLines
    };
  }

  private getOpponentAbbreviation(
    asset: DraftableAsset,
    game: NhlTeamSeasonGame
  ): string {
    const teamAbbreviation =
      this.getAssetTeamLabel(asset).toUpperCase();

    return game.homeTeam.abbrev.toUpperCase() === teamAbbreviation
      ? game.awayTeam.abbrev
      : game.homeTeam.abbrev;
  }

  private getGameScoreLabel(game: NhlTeamSeasonGame): string {
    const hasScore =
      typeof game.homeTeam.score === 'number' &&
      typeof game.awayTeam.score === 'number';

    if (!hasScore) {
      return `${game.awayTeam.abbrev} @ ${game.homeTeam.abbrev}`;
    }

    return `${game.awayTeam.abbrev} ${game.awayTeam.score} @ ${game.homeTeam.abbrev} ${game.homeTeam.score}`;
  }

  private isFinalGame(game: NhlTeamSeasonGame): boolean {
    const hasScores =
      typeof game.homeTeam.score === 'number' &&
      typeof game.awayTeam.score === 'number';

    return (
      game.gameState === 'OFF' ||
      game.gameState === 'FINAL' ||
      hasScores
    );
  }

  private getCycleWindowStartDate(): Date | null {
    const cycle = this.cycle();

    return this.getDateFromUnknown(cycle?.startedAt);
  }

  private getCycleWindowEndDate(): Date | null {
    const startDate = this.getCycleWindowStartDate();

    if (!startDate) {
      return null;
    }

    return this.getCycleWindowEndDateFromStart(startDate);
  }

  private getCycleWindowEndDateFromStart(
    startDate: Date
  ): Date {
    const endDate = new Date(startDate);

    endDate.setDate(
      endDate.getDate() + CYCLE_PROJECTION_WINDOW_DAYS
    );

    return endDate;
  }

  private getDateFromUnknown(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      'toDate' in value
    ) {
      const timestampLike = value as {
        toDate?: () => Date;
      };

      if (typeof timestampLike.toDate === 'function') {
        return timestampLike.toDate();
      }
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number'
    ) {
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

    const seasonStartYear =
      month >= 7
        ? year
        : year - 1;

    return `${seasonStartYear}${seasonStartYear + 1}`;
  }

  private isGameInCycleWindow(
    gameDate: string,
    startDate: Date,
    endDate: Date
  ): boolean {
    const startKey = this.getDateKey(startDate);
    const endKey = this.getDateKey(endDate);

    return gameDate >= startKey && gameDate <= endKey;
  }

  private getDateKey(date: Date): string {
    const year = date.getFullYear();
    const month =
      `${date.getMonth() + 1}`.padStart(2, '0');
    const day =
      `${date.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  private getMinutesFromToi(toi: string | undefined): number {
    if (!toi) {
      return 0;
    }

    const [minutesRaw, secondsRaw] = toi.split(':');
    const minutes = Number(minutesRaw);
    const seconds = Number(secondsRaw);

    if (
      Number.isNaN(minutes) ||
      Number.isNaN(seconds)
    ) {
      return 0;
    }

    return Number(
      (minutes + seconds / 60).toFixed(2)
    );
  }
}