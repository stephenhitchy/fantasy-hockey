import type { FantasyDraft } from '../draft/draft.models';
import type {
  FantasyCycle,
  FantasyMatchup,
  FantasyTeamCycleWindows,
} from '../cycle/cycle.models';
import type { FantasyRoster } from '../team/roster.models';
import type { FantasyTeam } from '../team/team.service';
import type { DashboardLeagueActivity } from './dashboard-league-activity.models';

export interface DashboardLeagueActivityInput {
  leagueId: string;
  ownerId: string;
  isCommissioner: boolean;
  teamCount: number;
  maxTeams: number;
  teams: FantasyTeam[];
  draft: FantasyDraft | null;
  latestCycle: FantasyCycle | null;
  matchup: FantasyMatchup | null;
  myWindows: FantasyTeamCycleWindows | null;
  opponentWindows: FantasyTeamCycleWindows | null;
  roster: FantasyRoster | null;
}

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

function formatScheduledDraft(value: unknown): string {
  const date = toDate(value);

  if (!date) {
    return 'The commissioner has scheduled the draft.';
  }

  return `Scheduled for ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)}.`;
}

function countRosterAttention(roster: FantasyRoster | null): {
  injuredStarterCount: number;
  queuedMoveCount: number;
} {
  if (!roster) {
    return { injuredStarterCount: 0, queuedMoveCount: 0 };
  }

  const unavailableStatuses = new Set([
    'day-to-day',
    'out',
    'injured-reserve',
    'long-term-injured-reserve',
    'suspended',
    'personal-leave',
  ]);

  return roster.activeSlots.reduce(
    (summary, slot) => {
      if (slot.pendingMove) {
        summary.queuedMoveCount += 1;
      }

      const asset = slot.asset;
      const normalizedStatus = asset?.availabilityStatus?.trim().toLowerCase() ?? '';

      if (
        asset &&
        (asset.rosterStatus === 'injured' || unavailableStatuses.has(normalizedStatus))
      ) {
        summary.injuredStarterCount += 1;
      }

      return summary;
    },
    { injuredStarterCount: 0, queuedMoveCount: 0 },
  );
}

function summarizeWindows(
  first: FantasyTeamCycleWindows | null,
  second: FantasyTeamCycleWindows | null,
): { gamesPlayed: number; totalGames: number; gamesRemaining: number; progressPercent: number } {
  const windows = [first, second]
    .filter((entry): entry is FantasyTeamCycleWindows => Boolean(entry))
    .flatMap((entry) => entry.windows);

  const gamesPlayed = windows.reduce((sum, window) => sum + Math.max(0, window.gamesPlayed), 0);
  const gamesRemaining = windows.reduce((sum, window) => sum + Math.max(0, window.gamesLeft), 0);
  const totalGames = gamesPlayed + gamesRemaining;
  const progressPercent = totalGames > 0
    ? Number(Math.min(100, Math.max(0, (gamesPlayed / totalGames) * 100)).toFixed(1))
    : 0;

  return { gamesPlayed, totalGames, gamesRemaining, progressPercent };
}

function matchupScoreStatus(myScore: number, opponentScore: number, complete: boolean): string {
  if (myScore === opponentScore) {
    return complete ? 'Finished tied' : 'Tied';
  }

  if (myScore > opponentScore) {
    return complete ? 'Won' : 'Leading';
  }

  return complete ? 'Lost' : 'Trailing';
}

