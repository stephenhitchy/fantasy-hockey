import {
  Component,
  computed,
  signal
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  DraftableAsset,
  DraftPosition
} from '../../../core/draft/draft.models';

import {
  loadDraftPlayerPool
} from '../../../core/draft/draft-player-pool.service';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

type ProjectionPositionFilter = 'ALL' | DraftPosition;

type ProjectionSortMode =
  | 'DRAFT_VALUE'
  | 'VALUE_RATING'
  | 'RATING'
  | 'PROJECTED_CYCLE'
  | 'PROJECTED_SEASON'
  | 'POSITION_RANK'
  | 'NAME'
  | 'TEAM';

interface ProjectionRow {
  asset: DraftableAsset;
  name: string;
  position: DraftPosition;
  teamAbbreviation: string;
  logoUrl?: string;
  projectedSeason: number;
  projectedPpg: number;
  projectedCycle: number;
  replacementProjection: number;
  draftValue: number;
  rating: number;
  replacementRating: number;
  valueRating: number;
  positionRank: number;
  overallValueRank: number;
  tier: string;
}

interface PositionSummary {
  position: DraftPosition;
  label: string;
  starterSlots: number;
  replacementProjection: number;
  replacementRating: number;
  starterAverage: number;
  starterAverageRating: number;
  topAverage: number;
  topPlayerName: string;
  topPlayerProjection: number;
  topPlayerRating: number;
  availableAssets: number;
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
  selector: 'app-projection-lab',
  imports: [FormsModule, RouterLink],
  templateUrl: './projection-lab.html',
  styleUrl: './projection-lab.css'
})
export class ProjectionLab {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  playerPool = signal<DraftableAsset[]>([]);

  loading = signal(true);
  playerPoolLoading = signal(false);
  errorMessage = signal('');
  playerPoolError = signal('');

  searchTerm = signal('');
  positionFilter = signal<ProjectionPositionFilter>('ALL');
  sortMode = signal<ProjectionSortMode>('DRAFT_VALUE');

  teamCountOverride = signal<number | null>(null);
  projectedGamesPerCycle = signal(6);

  readonly rosterPositions: DraftPosition[] = [
    'LW',
    'C',
    'RW',
    'D',
    'G'
  ];

  readonly positionRequirements: Record<DraftPosition, number> = {
    LW: 3,
    C: 3,
    RW: 3,
    D: 4,
    G: 1
  };

  readonly teamCountForReplacement = computed(() =>
    this.teamCountOverride() ??
    Math.max(this.teams().length, 2)
  );

  readonly totalStarterSlots = computed(() =>
    this.rosterPositions.reduce(
      (total, position) =>
        total + this.getStarterCount(position),
      0
    )
  );

  readonly projectionRows = computed(() =>
    this.buildProjectionRows()
  );

  readonly visibleRows = computed(() => {
    const search = this.searchTerm().trim().toLowerCase();
    const positionFilter = this.positionFilter();
    const sortMode = this.sortMode();

    const rows = this.projectionRows()
      .filter((row) =>
        positionFilter === 'ALL'
          ? true
          : row.position === positionFilter
      )
      .filter((row) => {
        if (!search) {
          return true;
        }

        return (
          row.name.toLowerCase().includes(search) ||
          row.teamAbbreviation.toLowerCase().includes(search)
        );
      });

    return [...rows].sort((first, second) => {
      switch (sortMode) {
        case 'VALUE_RATING':
          return second.valueRating - first.valueRating;

        case 'RATING':
          return second.rating - first.rating;

        case 'PROJECTED_CYCLE':
          return second.projectedCycle - first.projectedCycle;

        case 'PROJECTED_SEASON':
          return second.projectedSeason - first.projectedSeason;

        case 'POSITION_RANK':
          if (first.position === second.position) {
            return first.positionRank - second.positionRank;
          }

          return (
            this.getPositionSortValue(first.position) -
            this.getPositionSortValue(second.position)
          );

        case 'NAME':
          return first.name.localeCompare(second.name);

        case 'TEAM':
          return (
            first.teamAbbreviation.localeCompare(second.teamAbbreviation) ||
            first.name.localeCompare(second.name)
          );

        case 'DRAFT_VALUE':
        default:
          return second.draftValue - first.draftValue;
      }
    });
  });

