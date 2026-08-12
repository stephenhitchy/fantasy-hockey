import { HttpsError } from 'firebase-functions/v2/https';

import {
  type FirestoreDocumentIdOptions,
  isSafeFirestoreDocumentId,
  normalizeFirestoreDocumentId,
  resolveSafeFirestoreDocumentId,
} from './firestore-document-id-core.util';

export type { FirestoreDocumentIdOptions } from './firestore-document-id-core.util';
export {
  isSafeFirestoreDocumentId,
  resolveSafeFirestoreDocumentId,
} from './firestore-document-id-core.util';

export function requireFirestoreDocumentId(
  value: unknown,
  fieldLabel: string,
  options: FirestoreDocumentIdOptions = {},
): string {
  const id = resolveSafeFirestoreDocumentId(value, options);

  if (!id) {
    throw new HttpsError(
      'invalid-argument',
      `The ${fieldLabel} is invalid. Refresh the page and try again.`,
      { reason: 'invalid-firestore-document-id', field: fieldLabel },
    );
  }

  return id;
}

export function optionalFirestoreDocumentId(
  value: unknown,
  fieldLabel: string,
  options: Omit<FirestoreDocumentIdOptions, 'allowEmpty'> = {},
): string | null {
  const id = normalizeFirestoreDocumentId(value, options.normalizeCase ?? 'none');

  return id
    ? requireFirestoreDocumentId(id, fieldLabel, options)
    : null;
}

export function requireFirestoreDocumentIds(
  value: unknown,
  fieldLabel: string,
  options: Omit<FirestoreDocumentIdOptions, 'allowEmpty'> & {
    maximumCount?: number;
  } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new HttpsError(
      'invalid-argument',
      `The ${fieldLabel} list is invalid.`,
      { reason: 'invalid-firestore-document-id-list', field: fieldLabel },
    );
  }

  const maximumCount = options.maximumCount ?? 100;

  if (value.length > maximumCount) {
    throw new HttpsError(
      'invalid-argument',
      `The ${fieldLabel} list contains too many entries.`,
      { reason: 'invalid-firestore-document-id-list', field: fieldLabel },
    );
  }

  return value.map((entry) => requireFirestoreDocumentId(entry, fieldLabel, options));
}

export function requireServerFirestoreDocumentId(
  value: unknown,
  fieldLabel: string,
  options: FirestoreDocumentIdOptions = {},
): string {
  const id = resolveSafeFirestoreDocumentId(value, options);

  if (!id) {
    throw new Error(`RinkRat rejected an invalid ${fieldLabel}.`);
  }

  return id;
}
