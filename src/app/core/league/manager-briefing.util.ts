import type { LeagueSummary } from './league.service';

export type ManagerBriefingTone = 'danger' | 'warning' | 'info' | 'success';

export type ManagerBriefingKind =
  | 'injury'
  | 'waiver-awarded'
  | 'waiver-missed'
  | 'waiver-cleared'
  | 'draft-live'
  | 'close-matchup'
  | 'boundary'
  | 'scheduled-move';

export interface ManagerBriefingItem {
  id: string;
  leagueId: string;
  leagueName: string;
  kind: ManagerBriefingKind;
  tone: ManagerBriefingTone;
  priority: number;
  headline: string;
  detail: string | null;
  actionLabel: string;
  actionRoute: Array<string | number>;
}

export interface BuildManagerBriefingOptions {
  nowMilliseconds?: number;
  maximumItems?: number;
}

const RECENT_WAIVER_OUTCOME_MILLISECONDS = 72 * 60 * 60 * 1000;
const CLOSE_MATCHUP_MAXIMUM_MARGIN = 5;
const CLOSE_MATCHUP_MINIMUM_PROGRESS_PERCENT = 60;
const DEFAULT_MAXIMUM_ITEMS = 3;
const HARD_MAXIMUM_ITEMS = 5;

function toDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  if (value && typeof value === 'object' && 'toDate' in value) {
    const candidate = value as { toDate?: unknown };

    if (typeof candidate.toDate === 'function') {
      const parsed = candidate.toDate();
      return parsed instanceof Date && Number.isFinite(parsed.getTime()) ? parsed : null;
    }
  }

  return null;
}