export function buildDashboardLeagueActivity(
  input: DashboardLeagueActivityInput,
): DashboardLeagueActivity {
  const attention = countRosterAttention(input.roster);
  const leagueRoute: Array<string | number> = ['/leagues', input.leagueId];
  const draft = input.draft;

  if (input.teamCount < 2 && (!draft || draft.status === 'setup')) {
    return {
      stage: 'forming',
      statusLabel: 'League Forming',
      tone: 'neutral',
      headline: input.isCommissioner ? 'Invite another manager' : 'Waiting for more managers',
      detail: `${input.teamCount} of ${input.maxTeams} teams have joined.`,
      primaryActionLabel: input.isCommissioner ? 'Open League HQ' : 'View League',
      primaryActionRoute: leagueRoute,
      ...attention,
      matchup: null,
    };
  }

  if (!draft || draft.status === 'setup') {
    return {
      stage: 'draft-setup',
      statusLabel: 'Draft Setup',
      tone: input.isCommissioner ? 'warning' : 'neutral',
      headline: input.isCommissioner ? 'Set up the league draft' : 'Draft details are being prepared',
      detail: input.isCommissioner
        ? 'Choose the draft order, clock, and start time.'
        : 'The commissioner has not scheduled the draft yet.',
      primaryActionLabel: input.isCommissioner ? 'Set Up Draft' : 'View League',
      primaryActionRoute: input.isCommissioner
        ? ['/leagues', input.leagueId, 'draft', 'setup']
        : leagueRoute,
      ...attention,
      matchup: null,
    };
  }

  if (draft.status === 'scheduled') {
    return {
      stage: 'draft-scheduled',
      statusLabel: 'Draft Scheduled',
      tone: 'info',
      headline: 'Your draft is on the calendar',
      detail: formatScheduledDraft(draft.scheduledStartAt),
      primaryActionLabel: 'Open Draft Room',
      primaryActionRoute: ['/leagues', input.leagueId, 'draft'],
      ...attention,
      matchup: null,
    };
  }

  if (draft.status === 'live') {
    const teamTotal = Math.max(1, draft.roundOneOrder.length);
    const totalPicks = Math.max(1, draft.totalRounds * teamTotal);
    const currentPick = Math.min(totalPicks, Math.max(1, draft.nextOverallPick));

    return {
      stage: 'draft-live',
      statusLabel: 'Draft Live',
      tone: 'warning',
      headline: `Pick ${currentPick} of ${totalPicks}`,
      detail: 'The draft is active now.',
      primaryActionLabel: 'Enter Draft Room',
      primaryActionRoute: ['/leagues', input.leagueId, 'draft'],
      ...attention,
      matchup: null,
    };
  }

  if (input.matchup) {
    const matchup = input.matchup;
    const isTeamA = matchup.teamAOwnerId === input.ownerId;
    const opponentOwnerId = isTeamA ? matchup.teamBOwnerId : matchup.teamAOwnerId;
    const opponent = input.teams.find((team) => team.ownerId === opponentOwnerId);
    const myScore = isTeamA ? matchup.teamAScore : matchup.teamBScore;
    const opponentScore = isTeamA ? matchup.teamBScore : matchup.teamAScore;
    const progress = summarizeWindows(input.myWindows, input.opponentWindows);
    const complete = matchup.status === 'complete';
    const opponentTeamName = opponentOwnerId
      ? opponent?.teamName ?? 'Opponent'
      : 'Bye';
    const detail = progress.totalGames > 0
      ? `Cycle ${matchup.cycleNumber} · ${progress.gamesRemaining} starter games left.`
      : `Cycle ${matchup.cycleNumber} · Progress will appear after roster windows load.`;

    return {
      stage: complete ? 'matchup-complete' : 'matchup-active',
      statusLabel: complete ? 'Matchup Complete' : 'Matchup Active',
      tone: complete ? 'success' : 'info',
      headline: opponentOwnerId ? `vs ${opponentTeamName}` : 'Bye matchup',
      detail,
      primaryActionLabel: 'Open Game Center',
      primaryActionRoute: ['/leagues', input.leagueId, 'cycles', matchup.cycleNumber],
      ...attention,
      matchup: {
        cycleNumber: matchup.cycleNumber,
        opponentTeamName,
        myScore,
        opponentScore,
        scoreStatusLabel: opponentOwnerId
          ? matchupScoreStatus(myScore, opponentScore, complete)
          : 'Bye',
        ...progress,
      },
    };
  }

  if (input.latestCycle?.status === 'complete') {
    const cycleLabel = input.latestCycle.phase === 'playoffs'
      ? input.latestCycle.playoffRoundLabel ?? `Playoff Round ${input.latestCycle.playoffRoundNumber ?? ''}`.trim()
      : `Cycle ${input.latestCycle.cycleNumber}`;

    return {
      stage: 'cycle-complete',
      statusLabel: 'Period Complete',
      tone: 'success',
      headline: `${cycleLabel} is complete`,
      detail: 'Your next matchup will appear when the next period opens.',
      primaryActionLabel: 'Review Game Center',
      primaryActionRoute: ['/leagues', input.leagueId, 'cycles', input.latestCycle.cycleNumber],
      ...attention,
      matchup: null,
    };
  }

  return {
    stage: 'season-preparing',
    statusLabel: 'Season Preparing',
    tone: 'neutral',
    headline: 'Draft complete',
    detail: 'Matchups will appear as soon as the season initializes.',
    primaryActionLabel: 'Open League HQ',
    primaryActionRoute: leagueRoute,
    ...attention,
    matchup: null,
  };
}
