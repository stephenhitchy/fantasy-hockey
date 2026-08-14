import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export const LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH = 72;
export const LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH = 500;
export const LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES = 8;

export interface PublishLeagueAnnouncementInput {
  leagueId: string;
  title: string;
  body: string;
  pin: boolean;
  requestId: string;
}

export interface PublishLeagueAnnouncementResult {
  published: true;
  activityId: string;
  pinned: boolean;
  idempotentReplay: boolean;
}

export interface UnpinLeagueAnnouncementResult {
  unpinned: boolean;
}

function randomRequestSegment(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createLeagueAnnouncementRequestId(): string {
  return `announcement-${randomRequestSegment()}`;
}

function stripUnsafeAnnouncementCharacters(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
}

export function normalizeLeagueAnnouncementTitle(value: string): string {
  return stripUnsafeAnnouncementCharacters(value).trim().replace(/\s+/g, ' ');
}

export function normalizeLeagueAnnouncementBody(value: string): string {
  const lines = stripUnsafeAnnouncementCharacters(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, ' ').trim().replace(/[ ]{2,}/g, ' '));

  while (lines.length > 0 && !lines[0]) {
    lines.shift();
  }

  while (lines.length > 0 && !lines[lines.length - 1]) {
    lines.pop();
  }

  return lines.join('\n');
}

function callableMessage(error: unknown, fallback: string): string {
  const candidate = error !== null && typeof error === 'object'
    ? error as { message?: unknown }
    : null;
  return typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message.trim().replace(/^Firebase:\s*/i, '')
    : fallback;
}

const publishLeagueAnnouncementCallable = httpsCallable<
  PublishLeagueAnnouncementInput,
  PublishLeagueAnnouncementResult
>(functions, 'publishLeagueAnnouncement', { timeout: 30_000 });

const unpinLeagueAnnouncementCallable = httpsCallable<
  { leagueId: string },
  UnpinLeagueAnnouncementResult
>(functions, 'unpinLeagueAnnouncement', { timeout: 30_000 });

export async function publishLeagueAnnouncement(
  input: PublishLeagueAnnouncementInput,
): Promise<PublishLeagueAnnouncementResult> {
  const title = normalizeLeagueAnnouncementTitle(input.title);
  const body = normalizeLeagueAnnouncementBody(input.body);
  const lineCount = body ? body.split('\n').length : 0;

  if (!title || title.length > LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH) {
    throw new Error(`Use a title between 1 and ${LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH} characters.`);
  }

  if (
    !body ||
    body.length > LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH ||
    lineCount > LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES
  ) {
    throw new Error(
      `Use a message up to ${LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH} characters and ${LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES} lines.`,
    );
  }

  try {
    const response = await publishLeagueAnnouncementCallable({
      ...input,
      title,
      body,
    });
    return response.data;
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to post the announcement right now.'));
  }
}

export async function unpinLeagueAnnouncement(
  leagueId: string,
): Promise<UnpinLeagueAnnouncementResult> {
  try {
    const response = await unpinLeagueAnnouncementCallable({ leagueId });
    return response.data;
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to unpin the announcement right now.'));
  }
}
