export type CommissionerReadinessStatus = 'ready' | 'attention' | 'blocked';

export interface CommissionerReadinessCheck {
  id:
    | 'verified-account'
    | 'league-filled'
    | 'draft-order'
    | 'draft-scheduled'
    | 'projection-ready';
  title: string;
  status: CommissionerReadinessStatus;
  detail: string;
  actionLabel: string;
  actionPath: readonly string[];
}

export interface CommissionerReadinessInput {
  leagueId: string;
  emailVerified: boolean;
  teamCount: number;
  maximumTeams: number;
  draftStatus: 'missing' | 'setup' | 'scheduled' | 'live' | 'complete';
  draftSettingsSaved: boolean;
  draftScheduled: boolean;
  projectionStatus: 'missing' | 'building' | 'ready' | 'error';
  projectionVersion: number | null;
  scoringRulesVersion: number | null;
  expectedProjectionVersion: number;
  expectedScoringRulesVersion: number;
}

export interface CommissionerReadinessSummary {
  status: CommissionerReadinessStatus;
  headline: string;
  detail: string;
  readyCount: number;
  totalCount: number;
  checks: CommissionerReadinessCheck[];
}

function leaguePath(leagueId: string, ...segments: string[]): readonly string[] {
  return ['/leagues', leagueId, ...segments];
}

export function buildCommissionerReadiness(
  input: CommissionerReadinessInput,
): CommissionerReadinessSummary {
  const safeTeamCount = Math.max(0, Math.floor(input.teamCount));
  const safeMaximumTeams = Math.max(2, Math.floor(input.maximumTeams));
  const leagueFilled = safeTeamCount >= safeMaximumTeams;
  const enoughManagersToRehearse = safeTeamCount >= 2;
  const draftAlreadyRunning = input.draftStatus === 'live' || input.draftStatus === 'complete';
  const projectionMatches =
    input.projectionStatus === 'ready' &&
    input.projectionVersion === input.expectedProjectionVersion &&
    input.scoringRulesVersion === input.expectedScoringRulesVersion;

  const checks: CommissionerReadinessCheck[] = [
    {
      id: 'verified-account',
      title: 'Commissioner account',
      status: input.emailVerified ? 'ready' : 'blocked',
      detail: input.emailVerified
        ? 'Email is verified for commissioner actions.'
        : 'Verify the commissioner email before league setup or Draft control.',
      actionLabel: input.emailVerified ? 'Account ready' : 'Verify account',
      actionPath: ['/account', 'settings'],
    },
    {
      id: 'league-filled',
      title: 'Managers joined',
      status: leagueFilled ? 'ready' : enoughManagersToRehearse ? 'attention' : 'blocked',
      detail: leagueFilled
        ? `${safeTeamCount} of ${safeMaximumTeams} intended teams have joined.`
        : `${safeTeamCount} of ${safeMaximumTeams} intended teams have joined.`,
      actionLabel: leagueFilled ? 'League filled' : 'Copy invite',
      actionPath: leaguePath(input.leagueId, 'commissioner'),
    },
    {
      id: 'draft-order',
      title: 'Draft order',
      status: draftAlreadyRunning || input.draftSettingsSaved
        ? 'ready'
        : leagueFilled
          ? 'attention'
          : 'blocked',
      detail: draftAlreadyRunning
        ? 'The Draft order is locked for this Draft.'
        : input.draftSettingsSaved
          ? 'Every current team is included in the saved Round 1 order.'
          : leagueFilled
            ? 'Save the Round 1 order after every intended manager has joined.'
            : 'Finish filling the league before locking the Draft order.',
      actionLabel: draftAlreadyRunning || input.draftSettingsSaved ? 'Order ready' : 'Open Draft Setup',
      actionPath: leaguePath(input.leagueId, 'draft', 'setup'),
    },
    {
      id: 'draft-scheduled',
      title: 'Draft time',
      status: draftAlreadyRunning || input.draftScheduled ? 'ready' : 'attention',
      detail: draftAlreadyRunning
        ? 'The Draft is already live or complete.'
        : input.draftScheduled
          ? 'A Draft time is saved and shown in each manager’s local timezone.'
          : 'Choose and save the Draft date, time, and pick clock.',
      actionLabel: draftAlreadyRunning || input.draftScheduled ? 'Time ready' : 'Schedule Draft',
      actionPath: leaguePath(input.leagueId, 'draft', 'setup'),
    },
    {
      id: 'projection-ready',
      title: 'Verified Draft board',
      status: draftAlreadyRunning || projectionMatches
        ? 'ready'
        : input.projectionStatus === 'building'
          ? 'attention'
          : 'blocked',
      detail: draftAlreadyRunning
        ? 'The live or completed Draft is using its frozen verified board.'
        : projectionMatches
          ? `Projection V${input.expectedProjectionVersion} matches Scoring V${input.expectedScoringRulesVersion}.`
          : input.projectionStatus === 'building'
            ? 'The server is building the verified Projection V11 board.'
            : input.projectionStatus === 'error'
              ? 'The most recent projection build needs attention before Draft night.'
              : 'Generate and verify the Draft board before the scheduled start.',
      actionLabel: draftAlreadyRunning || projectionMatches ? 'Board ready' : 'Open Projection Lab',
      actionPath: leaguePath(input.leagueId, 'projections'),
    },
  ];

  const readyCount = checks.filter((check) => check.status === 'ready').length;
  const blockedCount = checks.filter((check) => check.status === 'blocked').length;
  const attentionCount = checks.filter((check) => check.status === 'attention').length;
  const status: CommissionerReadinessStatus = blockedCount > 0
    ? 'blocked'
    : attentionCount > 0
      ? 'attention'
      : 'ready';

  return {
    status,
    headline: status === 'ready'
      ? 'Ready for a Draft rehearsal'
      : status === 'attention'
        ? 'A few items still need attention'
        : 'Resolve the blocked items first',
    detail: status === 'ready'
      ? 'Run the device checklist below, then rehearse the complete Draft with real managers.'
      : status === 'attention'
        ? 'Nothing here changes competition data. Use the linked setup pages to finish the remaining items.'
        : 'Do not schedule a live Draft until the blocked readiness checks are resolved.',
    readyCount,
    totalCount: checks.length,
    checks,
  };
}
