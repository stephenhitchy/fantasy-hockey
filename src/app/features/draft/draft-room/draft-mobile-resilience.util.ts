import type {
  DraftAutoPickReason,
  DraftPick,
  DraftSelectionType,
} from '../../../core/draft/draft.models';

export type DraftMobilePanel = 'players' | 'queue' | 'roster';

export type DraftRealtimeConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stale'
  | 'offline';

export interface DraftConnectionHealthInput {
  online: boolean;
  confirmationStartedAt: number | null;
  criticalServerSyncTimes: Array<number | null>;
  listenerError: string | null;
  reconnectReason: 'initial' | 'online' | 'resume' | 'listener-error' | 'manual' | null;
  now: number;
  staleAfterMilliseconds?: number;
}

export interface DraftAutoPickExplanation {
  title: string;
  detail: string;
  tone: 'info' | 'warning';
}

const DEFAULT_STALE_AFTER_MILLISECONDS = 3500;

export function getLatestUndismissedAutoPick(
  picks: DraftPick[],
  ownerId: string,
  dismissedOverallPick: number,
): DraftPick | null {
  let latest: DraftPick | null = null;

  for (const pick of picks) {
    if (
      pick.ownerId !== ownerId ||
      pick.selectionType === undefined ||
      pick.selectionType === 'manual' ||
      pick.overallPick <= dismissedOverallPick
    ) {
      continue;
    }

    if (!latest || pick.overallPick > latest.overallPick) {
      latest = pick;
    }
  }

  return latest;
}

export function resolveDraftRealtimeConnectionState(
  input: DraftConnectionHealthInput,
): DraftRealtimeConnectionState {
  if (!input.online) {
    return 'offline';
  }

  const confirmationStartedAt = input.confirmationStartedAt;
  const allCriticalListenersConfirmed = input.criticalServerSyncTimes.every(
    (syncedAt) =>
      syncedAt !== null &&
      (confirmationStartedAt === null || syncedAt >= confirmationStartedAt),
  );

  if (allCriticalListenersConfirmed && !input.listenerError) {
    return 'connected';
  }

  if (input.reconnectReason === 'initial' && !input.listenerError) {
    return 'connecting';
  }

  const elapsed = confirmationStartedAt === null
    ? 0
    : Math.max(0, input.now - confirmationStartedAt);
  const staleAfterMilliseconds =
    input.staleAfterMilliseconds ?? DEFAULT_STALE_AFTER_MILLISECONDS;

  if (
    input.reconnectReason === 'resume' &&
    elapsed >= staleAfterMilliseconds
  ) {
    return 'stale';
  }

  return 'reconnecting';
}

export function getDraftAutoPickExplanation(
  pick: Pick<
    DraftPick,
    'selectionType' | 'autoPickReason' | 'overallPick' | 'asset'
  >,
  assetName: string,
): DraftAutoPickExplanation | null {
  const selectionType: DraftSelectionType | undefined = pick.selectionType;
  const reason: DraftAutoPickReason | null | undefined = pick.autoPickReason;

  if (!selectionType || selectionType === 'manual') {
    return null;
  }

  const clockExpired = reason === 'timer-expired';
  const fromQueue = selectionType === 'queue';

  if (fromQueue) {
    return {
      title: clockExpired ? 'Clock expired · queue pick used' : 'Auto-Draft used your queue',
      detail: `${assetName} was the first legal player in your queue for pick #${pick.overallPick}.`,
      tone: clockExpired ? 'warning' : 'info',
    };
  }

  return {
    title: clockExpired ? 'Clock expired · RinkRat completed the pick' : 'Auto-Draft completed your pick',
    detail: `No queued player fit an open roster spot, so RinkRat selected the highest-ranked legal option: ${assetName}.`,
    tone: clockExpired ? 'warning' : 'info',
  };
}

export function getDraftConnectionStatusLabel(
  state: DraftRealtimeConnectionState,
): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'offline':
      return 'Offline';
    case 'stale':
      return 'Draft view may be stale';
    case 'reconnecting':
      return 'Reconnecting';
    default:
      return 'Connecting';
  }
}

export function getDraftConnectionStatusDetail(
  state: DraftRealtimeConnectionState,
): string {
  switch (state) {
    case 'connected':
      return 'Draft picks and the server clock are live.';
    case 'offline':
      return 'Competitive actions are paused until your internet connection returns.';
    case 'stale':
      return 'RinkRat is waiting for a fresh server confirmation before allowing a pick.';
    case 'reconnecting':
      return 'RinkRat is restoring the draft, pick, and queue listeners.';
    default:
      return 'Waiting for the first server-confirmed draft snapshot.';
  }
}
