import { createHash } from 'node:crypto';

export const PRIVACY_OPERATIONS_RELEASE_LABEL = 'Release Candidate 56';
export const PRIVACY_OPERATIONS_SCORING_VERSION = 4;
export const PRIVACY_OPERATIONS_PROJECTION_VERSION = 11;
export const PRIVACY_REQUEST_RETENTION_DAYS = 730;
export const PRIVACY_EXPORT_AUDIT_RETENTION_DAYS = 365;
export const PRIVACY_REQUEST_RESPONSE_TARGET_DAYS = 30;
export const PRIVACY_REQUEST_MAXIMUM_PER_ACCOUNT = 100;
export const PRIVACY_REQUEST_TEXT_MAXIMUM = 1_600;
export const PRIVACY_REQUEST_SUBJECT_MAXIMUM = 120;
export const PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM = 1_200;
export const PRIVACY_REQUEST_ADMIN_NOTE_MAXIMUM = 1_600;
export const PRIVACY_EXPORT_MAXIMUM_BYTES = 4_500_000;
export const PRIVACY_EXPORTS_PER_DAY = 3;

export const PRIVACY_REQUEST_TYPES = [
  'data-access',
  'correction',
  'deletion-support',
  'privacy-question',
] as const;

export const PRIVACY_REQUEST_STATUSES = [
  'submitted',
  'in-review',
  'waiting-for-manager',
  'completed',
  'declined',
  'cancelled',
] as const;

export type PrivacyRequestType = typeof PRIVACY_REQUEST_TYPES[number];
export type PrivacyRequestStatus = typeof PRIVACY_REQUEST_STATUSES[number];

export interface PrivacyRetentionEntry {
  key: string;
  label: string;
  retention: string;
  detail: string;
}

export interface PrivacyRequestTimelineEntry {
  kind: 'manager-request' | 'manager-follow-up' | 'administrator-response' | 'status-change';
  message: string;
  status: PrivacyRequestStatus;
  occurredAt: string | null;
}

export interface PrivacyRequestPublicRecord {
  requestId: string;
  requestType: PrivacyRequestType;
  subject: string;
  details: string;
  status: PrivacyRequestStatus;
  publicResponse: string;
  revision: number;
  targetResponseAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  timeline: PrivacyRequestTimelineEntry[];
}

export const PRIVACY_RETENTION_CATALOG: readonly PrivacyRetentionEntry[] = [
  {
    key: 'account-profile',
    label: 'Account and public profile',
    retention: 'Until account deletion',
    detail: 'Removed through permanent account deletion, subject to protected league-history behavior.',
  },
  {
    key: 'league-history',
    label: 'Completed league competition history',
    retention: 'Kept anonymously when needed for league integrity',
    detail: 'Past Draft, score, matchup, standings, transaction, waiver, and playoff records are not rewritten when one manager deletes an account.',
  },
  {
    key: 'feedback',
    label: 'Support and feedback reports',
    retention: 'Up to 365 days',
    detail: 'Eligible reports carry an expiration time and are also removed during account deletion when still linked to the account.',
  },
  {
    key: 'diagnostics',
    label: 'Client error diagnostics',
    retention: 'Up to 90 days',
    detail: 'Privacy-limited technical reports carry an expiration time and are removed during account deletion when still linked to the account.',
  },
  {
    key: 'beta-evidence',
    label: 'Raw and aggregated beta evidence',
    retention: '90 days raw / 180 days aggregated',
    detail: 'Operational evidence is privacy-limited and does not contain raw rosters, scores, invite codes, or full browsing history.',
  },
  {
    key: 'private-season',
    label: 'Private-season research and engagement',
    retention: 'Removed from the account relationship during account deletion',
    detail: 'Manager-day and survey evidence use league-specific pseudonymous hashes rather than public account identity.',
  },
  {
    key: 'privacy-requests',
    label: 'Privacy-request operations',
    retention: 'Up to 730 days',
    detail: 'Request status and audit evidence expire through scheduled cleanup. Account deletion removes personal request text and direct account linkage while retaining a limited pseudonymous operations record until expiration.',
  },
  {
    key: 'privacy-exports',
    label: 'Data-export audit metadata',
    retention: 'Up to 365 days',
    detail: 'RinkRat stores package metadata and a content hash, not a server copy of the downloaded export file.',
  },
] as const;

