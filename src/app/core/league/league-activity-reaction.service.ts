import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import {
  type LeagueActivityEventType,
  type LeagueActivityReactionCounts,
  type LeagueActivityReactionType,
} from './league-activity.models';

export interface LeagueActivityReactionOption {
  reactionType: LeagueActivityReactionType;
  emoji: string;
  label: string;
}

export const LEAGUE_ACTIVITY_REACTION_OPTIONS: readonly LeagueActivityReactionOption[] = [
  { reactionType: 'stick-tap', emoji: '🏒', label: 'Stick tap' },
  { reactionType: 'fire', emoji: '🔥', label: 'On fire' },
  { reactionType: 'wow', emoji: '😮', label: 'No way' },
  { reactionType: 'rink-rat', emoji: '🐀', label: 'Rink Rat' },
];

const REACTION_EVENT_TYPES = new Set<LeagueActivityEventType>([
  'draft-pick',
  'add-drop',
  'add-open-slot',
  'move-to-ir',
  'activate-from-ir',
  'drop-to-waivers',
  'waiver-award',
  'waiver-cleared',
  'slot-move-activated',
  'active-bench-swap-activated',
  'move-bench-to-ir',
  'activate-ir-to-bench',
  'matchup-result',
  'commissioner-announcement',
  'matchup-round-recap',
]);

export function leagueActivitySupportsReactions(
  eventType: LeagueActivityEventType,
): boolean {
  return REACTION_EVENT_TYPES.has(eventType);
}

export interface SetLeagueActivityReactionInput {
  leagueId: string;
  activityId: string;
  reactionType: LeagueActivityReactionType | null;
}

export interface SetLeagueActivityReactionResult {
  activityId: string;
  reactionType: LeagueActivityReactionType | null;
  reactionCounts: LeagueActivityReactionCounts;
  changed: boolean;
}

function callableMessage(error: unknown, fallback: string): string {
  const candidate = error !== null && typeof error === 'object'
    ? error as { message?: unknown }
    : null;
  return typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message.trim().replace(/^Firebase:\s*/i, '')
    : fallback;
}

const setLeagueActivityReactionCallable = httpsCallable<
  SetLeagueActivityReactionInput,
  SetLeagueActivityReactionResult
>(functions, 'setLeagueActivityReaction', { timeout: 30_000 });

export async function setLeagueActivityReaction(
  input: SetLeagueActivityReactionInput,
): Promise<SetLeagueActivityReactionResult> {
  const leagueId = input.leagueId.trim();
  const activityId = input.activityId.trim();

  if (!leagueId || !activityId) {
    throw new Error('Choose a valid League Wire update.');
  }

  try {
    const response = await setLeagueActivityReactionCallable({
      leagueId,
      activityId,
      reactionType: input.reactionType,
    });
    return response.data;
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to update that reaction right now.'));
  }
}
