export const TEAM_TRANSACTION_PREVIEW_LIMIT = 3;
export const TEAM_TRANSACTION_EXPANDED_LIMIT = 10;

export interface TransactionLedgerPreview<T> {
  visible: T[];
  hiddenCount: number;
}

export function buildTransactionLedgerPreview<T>(
  transactions: readonly T[],
  limit = TEAM_TRANSACTION_PREVIEW_LIMIT,
): TransactionLedgerPreview<T> {
  const normalizedLimit = Math.max(0, Math.trunc(limit));

  return {
    visible: transactions.slice(0, normalizedLimit),
    hiddenCount: Math.max(0, transactions.length - normalizedLimit),
  };
}
