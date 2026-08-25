export interface CommissionerChecklistItem {
  id:
    | 'manager-sign-in'
    | 'draft-time-shared'
    | 'queue-understood'
    | 'backup-device'
    | 'deputy-contact'
    | 'support-ready';
  label: string;
}

export type CommissionerChecklistState = Record<string, boolean>;

export const COMMISSIONER_DRAFT_NIGHT_CHECKLIST: readonly CommissionerChecklistItem[] = [
  {
    id: 'manager-sign-in',
    label: 'Every manager can sign in and sees the correct league and team.',
  },
  {
    id: 'draft-time-shared',
    label: 'The Draft time and expected arrival time were shared with the league.',
  },
  {
    id: 'queue-understood',
    label: 'Managers know the difference between Watch, Queue, manual picks, and Auto-Draft.',
  },
  {
    id: 'backup-device',
    label: 'The commissioner has a charged backup device or second browser available.',
  },
  {
    id: 'deputy-contact',
    label: 'One manager knows how to communicate with the league if the commissioner is busy.',
  },
  {
    id: 'support-ready',
    label: 'Known Issues, Support, and the feedback form are easy to reach during the Draft.',
  },
] as const;

export const COMMISSIONER_RECOVERY_STEPS = [
  'Do not repeat a Draft or roster action while RinkRat is still confirming it.',
  'Check the connection state and refresh once only after the current action has finished.',
  'Open Known Issues before assuming the problem affects only your league.',
  'Use the signed-in feedback form with the exact page, expected result, and observed result.',
  'Never manually “fix” a score, roster, waiver result, or six-game window outside the approved server tools.',
] as const;

export function normalizeCommissionerChecklistState(
  value: unknown,
): CommissionerChecklistState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const allowedIds: ReadonlySet<string> = new Set(
    COMMISSIONER_DRAFT_NIGHT_CHECKLIST.map((item) => item.id),
  );
  const normalized: CommissionerChecklistState = {};

  for (const [key, checked] of Object.entries(source)) {
    if (allowedIds.has(key) && checked === true) {
      normalized[key] = true;
    }
  }

  return normalized;
}

export function getCommissionerChecklistProgress(
  state: CommissionerChecklistState,
): { complete: number; total: number; percent: number } {
  const total = COMMISSIONER_DRAFT_NIGHT_CHECKLIST.length;
  const complete = COMMISSIONER_DRAFT_NIGHT_CHECKLIST.filter(
    (item) => state[item.id] === true,
  ).length;

  return {
    complete,
    total,
    percent: total > 0 ? Math.round((complete / total) * 100) : 0,
  };
}

export interface CommissionerMessageInput {
  leagueName: string;
  inviteCode: string;
  inviteUrl?: string;
  draftTimeLabel: string;
  managerCount: number;
  maximumTeams: number;
}

export function buildCommissionerInviteMessage(input: CommissionerMessageInput): string {
  const draftLine = input.draftTimeLabel
    ? `Draft: ${input.draftTimeLabel}`
    : 'Draft time: To be announced';

  return [
    `Join ${input.leagueName} on RinkRat Fantasy.`,
    ...(input.inviteUrl ? [`Join link: ${input.inviteUrl}`] : []),
    `Invite code: ${input.inviteCode}`,
    draftLine,
    `${input.managerCount} of ${input.maximumTeams} teams have joined.`,
    'RinkRat uses six NHL team games per active roster slot. Your seventh team game starts the next window.',
    'Sign in early enough to confirm your account, team name, Draft Queue, and connection.',
  ].join('\n');
}

export function buildCommissionerDraftNightMessage(input: CommissionerMessageInput): string {
  const when = input.draftTimeLabel || 'the scheduled time in RinkRat';

  return [
    `${input.leagueName} Draft reminder`,
    `We draft at ${when}.`,
    'Please sign in 15 minutes early, confirm your Queue, and keep the Draft Room open.',
    'If your timer expires, RinkRat may use your Queue or the best legal automatic selection.',
    'Do not submit the same pick repeatedly while the server is confirming it.',
  ].join('\n');
}
