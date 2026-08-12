import type { FirestoreDocumentIdOptions } from './firestore-document-id-core.util';

export const FIRESTORE_AUTH_USER_ID_OPTIONS = { maxBytes: 128 } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_LEAGUE_ID_OPTIONS = { minimumLength: 3, maxBytes: 128, pattern: /^[A-Za-z0-9_-]+$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_REQUEST_ID_OPTIONS = { minimumLength: 8, maxBytes: 140, pattern: /^[A-Za-z0-9_-]+$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_TASK_ID_OPTIONS = { minimumLength: 8, maxBytes: 180, pattern: /^[A-Za-z0-9:_-]+$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_DRAFT_PICK_ID_OPTIONS = { minimumLength: 1, maxBytes: 12, pattern: /^[0-9]+$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_ROSTER_SLOT_ID_OPTIONS = { minimumLength: 1, maxBytes: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_ASSET_KEY_OPTIONS = { minimumLength: 2, maxBytes: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_SNAPSHOT_ID_OPTIONS = { minimumLength: 1, maxBytes: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_CATALOG_ID_OPTIONS = { minimumLength: 1, maxBytes: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_INVITE_CODE_OPTIONS = { minimumLength: 6, maxBytes: 24, pattern: /^[A-Z0-9]+$/, normalizeCase: 'upper' } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_PLAYER_ID_OPTIONS = { minimumLength: 1, maxBytes: 24, pattern: /^[0-9]+$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_FEEDBACK_ID_OPTIONS = { minimumLength: 8, maxBytes: 140, pattern: /^[A-Za-z0-9_-]+$/ } as const satisfies FirestoreDocumentIdOptions;
export const FIRESTORE_FINGERPRINT_ID_OPTIONS = { minimumLength: 8, maxBytes: 160, pattern: /^[A-Fa-f0-9_-]+$/ } as const satisfies FirestoreDocumentIdOptions;