  readonly positionSummaries = computed<PositionSummary[]>(() => {
    const rows = this.projectionRows();

    return this.rosterPositions.map((position) => {
      const positionRows = rows
        .filter((row) => row.position === position)
        .sort(
          (first, second) =>
            second.projectedCycle - first.projectedCycle
        );

      const starterSlots = this.getStarterCount(position);
      const starters = positionRows.slice(0, starterSlots);
      const topGroup = positionRows.slice(
        0,
        Math.min(5, positionRows.length)
      );

      return {
        position,
        label: this.getPositionLabel(position),
        starterSlots,
        replacementProjection:
          positionRows[0]?.replacementProjection ?? 0,
        replacementRating:
          positionRows[0]?.replacementRating ?? 0,
        starterAverage: this.average(
          starters.map((row) => row.projectedCycle)
        ),
        starterAverageRating: this.average(
          starters.map((row) => row.rating)
        ),
        topAverage: this.average(
          topGroup.map((row) => row.projectedCycle)
        ),
        topPlayerName: positionRows[0]?.name ?? '—',
        topPlayerProjection:
          positionRows[0]?.projectedCycle ?? 0,
        topPlayerRating:
          positionRows[0]?.rating ?? 0,
        availableAssets: positionRows.length
      };
    });
  });

  readonly balanceNotes = computed(() => {
    const summaries = this.positionSummaries();

    const forwardAverage = this.average(
      summaries
        .filter((summary) =>
          ['LW', 'C', 'RW'].includes(summary.position)
        )
        .map((summary) => summary.starterAverage)
    );

    const defenseAverage =
      summaries.find((summary) => summary.position === 'D')
        ?.starterAverage ?? 0;

    const goalieAverage =
      summaries.find((summary) => summary.position === 'G')
        ?.starterAverage ?? 0;

    const notes: string[] = [];

    if (goalieAverage > forwardAverage * 1.3) {
      notes.push(
        'Goalie units have high raw points, but check Draft Value before nerfing them. If goalie Draft Value is low, they are probably balanced because replacement goalie units are also strong.'
      );
    }

    if (goalieAverage < forwardAverage * 0.75) {
      notes.push(
        'Goalie units are projecting noticeably below forwards. If goalies feel too weak, goalie saves or win bonuses may need more value.'
      );
    }

    if (defenseAverage < forwardAverage * 0.68) {
      notes.push(
        'Defensemen are projecting much lower than forwards. Blocks, hits, or defense TOI may need a small bump.'
      );
    }

    if (defenseAverage > forwardAverage * 1.05) {
      notes.push(
        'Defensemen are projecting close to or above forwards. That may be fine, but check whether defense is becoming too safe compared with forwards.'
      );
    }

    if (notes.length === 0) {
      notes.push(
        'The positional balance looks reasonable from this projection view. Use Rating for general strength and Draft Value for draft priority.'
      );
    }

    return notes;
  });

