import { Buffer } from 'node:buffer';

const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1_500;
const RINKRAT_DOCUMENT_ID_MAX_BYTES = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const RESERVED_DOCUMENT_ID_PATTERN = /^__.*__$/;

export interface FirestoreDocumentIdOptions {
  maxBytes?: number;
  minimumLength?: number;
  pattern?: RegExp;
  allowEmpty?: boolean;
  normalizeCase?: 'upper' | 'lower' | 'none';
}

export function normalizeFirestoreDocumentId(
  value: unknown,
  normalizeCase: FirestoreDocumentIdOptions['normalizeCase'] = 'none',
): string {
  const text = typeof value === 'string' ? value.trim() : '';

  if (normalizeCase === 'upper') {
    return text.toUpperCase();
  }

  if (normalizeCase === 'lower') {
    return text.toLowerCase();
  }

  return text;
}

export function isSafeFirestoreDocumentId(
  value: unknown,
  options: FirestoreDocumentIdOptions = {},
): boolean {
  const id = normalizeFirestoreDocumentId(value, options.normalizeCase ?? 'none');
  const maxBytes = Math.min(
    FIRESTORE_DOCUMENT_ID_MAX_BYTES,
    options.maxBytes ?? RINKRAT_DOCUMENT_ID_MAX_BYTES,
  );
  const minimumLength = Math.max(0, options.minimumLength ?? 1);

  if (!id) {
    return options.allowEmpty === true;
  }

  if (
    id.length < minimumLength ||
    Buffer.byteLength(id, 'utf8') > maxBytes ||
    id.includes('/') ||
    CONTROL_CHARACTER_PATTERN.test(id) ||
    id === '.' ||
    id === '..' ||
    RESERVED_DOCUMENT_ID_PATTERN.test(id)
  ) {
    return false;
  }

  if (options.pattern) {
    options.pattern.lastIndex = 0;
    if (!options.pattern.test(id)) {
      return false;
    }
  }

  return true;
}

export function resolveSafeFirestoreDocumentId(
  value: unknown,
  options: FirestoreDocumentIdOptions = {},
): string | null {
  const id = normalizeFirestoreDocumentId(value, options.normalizeCase ?? 'none');

  return isSafeFirestoreDocumentId(id, options) ? id : null;
}
