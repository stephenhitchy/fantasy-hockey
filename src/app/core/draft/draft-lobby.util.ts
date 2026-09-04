export const DRAFT_LOBBY_WINDOW_MILLISECONDS = 60 * 60 * 1000;

export type DraftLobbyState = 'unavailable' | 'waiting' | 'open' | 'started';

interface DraftLobbyStateInput {
  draftStatus: string | null | undefined;
  scheduledStart: Date | null;
  now: Date;
}

export function getDraftLobbyState({
  draftStatus,
  scheduledStart,
  now,
}: DraftLobbyStateInput): DraftLobbyState {
  if (
    draftStatus !== 'scheduled' ||
    !scheduledStart ||
    Number.isNaN(scheduledStart.getTime()) ||
    Number.isNaN(now.getTime())
  ) {
    return 'unavailable';
  }

  const millisecondsUntilStart = scheduledStart.getTime() - now.getTime();

  if (millisecondsUntilStart <= 0) {
    return 'started';
  }

  return millisecondsUntilStart <= DRAFT_LOBBY_WINDOW_MILLISECONDS ? 'open' : 'waiting';
}

export function getDraftLobbyOpenDate(scheduledStart: Date | null): Date | null {
  if (!scheduledStart || Number.isNaN(scheduledStart.getTime())) {
    return null;
  }

  return new Date(scheduledStart.getTime() - DRAFT_LOBBY_WINDOW_MILLISECONDS);
}