const REQUEST_TYPE_SET = new Set<PrivacyRequestType>(PRIVACY_REQUEST_TYPES);
const REQUEST_STATUS_SET = new Set<PrivacyRequestStatus>(PRIVACY_REQUEST_STATUSES);
const TERMINAL_STATUS_SET = new Set<PrivacyRequestStatus>([
  'completed',
  'declined',
  'cancelled',
]);
const REQUEST_TRANSITIONS: Readonly<Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]>> = {
  submitted: ['in-review', 'waiting-for-manager', 'completed', 'declined', 'cancelled'],
  'in-review': ['waiting-for-manager', 'completed', 'declined', 'cancelled'],
  'waiting-for-manager': ['in-review', 'completed', 'declined', 'cancelled'],
  completed: [],
  declined: [],
  cancelled: [],
};

export function boundedPrivacyText(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maximumLength)
    : '';
}

export function normalizePrivacyRequestType(value: unknown): PrivacyRequestType | null {
  const candidate = boundedPrivacyText(value, 40) as PrivacyRequestType;
  return REQUEST_TYPE_SET.has(candidate) ? candidate : null;
}

export function normalizePrivacyRequestStatus(value: unknown): PrivacyRequestStatus | null {
  const candidate = boundedPrivacyText(value, 40) as PrivacyRequestStatus;
  return REQUEST_STATUS_SET.has(candidate) ? candidate : null;
}

export function privacyRequestTypeLabel(value: PrivacyRequestType): string {
  const labels: Record<PrivacyRequestType, string> = {
    'data-access': 'Additional data access',
    correction: 'Correct my account information',
    'deletion-support': 'Account deletion help',
    'privacy-question': 'Privacy question',
  };
  return labels[value];
}

export function privacyRequestStatusLabel(value: PrivacyRequestStatus): string {
  const labels: Record<PrivacyRequestStatus, string> = {
    submitted: 'Submitted',
    'in-review': 'In review',
    'waiting-for-manager': 'Waiting for you',
    completed: 'Completed',
    declined: 'Declined',
    cancelled: 'Cancelled',
  };
  return labels[value];
}

export function isPrivacyRequestTerminal(value: PrivacyRequestStatus): boolean {
  return TERMINAL_STATUS_SET.has(value);
}

export function canTransitionPrivacyRequest(
  current: PrivacyRequestStatus,
  next: PrivacyRequestStatus,
): boolean {
  return current === next || REQUEST_TRANSITIONS[current].includes(next);
}

export function privacyOwnerReference(userId: string): string {
  return createHash('sha256')
    .update(`rinkrat-privacy-owner-v1:${userId}`)
    .digest('hex')
    .slice(0, 20);
}

export function privacyExportFileName(username: string, dateKey: string): string {
  const safeName = boundedPrivacyText(username, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'manager';
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : 'export';
  return `rinkrat-${safeName}-data-${safeDate}.json`;
}

export function buildPrivacyRequestPublicRecord(input: Record<string, unknown>): PrivacyRequestPublicRecord | null {
  const requestType = normalizePrivacyRequestType(input['requestType']);
  const status = normalizePrivacyRequestStatus(input['status']);
  const requestId = boundedPrivacyText(input['requestId'], 128);
  if (!requestId || !requestType || !status) return null;

  const timeline = Array.isArray(input['timeline'])
    ? input['timeline']
        .map((entry) => {
          const record = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as Record<string, unknown>
            : {};
          const entryStatus = normalizePrivacyRequestStatus(record['status']) ?? status;
          const kind = boundedPrivacyText(record['kind'], 40) as PrivacyRequestTimelineEntry['kind'];
          if (!['manager-request', 'manager-follow-up', 'administrator-response', 'status-change'].includes(kind)) {
            return null;
          }
          return {
            kind,
            message: boundedPrivacyText(record['message'], PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM),
            status: entryStatus,
            occurredAt: typeof record['occurredAt'] === 'string' ? record['occurredAt'] : null,
          } satisfies PrivacyRequestTimelineEntry;
        })
        .filter((entry): entry is PrivacyRequestTimelineEntry => entry !== null)
        .slice(-20)
    : [];

  return {
    requestId,
    requestType,
    subject: boundedPrivacyText(input['subject'], PRIVACY_REQUEST_SUBJECT_MAXIMUM),
    details: boundedPrivacyText(input['details'], PRIVACY_REQUEST_TEXT_MAXIMUM),
    status,
    publicResponse: boundedPrivacyText(input['publicResponse'], PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM),
    revision: typeof input['revision'] === 'number' && Number.isFinite(input['revision'])
      ? Math.max(1, Math.round(input['revision']))
      : 1,
    targetResponseAt: typeof input['targetResponseAt'] === 'string' ? input['targetResponseAt'] : null,
    createdAt: typeof input['createdAt'] === 'string' ? input['createdAt'] : null,
    updatedAt: typeof input['updatedAt'] === 'string' ? input['updatedAt'] : null,
    completedAt: typeof input['completedAt'] === 'string' ? input['completedAt'] : null,
    timeline,
  };
}