function formatScoreDifference(value: number): string {
  const rounded = Number(value.toFixed(1));
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function recentWaiverItem(
  league: LeagueSummary,
  nowMilliseconds: number,
): ManagerBriefingItem | null {
  const outcome = league.dashboardActivity?.recentWaiverOutcome;
  const occurredAt = toDate(outcome?.occurredAt);

  if (
    !outcome ||
    !occurredAt ||
    nowMilliseconds - occurredAt.getTime() < 0 ||
    nowMilliseconds - occurredAt.getTime() > RECENT_WAIVER_OUTCOME_MILLISECONDS
  ) {
    return null;
  }

  const effectiveDetail = outcome.effectiveLabel
    ? `Effective ${outcome.effectiveLabel}.`
    : null;

  if (outcome.status === 'awarded') {
    return {
      id: `${league.leagueId}:waiver:${outcome.waiverId}:awarded`,
      leagueId: league.leagueId,
      leagueName: league.leagueName,
      kind: 'waiver-awarded',
      tone: 'success',
      priority: 108,
      headline: `Waiver won: ${outcome.assetName}`,
      detail: effectiveDetail,
      actionLabel: 'View result',
      actionRoute: ['/leagues', league.leagueId, 'decision-history'],
    };
  }

  if (outcome.status === 'not-awarded') {
    return {
      id: `${league.leagueId}:waiver:${outcome.waiverId}:not-awarded`,
      leagueId: league.leagueId,
      leagueName: league.leagueName,
      kind: 'waiver-missed',
      tone: 'info',
      priority: 74,
      headline: `Waiver missed: ${outcome.assetName}`,
      detail: 'Check the player pool for your next move.',
      actionLabel: 'Open Add / Drop',
      actionRoute: ['/leagues', league.leagueId, 'players'],
    };
  }

  return {
    id: `${league.leagueId}:waiver:${outcome.waiverId}:cleared`,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    kind: 'waiver-cleared',
    tone: 'info',
    priority: 70,
    headline: `Waiver cleared: ${outcome.assetName}`,
    detail: 'No claim was awarded.',
    actionLabel: 'Open Add / Drop',
    actionRoute: ['/leagues', league.leagueId, 'players'],
  };
}

function injuryItem(league: LeagueSummary): ManagerBriefingItem | null {
  const count = league.dashboardActivity?.injuredStarterCount ?? 0;

  if (count <= 0) {
    return null;
  }

  return {
    id: `${league.leagueId}:injury`,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    kind: 'injury',
    tone: 'danger',
    priority: 105 + Math.min(5, count),
    headline: `${count} starter${count === 1 ? '' : 's'} unavailable`,
    detail: 'Review your active lineup.',
    actionLabel: 'Review lineup',
    actionRoute: ['/leagues', league.leagueId, 'team'],
  };
}

function draftItem(league: LeagueSummary): ManagerBriefingItem | null {
  const activity = league.dashboardActivity;

  if (activity?.stage !== 'draft-live') {
    return null;
  }

  return {
    id: `${league.leagueId}:draft-live`,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    kind: 'draft-live',
    tone: 'warning',
    priority: 102,
    headline: 'Draft is live',
    detail: activity.headline,
    actionLabel: 'Enter Draft',
    actionRoute: ['/leagues', league.leagueId, 'draft'],
  };
}

function closeMatchupItem(league: LeagueSummary): ManagerBriefingItem | null {
  const activity = league.dashboardActivity;
  const matchup = activity?.matchup;

  if (
    activity?.stage !== 'matchup-active' ||
    !matchup ||
    matchup.scoreStatusLabel === 'Bye' ||
    matchup.totalGames <= 0 ||
    matchup.progressPercent < CLOSE_MATCHUP_MINIMUM_PROGRESS_PERCENT
  ) {
    return null;
  }

  const margin = Math.abs(matchup.myScore - matchup.opponentScore);

  if (margin > CLOSE_MATCHUP_MAXIMUM_MARGIN) {
    return null;
  }

  const scoreContext = matchup.myScore === matchup.opponentScore
    ? 'Tied late'
    : matchup.myScore > matchup.opponentScore
      ? `Up ${formatScoreDifference(margin)} late`
      : `Down ${formatScoreDifference(margin)} late`;

  return {
    id: `${league.leagueId}:close-matchup:${matchup.cycleNumber}`,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    kind: 'close-matchup',
    tone: matchup.myScore < matchup.opponentScore ? 'warning' : 'info',
    priority: 100 + Math.max(0, 5 - margin),
    headline: `${scoreContext} vs ${matchup.opponentTeamName}`,
    detail: `${Math.round(matchup.progressPercent)}% of starter games complete.`,
    actionLabel: 'Open matchup',
    actionRoute: ['/leagues', league.leagueId, 'cycles', matchup.cycleNumber],
  };
}

function boundaryItem(league: LeagueSummary): ManagerBriefingItem | null {
  const count = league.dashboardActivity?.boundarySlotCount ?? 0;

  if (count <= 0) {
    return null;
  }

  return {
    id: `${league.leagueId}:boundary`,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    kind: 'boundary',
    tone: 'warning',
    priority: 90 + Math.min(4, count),
    headline: `${count} slot${count === 1 ? '' : 's'} near rollover`,
    detail: count === 1
      ? 'One NHL team game remains in its current window.'
      : 'Each has one NHL team game left in its current window.',
    actionLabel: 'Check windows',
    actionRoute: ['/leagues', league.leagueId, 'team'],
  };
}

function scheduledMoveItem(league: LeagueSummary): ManagerBriefingItem | null {
  const count = league.dashboardActivity?.queuedMoveCount ?? 0;

  if (count <= 0) {
    return null;
  }

  return {
    id: `${league.leagueId}:scheduled-move`,
    leagueId: league.leagueId,
    leagueName: league.leagueName,
    kind: 'scheduled-move',
    tone: 'info',
    priority: 86 + Math.min(4, count),
    headline: `${count} move${count === 1 ? '' : 's'} waiting`,
    detail: 'Activation follows the affected roster-slot boundary.',
    actionLabel: 'Review moves',
    actionRoute: ['/leagues', league.leagueId, 'team'],
  };
}

function buildLeagueCandidates(
  league: LeagueSummary,
  nowMilliseconds: number,
): ManagerBriefingItem[] {
  return [
    recentWaiverItem(league, nowMilliseconds),
    injuryItem(league),
    draftItem(league),
    closeMatchupItem(league),
    boundaryItem(league),
    scheduledMoveItem(league),
  ]
    .filter((item): item is ManagerBriefingItem => item !== null)
    .sort((left, right) =>
      right.priority - left.priority ||
      left.kind.localeCompare(right.kind));
}

/**
 * Builds a deliberately small, actionable dashboard briefing.
 *
 * At most one item from each league is included so a single busy league cannot
 * crowd every other league out of the manager's home screen. The full league
 * cards remain available below for lower-priority status and navigation.
 */
export function buildManagerBriefing(
  leagues: readonly LeagueSummary[],
  options: BuildManagerBriefingOptions = {},
): ManagerBriefingItem[] {
  const maximumItems = Math.min(
    HARD_MAXIMUM_ITEMS,
    Math.max(1, Math.trunc(options.maximumItems ?? DEFAULT_MAXIMUM_ITEMS)),
  );
  const nowMilliseconds = options.nowMilliseconds ?? Date.now();

  return leagues
    .map((league) => buildLeagueCandidates(league, nowMilliseconds)[0] ?? null)
    .filter((item): item is ManagerBriefingItem => item !== null)
    .sort((left, right) =>
      right.priority - left.priority ||
      left.leagueName.localeCompare(right.leagueName) ||
      left.leagueId.localeCompare(right.leagueId))
    .slice(0, maximumItems);
}
