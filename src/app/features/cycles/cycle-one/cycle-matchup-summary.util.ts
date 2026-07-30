export interface MatchupSummaryContext {
  isComplete: boolean;
  hasOpponent: boolean;
  hasCycle: boolean;
  hasScoring: boolean;
  scoringLoading: boolean;
  readyToComplete: boolean;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAName: string;
  teamBName: string;
  teamAScore: number;
  teamBScore: number;
  teamAProjection: number | null;
  teamBProjection: number | null;
  viewerId: string;
  playedGames: number;
  totalGames: number;
  gamesLeft: number;
}

export function getMatchupProgressPercent(context: MatchupSummaryContext): number {
  if (context.totalGames <= 0) {
    return 0;
  }

  const percentage = (context.playedGames / context.totalGames) * 100;
  return Number(Math.min(100, Math.max(0, percentage)).toFixed(1));
}

export function getMatchupProgressSummary(context: MatchupSummaryContext): string {
  if (context.isComplete) {
    return context.totalGames > 0
      ? `${context.playedGames} of ${context.totalGames} counted games complete`
      : 'Final result saved';
  }

  if (context.totalGames <= 0) {
    return 'Waiting for roster windows';
  }

  return `${context.playedGames} of ${context.totalGames} counted · ${context.gamesLeft} left`;
}

export function getMatchupProgressStageLabel(context: MatchupSummaryContext): string {
  if (context.isComplete) {
    return 'Final result saved';
  }

  if (context.scoringLoading) {
    return 'Checking final NHL results';
  }

  if (!context.hasScoring) {
    return 'Progress appears when scoring begins';
  }

  if (context.readyToComplete) {
    return 'All counted games are finished';
  }

  const progress = getMatchupProgressPercent(context);

  if (progress <= 0) {
    return 'Matchup has not started';
  }

  if (progress < 33) {
    return 'Early in the matchup';
  }

  if (progress < 67) {
    return 'Midway through the matchup';
  }

  if (progress < 90) {
    return 'Late in the matchup';
  }

  return 'Nearly complete';
}

export function getMatchupProjectionStageLabel(context: MatchupSummaryContext): string {
  if (context.isComplete) {
    return 'Final score — no longer a projection';
  }

  if (
    typeof context.teamAProjection !== 'number' ||
    typeof context.teamBProjection !== 'number'
  ) {
    return 'Projection is not available yet';
  }

  const progress = getMatchupProgressPercent(context);

  if (progress <= 0) {
    return 'Pre-matchup estimate';
  }

  if (progress < 33) {
    return 'Early estimate — many games remain';
  }

  if (progress < 67) {
    return 'Developing estimate';
  }

  if (progress < 90) {
    return 'Late-matchup estimate';
  }

  return 'Near-final estimate';
}

export function getMatchupMobileStatusLabel(context: MatchupSummaryContext): string {
  if (context.isComplete) {
    return 'Final';
  }

  if (context.scoringLoading) {
    return 'Updating';
  }

  if (!context.hasScoring) {
    return 'Waiting';
  }

  if (context.readyToComplete) {
    return 'Finalizing';
  }

  return `${context.gamesLeft} left`;
}

export function getMatchupOutcomeHeadline(context: MatchupSummaryContext): string {
  const viewerIsTeamA = context.teamAOwnerId === context.viewerId;
  const viewerIsTeamB = context.teamBOwnerId === context.viewerId;
  const viewerIsInMatchup = viewerIsTeamA || viewerIsTeamB;

  if (!context.hasOpponent) {
    return viewerIsInMatchup ? 'You have a bye' : `${context.teamAName} has a bye`;
  }

  if (!context.hasCycle || (!context.hasScoring && !context.isComplete)) {
    return 'Matchup scoring is getting ready';
  }

  const difference = Number(Math.abs(context.teamAScore - context.teamBScore).toFixed(1));

  if (context.teamAScore === context.teamBScore) {
    if (context.isComplete) {
      return viewerIsInMatchup ? 'Your matchup finished tied' : 'The matchup finished tied';
    }

    return viewerIsInMatchup ? 'Your matchup is tied' : 'The matchup is tied';
  }

  const leadingOwnerId =
    context.teamAScore > context.teamBScore ? context.teamAOwnerId : context.teamBOwnerId;
  const leadingTeamName =
    leadingOwnerId === context.teamAOwnerId ? context.teamAName : context.teamBName;
  const viewerIsLeading = leadingOwnerId === context.viewerId;

  if (context.isComplete) {
    if (viewerIsInMatchup) {
      return viewerIsLeading
        ? `You won by ${difference.toFixed(1)}`
        : `You lost by ${difference.toFixed(1)}`;
    }

    return `${leadingTeamName} won by ${difference.toFixed(1)}`;
  }

  if (viewerIsInMatchup) {
    return viewerIsLeading
      ? `You lead by ${difference.toFixed(1)}`
      : `You trail by ${difference.toFixed(1)}`;
  }

  return `${leadingTeamName} leads by ${difference.toFixed(1)}`;
}

export function getMatchupOutcomeDetail(context: MatchupSummaryContext): string {
  if (!context.hasOpponent) {
    return 'No opponent is assigned to this matchup, so the team advances without a head-to-head result.';
  }

  if (context.isComplete) {
    return `Final score: ${context.teamAName} ${context.teamAScore.toFixed(1)}, ${context.teamBName} ${context.teamBScore.toFixed(1)}.`;
  }

  if (context.scoringLoading) {
    return 'The server is checking final NHL results and updating both lineups.';
  }

  if (!context.hasScoring) {
    return 'Scores and counted-game progress will appear after the first eligible NHL results are processed.';
  }

  if (context.readyToComplete) {
    return 'All counted roster games are finished. The server will finalize this matchup automatically.';
  }

  const gameLabel =
    context.gamesLeft === 1 ? 'counted roster game remains' : 'counted roster games remain';

  return `${context.gamesLeft} ${gameLabel} across both starting lineups.`;
}

export function getMatchupScoreAriaLabel(context: MatchupSummaryContext): string {
  if (!context.hasOpponent) {
    return getMatchupOutcomeHeadline(context);
  }

  return `${context.teamAName} ${context.teamAScore.toFixed(1)}. ${context.teamBName} ${context.teamBScore.toFixed(1)}. ${getMatchupOutcomeHeadline(context)}. ${getMatchupProgressSummary(context)}.`;
}
