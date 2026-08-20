export type PrivacyRequestType =
  | 'data-access'
  | 'correction'
  | 'deletion-support'
  | 'privacy-question';

export type PrivacyRequestStatus =
  | 'submitted'
  | 'in-review'
  | 'waiting-for-manager'
  | 'completed'
  | 'declined'
  | 'cancelled';

export type PrivacyRequestTimelineKind =
  | 'manager-request'
  | 'manager-follow-up'
  | 'administrator-response'
  | 'status-change';

export interface PrivacyRequestTimelineEntry {
  kind: PrivacyRequestTimelineKind;
  message: string;
  status: PrivacyRequestStatus;
  occurredAt: string | null;
}

export interface PrivacyRequestRecord {
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

export interface PrivacyRequestAdminRecord extends PrivacyRequestRecord {
  ownerReference: string;
  adminNotes: string;
  overdue: boolean;
  lastUpdatedByRole: string;
}

export interface PrivacyRetentionEntry {
  key: string;
  label: string;
  retention: string;
  detail: string;
}

export interface PrivacyExportAudit {
  exportId: string;
  generatedAt: string | null;
  fileName: string;
  byteSize: number;
  packageHash: string;
  recordCounts: Record<string, number>;
}

export interface PrivacyExportAuditAdmin extends PrivacyExportAudit {
  ownerReference: string;
}

export interface PrivacyCenterSnapshot {
  generatedAt: string;
  requests: PrivacyRequestRecord[];
  exports: PrivacyExportAudit[];
  retention: readonly PrivacyRetentionEntry[];
  responseTargetDays: number;
  responseTargetIsLegalDeadline: false;
}

export interface PrivacyOperationsDashboard {
  generatedAt: string;
  requests: PrivacyRequestAdminRecord[];
  exports: PrivacyExportAuditAdmin[];
  summary: {
    totalRequests: number;
    openRequests: number;
    waitingForManager: number;
    overdueRequests: number;
    completedRequests: number;
    exportCount: number;
  };
  responseTargetDays: number;
  responseTargetIsLegalDeadline: false;
}

export interface PrivacyExportPackageResponse {
  fileName: string;
  packageHash: string;
  byteSize: number;
  recordCounts: Record<string, number>;
  json: string;
}

export const PRIVACY_REQUEST_TYPE_OPTIONS: ReadonlyArray<{
  value: PrivacyRequestType;
  label: string;
  detail: string;
}> = [
  {
    value: 'data-access',
    label: 'Additional data access',
    detail: 'Ask for account information that is not present in the immediate JSON export.',
  },
  {
    value: 'correction',
    label: 'Correct my account information',
    detail: 'Report inaccurate personal account information that cannot be corrected in Account Settings.',
  },
  {
    value: 'deletion-support',
    label: 'Account deletion help',
    detail: 'Request help when the self-service account-deletion workflow is blocked or unclear.',
  },
  {
    value: 'privacy-question',
    label: 'Privacy question',
    detail: 'Ask how RinkRat stores, uses, retains, exports, or deletes account-related information.',
  },
] as const;

export const PRIVACY_REQUEST_STATUS_OPTIONS: ReadonlyArray<{
  value: PrivacyRequestStatus;
  label: string;
}> = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'in-review', label: 'In review' },
  { value: 'waiting-for-manager', label: 'Waiting for manager' },
  { value: 'completed', label: 'Completed' },
  { value: 'declined', label: 'Declined' },
  { value: 'cancelled', label: 'Cancelled' },
] as const;

export function privacyRequestTypeLabel(value: PrivacyRequestType): string {
  return PRIVACY_REQUEST_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function privacyRequestStatusLabel(value: PrivacyRequestStatus): string {
  return PRIVACY_REQUEST_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function isPrivacyRequestClosed(value: PrivacyRequestStatus): boolean {
  return value === 'completed' || value === 'declined' || value === 'cancelled';
}
