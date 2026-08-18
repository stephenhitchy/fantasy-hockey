import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { onAuthStateChanged, type User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  type ProjectionCycleGameMarker,
  type ProjectionStatBreakdownItem,
} from '../../../core/draft/draft.models';
import {
  buildLeaguePlayerBoardRows,
  type LeaguePlayerBoardRow,
} from '../../../core/player/league-player-board.util';
import {
  loadLeaguePlayerBoardBaseData,
  loadLeagueWaiverAssetKeysOnce,
} from '../../../core/player/league-player-board.service';
import {
  getPlayerWatchlist,
  setPlayerWatchlistEntry,
} from '../../../core/player/player-watchlist.service';
import {
  getPlayerNote,
  normalizePlayerNoteText,
  PLAYER_NOTE_MAX_CHARACTERS,
  PLAYER_NOTE_MAX_LINES,
  setPlayerNote,
} from '../../../core/player/player-note.service';
import { type League } from '../../../core/league/league.service';
import { type SharedProjectionSnapshotMetadata } from '../../../core/projection/projection-snapshot.service';

type PlayerIntelSection = 'overview' | 'stats' | 'projection' | 'schedule';

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Component({
  selector: 'app-league-player-detail',
  imports: [FormsModule, RouterLink],
  templateUrl: './league-player-detail.html',
  styleUrl: './league-player-detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeaguePlayerDetail {
  private readonly route = inject(ActivatedRoute);

  readonly leagueId = this.route.snapshot.paramMap.get('leagueId') ?? '';
  readonly assetKey = this.route.snapshot.paramMap.get('assetKey') ?? '';
  readonly userId = signal('');
  readonly league = signal<League | null>(null);
  readonly snapshotMetadata = signal<SharedProjectionSnapshotMetadata | null>(null);
  readonly row = signal<LeaguePlayerBoardRow | null>(null);
  readonly loading = signal(true);
  readonly errorMessage = signal('');
  readonly watchSaving = signal(false);
  readonly watchError = signal('');
  readonly noteLoading = signal(true);
  readonly noteEditorOpen = signal(false);
  readonly savedNote = signal('');
  readonly noteDraft = signal('');
  readonly noteUpdatedAt = signal<Date | null>(null);
  readonly noteSaving = signal(false);
  readonly noteStatus = signal('');
  readonly noteError = signal('');
  readonly activeSection = signal<PlayerIntelSection>('overview');

  readonly noteCharactersRemaining = computed(() =>
    Math.max(0, PLAYER_NOTE_MAX_CHARACTERS - this.noteDraft().length),
  );
  readonly noteLineCount = computed(() => {
    const normalized = this.noteDraft().replace(/\r\n?/g, '\n');
    return normalized ? normalized.split('\n').length : 0;
  });
  readonly canSaveNote = computed(() => {
    const normalized = normalizePlayerNoteText(this.noteDraft());
    return !this.noteSaving() &&
      normalized !== null &&
      normalized !== this.savedNote() &&
      this.noteLineCount() <= PLAYER_NOTE_MAX_LINES;
  });

  readonly asset = computed(() => this.row()?.asset ?? null);
  readonly statBreakdown = computed<readonly ProjectionStatBreakdownItem[]>(() =>
    this.asset()?.seasonStatBreakdown ?? [],
  );

  readonly recentPace = computed(() => {
    const asset = this.asset();
    if (!asset) {
      return [];
    }

    return [
      { label: 'Last 3', value: finiteNumber(asset.recentThreeGameFantasyPointsPerGame) },
      { label: 'Last 5', value: finiteNumber(asset.recentFiveGameFantasyPointsPerGame) },
      { label: 'Last 10', value: finiteNumber(asset.recentTenGameFantasyPointsPerGame) },
      { label: 'Last 20', value: finiteNumber(asset.recentTwentyGameFantasyPointsPerGame) },
    ];
  });

  readonly scheduleOpponents = computed(() =>
    (this.asset()?.projectionOpponentAbbreviations ?? [])
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .slice(0, 6),
  );

  readonly currentTeamCycleGames = computed<readonly ProjectionCycleGameMarker[]>(() =>
    (this.asset()?.currentTeamCycleGames ?? []).slice(0, 6),
  );

  readonly birthDate = computed(() => {
    const asset = this.asset();
    return asset?.assetType === 'skater' && asset.player.birthDate
      ? asset.player.birthDate
      : null;
  });

  readonly age = computed(() => {
    const value = this.birthDate();
    if (!value) {
      return null;
    }

    const birthDate = new Date(`${value}T00:00:00`);
    if (Number.isNaN(birthDate.getTime())) {
      return null;
    }

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDifference = today.getMonth() - birthDate.getMonth();
    if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
      age -= 1;
    }

    return age >= 0 ? age : null;
  });

  readonly canOpenFreeAgents = computed(() => {
    const status = this.row()?.status;
    return status === 'free-agent' || status === 'waivers';
  });

  constructor() {
    void this.initialize();
  }

  setSection(section: PlayerIntelSection): void {
    this.activeSection.set(section);
  }

  async toggleWatchlist(): Promise<void> {
    const row = this.row();
    if (!row || this.watchSaving()) {
      return;
    }

    this.watchSaving.set(true);
    this.watchError.set('');

    try {
      const result = await setPlayerWatchlistEntry({
        assetKey: row.assetKey,
        watched: !row.watched,
      });
      const watched = result.assetKeys.includes(row.assetKey);
      this.row.set({ ...row, watched });
    } catch (error) {
      this.watchError.set(
        error instanceof Error ? error.message : 'Unable to update your watchlist.',
      );
    } finally {
      this.watchSaving.set(false);
    }
  }

  openNoteEditor(): void {
    this.noteDraft.set(this.savedNote());
    this.noteEditorOpen.set(true);
    this.noteStatus.set('');
    this.noteError.set('');
  }

  cancelNoteEditor(): void {
    this.noteDraft.set(this.savedNote());
    this.noteEditorOpen.set(false);
    this.noteError.set('');
  }

  updateNoteDraft(value: string): void {
    this.noteDraft.set(value.slice(0, PLAYER_NOTE_MAX_CHARACTERS));
    this.noteStatus.set('');
  }

  async saveNote(): Promise<void> {
    const normalized = normalizePlayerNoteText(this.noteDraft());

    if (normalized === null || this.noteSaving()) {
      this.noteError.set(
        `Use at most ${PLAYER_NOTE_MAX_CHARACTERS} characters and ${PLAYER_NOTE_MAX_LINES} lines.`,
      );
      return;
    }

    this.noteSaving.set(true);
    this.noteError.set('');
    this.noteStatus.set('');

    try {
      const result = await setPlayerNote({
        assetKey: this.assetKey,
        note: normalized,
      });
      this.savedNote.set(result.note);
      this.noteDraft.set(result.note);
      this.noteUpdatedAt.set(result.updatedAt);
      this.noteEditorOpen.set(false);
      this.noteStatus.set(result.note ? 'Private note saved.' : 'Private note removed.');
    } catch (error) {
      this.noteError.set(
        error instanceof Error ? error.message : 'Unable to save your player note.',
      );
    } finally {
      this.noteSaving.set(false);
    }
  }

  async removeNote(): Promise<void> {
    this.noteDraft.set('');
    await this.saveNote();
  }

  formatNoteUpdatedAt(): string {
    const updatedAt = this.noteUpdatedAt();
    return updatedAt
      ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(updatedAt)
      : '';
  }

  getStatusLabel(row: LeaguePlayerBoardRow): string {
    switch (row.status) {
      case 'rostered':
        return row.ownership?.teamName ?? 'Rostered';
      case 'waivers':
        return 'On waivers';
      case 'reserved':
        return 'Unavailable';
      default:
        return 'Free agent';
    }
  }

  getStatusDetail(row: LeaguePlayerBoardRow): string {
    if (!row.ownership) {
      return row.availabilityLabel ?? '';
    }

    const area = row.ownership.area === 'active'
      ? 'Active roster'
      : row.ownership.area === 'bench'
        ? 'Bench'
        : 'IR';
    return `${area} · ${row.ownership.slotLabel}`;
  }

  getPrimaryImage(row: LeaguePlayerBoardRow): string | null {
    return row.headshotUrl || row.logoUrl;
  }

  getPrimaryImageAlt(row: LeaguePlayerBoardRow): string {
    return row.asset.assetType === 'skater'
      ? `${row.name} headshot`
      : `${row.nhlTeamAbbreviation} logo`;
  }

  formatPoints(value: number | null | undefined, digits = 1): string {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(digits).replace(/\.0+$/, '')
      : '—';
  }

  formatRank(rank: number | null, total: number): string {
    return rank === null || total <= 0 ? '—' : `#${rank} of ${total}`;
  }

  formatPercent(value: number | null | undefined, digits = 0): string {
    return typeof value === 'number' && Number.isFinite(value)
      ? `${value.toFixed(digits)}%`
      : '—';
  }

  formatDate(value: string | null | undefined): string {
    if (!value) {
      return '—';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(date);
  }

  formatShortDate(value: string | null | undefined): string {
    if (!value) {
      return 'TBD';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(date);
  }

  getAgeLabel(): string {
    const age = this.age();
    const birthDate = this.birthDate();

    if (age === null && !birthDate) {
      return '—';
    }

    return age === null
      ? this.formatDate(birthDate)
      : `${age} · born ${this.formatDate(birthDate)}`;
  }

  getPerformanceLabel(): string {
    const asset = this.asset();
    const percent = finiteNumber(asset?.performanceVsProjectionPercent);
    const points = finiteNumber(asset?.performanceVsProjectionPoints);

    if (percent === null || points === null) {
      return '—';
    }

    if (Math.abs(percent) < 5) {
      return `On pace · ${points >= 0 ? '+' : ''}${points.toFixed(1)} FP`;
    }

    return `${Math.abs(percent).toFixed(0)}% ${percent > 0 ? 'ahead' : 'behind'} · ${points >= 0 ? '+' : ''}${points.toFixed(1)} FP`;
  }

  getProjectionRange(): string {
    const row = this.row();
    if (!row || row.projectionFloor === null || row.projectionCeiling === null) {
      return '—';
    }

    return `${row.projectionFloor.toFixed(1)}–${row.projectionCeiling.toFixed(1)}`;
  }

  getAvailabilityLabel(): string {
    const asset = this.asset();
    if (!asset) {
      return '—';
    }

    const expected = finiteNumber(asset.expectedGamesAvailable);
    const scheduled = finiteNumber(asset.scheduledGamesInProjectionCycle);
    const status = asset.availabilityLabel?.trim();

    if (expected !== null && scheduled !== null) {
      return `${expected.toFixed(1)} of ${scheduled} expected${status ? ` · ${status}` : ''}`;
    }

    return status || 'No availability adjustment';
  }

  getReliabilityLabel(): string {
    const reliability = this.row()?.reliabilityRating;
    if (reliability === null || reliability === undefined) {
      return '—';
    }

    const confidence = reliability >= 82
      ? 'High'
      : reliability >= 65
        ? 'Moderate'
        : 'Volatile';
    return `${reliability.toFixed(0)}/100 · ${confidence}`;
  }

  getModelConfidenceLabel(): string {
    const confidence = this.row()?.projectionConfidence;
    return confidence === null || confidence === undefined
      ? '—'
      : `${confidence.toFixed(0)}%`;
  }

  getToiLabel(): string {
    const asset = this.asset();
    if (!asset || asset.assetType !== 'skater') {
      return '—';
    }

    const season = finiteNumber(asset.seasonAverageTimeOnIceMinutes);
    const recent = finiteNumber(asset.recentAverageTimeOnIceMinutes);

    if (season === null && recent === null) {
      return '—';
    }

    return `${recent === null ? '—' : recent.toFixed(1)} recent · ${season === null ? '—' : season.toFixed(1)} season`;
  }

  getBreakdownStatLabel(item: ProjectionStatBreakdownItem): string {
    const statValue = Number.isInteger(item.statValue)
      ? item.statValue.toFixed(0)
      : item.statValue.toFixed(1);
    return `${statValue} ${item.statUnit}`.trim();
  }

  getBreakdownPointsLabel(item: ProjectionStatBreakdownItem): string {
    return `${item.fantasyPoints >= 0 ? '+' : ''}${item.fantasyPoints.toFixed(1)} FP`;
  }

  getSnapshotLabel(): string {
    const metadata = this.snapshotMetadata();
    if (!metadata) {
      return 'Projection V11';
    }

    const date = metadata.projectionAsOfDate || metadata.generatedAt;
    return date
      ? `Projection V${metadata.projectionVersion} · ${this.formatDate(date)}`
      : `Projection V${metadata.projectionVersion}`;
  }

  getScheduleSummary(): string {
    const asset = this.asset();
    if (!asset) {
      return 'Schedule pending';
    }

    const home = finiteNumber(asset.projectionHomeGames);
    const road = finiteNumber(asset.projectionRoadGames);
    if (home === null && road === null) {
      return asset.scheduleDifficultyLabel || 'Schedule pending';
    }

    return `${home ?? 0} home · ${road ?? 0} away`;
  }

  getGameMarkerLabel(game: ProjectionCycleGameMarker): string {
    const venue = game.venue === 'home' ? 'vs' : '@';
    return `${venue} ${game.opponentAbbreviation}`;
  }

  private async initialize(): Promise<void> {
    if (!this.leagueId || !this.assetKey) {
      this.loading.set(false);
      this.errorMessage.set('Player not found.');
      return;
    }

    const user = await waitForAuthUser();
    if (!user) {
      this.loading.set(false);
      this.errorMessage.set('Sign in to view Player Intel.');
      return;
    }

    this.userId.set(user.uid);

    try {
      const [baseData, watchlist, waiverAssetKeys, playerNote] = await Promise.all([
        loadLeaguePlayerBoardBaseData(this.leagueId, { forceRefresh: true }),
        getPlayerWatchlist().catch(() => ({
          assetKeys: [] as string[],
          maximumCount: 100,
          changed: false,
        })),
        loadLeagueWaiverAssetKeysOnce(this.leagueId),
        getPlayerNote(this.assetKey).catch(() => null),
      ]);

      const rows = buildLeaguePlayerBoardRows({
        assets: baseData.assets,
        ownershipByAssetKey: baseData.ownershipByAssetKey,
        reservedAssetKeys: baseData.reservedAssetKeys,
        waiverAssetKeys,
        watchedAssetKeys: new Set(watchlist.assetKeys),
      });
      const selectedRow = rows.find((row) => row.assetKey === this.assetKey) ?? null;

      this.league.set(baseData.league);
      this.snapshotMetadata.set(baseData.snapshotMetadata);
      this.row.set(selectedRow);
      this.savedNote.set(playerNote?.note ?? '');
      this.noteDraft.set(playerNote?.note ?? '');
      this.noteUpdatedAt.set(playerNote?.updatedAt ?? null);
      this.noteLoading.set(false);

      if (!selectedRow) {
        this.errorMessage.set('This player is not in the current league projection snapshot.');
      }
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Unable to load Player Intel.',
      );
    } finally {
      this.loading.set(false);
      this.noteLoading.set(false);
    }
  }
}
