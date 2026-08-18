import type { FantasyAssetCycleWindow, FantasyTeamCycleWindows } from '../cycle/cycle.models';
import type { ProjectionCycleGameMarker } from '../draft/draft.models';
import type { LeaguePlayerOwnership } from './league-player-board.util';

export type LeaguePlayerProgressMarkerStatus =
  | 'played'
  | 'missed'
  | 'upcoming'
  | 'unavailable';

export interface LeaguePlayerProgressMarker {
  index: number;
  gameId: number | null;
  gameDate: string | null;
  displayLabel: string;
  status: LeaguePlayerProgressMarkerStatus;
  statusLabel: string;
  title: string;
}

function validGameId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function normalizeRequiredGames(requiredGames: number): number {
  return Math.max(1, Math.floor(requiredGames));
}

/**
 * Resolves the exact fantasy roster-slot window currently represented by each
 * active rostered asset. Projection schedule blocks are intentionally not used
 * for these rows because NHL-team blocks and fantasy slot windows can begin on
 * different dates.
 */
export function buildCurrentRosterWindowByAssetKey(
  ownershipByAssetKey: ReadonlyMap<string, LeaguePlayerOwnership>,
  teamWindowsByCycle: Readonly<Record<number, readonly FantasyTeamCycleWindows[]>>,
): Map<string, FantasyAssetCycleWindow> {
  const windowsByOwnerAndSlot = new Map<string, FantasyAssetCycleWindow[]>();

  for (const teamWindows of Object.values(teamWindowsByCycle)) {
    for (const ownerWindows of teamWindows) {
      for (const window of ownerWindows.windows) {
        const key = `${ownerWindows.ownerId}::${window.rosterSlotId}`;
        const candidates = windowsByOwnerAndSlot.get(key) ?? [];
        candidates.push(window);
        windowsByOwnerAndSlot.set(key, candidates);
      }
    }
  }

  const result = new Map<string, FantasyAssetCycleWindow>();

  for (const [assetKey, ownership] of ownershipByAssetKey.entries()) {
    if (ownership.area !== 'active' || !ownership.rosterSlotId) {
      continue;
    }

    const candidates = windowsByOwnerAndSlot
      .get(`${ownership.ownerId}::${ownership.rosterSlotId}`)
      ?.filter((window) => window.assetKey === assetKey)
      .sort((first, second) => {
        const statusPriority = (status: FantasyAssetCycleWindow['status']): number =>
          status === 'active' ? 3 : status === 'scheduled' ? 2 : 1;
        const statusDifference = statusPriority(second.status) - statusPriority(first.status);

        return statusDifference !== 0
          ? statusDifference
          : second.cycleNumber - first.cycleNumber;
      });

    const current = candidates?.[0];
    if (current) {
      result.set(assetKey, current);
    }
  }

  return result;
}

/** Mirrors Game Center's authoritative six-game marker rules. */
export function buildRosterWindowProgressMarkers(
  window: FantasyAssetCycleWindow | null | undefined,
  requiredGames: number,
): LeaguePlayerProgressMarker[] {
  const count = normalizeRequiredGames(requiredGames);

  return Array.from({ length: count }, (_, index) => {
    const gameId = validGameId(window?.scheduledGameIds[index]);
    const gameDate = window?.scheduledGameDates[index] ?? null;
    const gameLabel = window?.scheduledGameLabels[index] ?? 'Schedule pending';
    const completed = Boolean(gameId && window?.completedGameIds.includes(gameId));
    const hasAppearanceData = Boolean(window?.appearanceGameIds.length);
    const inferredAllAppearances = Boolean(
      window &&
      window.actualGamesPlayed === window.completedGameIds.length &&
      window.completedGameIds.length > 0,
    );
    const appeared = Boolean(
      gameId &&
      (window?.appearanceGameIds.includes(gameId) ||
        (!hasAppearanceData && inferredAllAppearances)),
    );

    let status: LeaguePlayerProgressMarkerStatus = 'unavailable';
    let statusLabel = 'Not scheduled';

    if (gameId && completed && appeared) {
      status = 'played';
      statusLabel = 'Played';
    } else if (gameId && completed) {
      status = 'missed';
      statusLabel = 'Counted team game · no appearance';
    } else if (gameId) {
      status = 'upcoming';
      statusLabel = window?.liveGameIds.includes(gameId) ? 'Live' : 'Upcoming';
    }

    const parsedDate = gameDate ? new Date(`${gameDate}T12:00:00Z`) : null;
    const dateLabel = parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleDateString(undefined, { timeZone: 'UTC' })
      : 'Date pending';

    return {
      index: index + 1,
      gameId,
      gameDate,
      displayLabel: gameLabel,
      status,
      statusLabel,
      title: `Game ${index + 1}: ${gameLabel} · ${dateLabel} · ${statusLabel}${gameId ? ` · NHL game ${gameId}` : ''}`,
    };
  });
}

export function buildProjectionProgressMarkers(
  markers: readonly ProjectionCycleGameMarker[] | null | undefined,
  requiredGames: number,
): LeaguePlayerProgressMarker[] {
  const count = normalizeRequiredGames(requiredGames);

  return Array.from({ length: count }, (_, index) => {
    const marker = markers?.[index];
    if (!marker) {
      return {
        index: index + 1,
        gameId: null,
        gameDate: null,
        displayLabel: 'Schedule pending',
        status: 'unavailable',
        statusLabel: 'Not scheduled',
        title: `Game ${index + 1}: projection schedule unavailable.`,
      };
    }

    const venue = marker.venue === 'home' ? 'vs' : '@';
    const statusLabel = marker.status === 'played'
      ? 'played and counted'
      : marker.status === 'missed'
        ? 'team played; player missed'
        : 'upcoming';

    return {
      index: index + 1,
      gameId: marker.gameId,
      gameDate: marker.gameDate,
      displayLabel: `${venue} ${marker.opponentAbbreviation}`,
      status: marker.status,
      statusLabel,
      title: `Game ${index + 1}: ${marker.gameDate} ${venue} ${marker.opponentAbbreviation} — ${statusLabel}.`,
    };
  });
}