  readonly topOverallValue = computed(() =>
    this.projectionRows()[0] ?? null
  );

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadProjectionLab();
  }

  async loadProjectionLab(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

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

      this.projectedGamesPerCycle.set(
        league.scoringRules?.requiredGamesPerCycle ?? 6
      );

      await this.loadPlayerPool();
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load Projection Lab.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  async loadPlayerPool(): Promise<void> {
    this.playerPoolLoading.set(true);
    this.playerPoolError.set('');

    try {
      this.playerPool.set(
        await loadDraftPlayerPool(true)
      );
    } catch (error: unknown) {
      this.playerPoolError.set(
        error instanceof Error
          ? error.message
          : 'Unable to load projections.'
      );
    } finally {
      this.playerPoolLoading.set(false);
    }
  }

  setSearchTerm(value: string): void {
    this.searchTerm.set(value);
  }

  setPositionFilter(value: string): void {
    const validFilters: ProjectionPositionFilter[] = [
      'ALL',
      'LW',
      'C',
      'RW',
      'D',
      'G'
    ];

    if (validFilters.includes(value as ProjectionPositionFilter)) {
      this.positionFilter.set(value as ProjectionPositionFilter);
    }
  }

  setSortMode(value: string): void {
    const validSorts: ProjectionSortMode[] = [
      'DRAFT_VALUE',
      'VALUE_RATING',
      'RATING',
      'PROJECTED_CYCLE',
      'PROJECTED_SEASON',
      'POSITION_RANK',
      'NAME',
      'TEAM'
    ];

    if (validSorts.includes(value as ProjectionSortMode)) {
      this.sortMode.set(value as ProjectionSortMode);
    }
  }

  setTeamCountOverride(value: string | number): void {
    const numericValue = Number(value);

    if (
      Number.isNaN(numericValue) ||
      numericValue < 2
    ) {
      this.teamCountOverride.set(null);
      return;
    }

    this.teamCountOverride.set(
      Math.min(32, Math.round(numericValue))
    );
  }

  setProjectedGamesPerCycle(value: string | number): void {
    const numericValue = Number(value);

    if (
      Number.isNaN(numericValue) ||
      numericValue <= 0
    ) {
      return;
    }

    this.projectedGamesPerCycle.set(
      Math.min(10, Math.max(1, numericValue))
    );
  }

  clearOverrides(): void {
    this.teamCountOverride.set(null);
    this.projectedGamesPerCycle.set(
      this.league()?.scoringRules?.requiredGamesPerCycle ?? 6
    );
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

  getPositionLabel(position: DraftPosition): string {
    switch (position) {
      case 'LW':
        return 'Left Wing';

      case 'C':
        return 'Center';

      case 'RW':
        return 'Right Wing';

      case 'D':
        return 'Defense';

      case 'G':
        return 'Goalie Unit';

      default:
        return position;
    }
  }

  getRatingBasisLabel(row: ProjectionRow): string {
    return row.position === 'G'
      ? 'Goalie scale'
      : 'Skater scale';
  }

  getDisplayNumber(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return value.toFixed(1);
  }

  getRatingDisplay(value: number | null | undefined): string {
    if (typeof value !== 'number') {
      return '—';
    }

    return Math.round(value).toString();
  }

  getSignedDisplayNumber(value: number): string {
    const rounded = value.toFixed(1);

    return value > 0
      ? `+${rounded}`
      : rounded;
  }

  getSignedRatingDisplay(value: number): string {
    const rounded = value.toFixed(1);

    return value > 0
      ? `+${rounded}`
      : rounded;
  }

  getStarterCount(position: DraftPosition): number {
    return (
      this.teamCountForReplacement() *
      this.positionRequirements[position]
    );
  }

  getRowClass(row: ProjectionRow): string {
  if (row.valueRating >= 30) {
    return 'league-winner-value';
  }

  if (row.valueRating >= 22) {
    return 'elite-value';
  }

  if (row.valueRating >= 15) {
    return 'strong-value';
  }

  if (row.valueRating < -8) {
    return 'low-value';
  }

  return '';
}

  private buildProjectionRows(): ProjectionRow[] {
    const baseRows = this.playerPool().map((asset) => {
      const projectedSeason = this.getProjectedSeason(asset);
      const projectedPpg =
        projectedSeason > 0
          ? projectedSeason / 82
          : 0;

      const projectedCycle =
        projectedPpg * this.projectedGamesPerCycle();

      return {
        asset,
        name: this.getAssetName(asset),
        position: asset.position,
        teamAbbreviation: this.getAssetTeamLabel(asset),
        logoUrl: this.getAssetLogoUrl(asset),
        projectedSeason,
        projectedPpg,
        projectedCycle
      };
    });

    const topForwardCycle = Math.max(
      1,
      ...baseRows
        .filter((row) =>
          row.position === 'LW' ||
          row.position === 'C' ||
          row.position === 'RW'
        )
        .map((row) => row.projectedCycle)
    );

    const topGoalieCycle = Math.max(
      1,
      ...baseRows
        .filter((row) => row.position === 'G')
        .map((row) => row.projectedCycle)
    );

    const rows: ProjectionRow[] = [];

    for (const position of this.rosterPositions) {
      const positionRows = baseRows
        .filter((row) => row.position === position)
        .sort(
          (first, second) =>
            second.projectedCycle - first.projectedCycle
        );

      const replacementIndex = Math.max(
        0,
        Math.min(
          positionRows.length - 1,
          this.getStarterCount(position) - 1
        )
      );

      const replacementProjection =
        positionRows[replacementIndex]?.projectedCycle ?? 0;

      const ratingDenominator =
        position === 'G'
          ? topGoalieCycle
          : topForwardCycle;

      const replacementRating =
        replacementProjection / ratingDenominator * 100;

      positionRows.forEach((row, index) => {
        const draftValue =
          row.projectedCycle - replacementProjection;

        const rating =
          row.projectedCycle / ratingDenominator * 100;

        const valueRating =
          rating - replacementRating;

        rows.push({
          ...row,
          replacementProjection,
          draftValue,
          rating,
          replacementRating,
          valueRating,
          positionRank: index + 1,
          overallValueRank: 0,
          tier: this.getTierLabel(valueRating)
        });
      });
    }

    const rankedByValue = [...rows].sort(
      (first, second) =>
        second.draftValue - first.draftValue
    );

    const rankByAssetKey = new Map<string, number>();

    rankedByValue.forEach((row, index) => {
      rankByAssetKey.set(row.asset.assetKey, index + 1);
    });

    return rows
      .map((row) => ({
        ...row,
        projectedSeason: this.round(row.projectedSeason),
        projectedPpg: this.round(row.projectedPpg),
        projectedCycle: this.round(row.projectedCycle),
        replacementProjection: this.round(row.replacementProjection),
        draftValue: this.round(row.draftValue),
        rating: this.round(row.rating),
        replacementRating: this.round(row.replacementRating),
        valueRating: this.round(row.valueRating),
        overallValueRank:
          rankByAssetKey.get(row.asset.assetKey) ?? 9999
      }))
      .sort(
        (first, second) =>
          first.overallValueRank - second.overallValueRank
      );
  }

  private getProjectedSeason(asset: DraftableAsset): number {
    if (typeof asset.projectedSeasonPoints === 'number') {
      return asset.projectedSeasonPoints;
    }

    if (typeof asset.projectedCyclePoints === 'number') {
      const requiredGames =
        this.league()?.scoringRules?.requiredGamesPerCycle ?? 6;

      return (
        asset.projectedCyclePoints /
        requiredGames *
        82
      );
    }

    return 0;
  }

 private getTierLabel(valueRating: number): string {
  if (valueRating >= 30) {
    return 'League-Winner Value';
  }

  if (valueRating >= 22) {
    return 'Elite Value';
  }

  if (valueRating >= 15) {
    return 'Strong Value';
  }

  if (valueRating >= 8) {
    return 'Starter Value';
  }

  if (valueRating >= 0) {
    return 'Normal Starter';
  }

  if (valueRating >= -8) {
    return 'Fringe Starter';
  }

  return 'Depth';
}

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return this.round(
      values.reduce((total, value) => total + value, 0) /
      values.length
    );
  }

  private round(value: number): number {
    return Number(value.toFixed(2));
  }

  private getPositionSortValue(position: DraftPosition): number {
    return this.rosterPositions.indexOf(position);
  }
}