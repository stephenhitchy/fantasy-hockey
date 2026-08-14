import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';
import {
  type LeagueActivityEventType,
  type LeagueActivityReactionCounts,
  type LeagueActivityReactionType,
} from './league-activity.models';
import {
  leagueActivityReactionLabel,
  normalizeLeagueActivityReactionType,
} from './league-activity-reaction.util';

export interface LeagueActivityReactionOption {
  reactionType: LeagueActivityReactionType;
  emoji: string;
  label: string;
  groupIndex?: number;
}

export interface LeagueEmojiCatalog {
  version: string;
  groups: readonly string[];
  options: readonly LeagueActivityReactionOption[];
}

let emojiCatalogPromise: Promise<LeagueEmojiCatalog> | null = null;

export function loadLeagueEmojiCatalog(): Promise<LeagueEmojiCatalog> {
  emojiCatalogPromise ??= import('./league-emoji-catalog.generated').then((catalog) => ({
    version: catalog.LEAGUE_EMOJI_CATALOG_VERSION,
    groups: catalog.LEAGUE_EMOJI_GROUPS,
    options: catalog.LEAGUE_EMOJI_CATALOG.map(([emoji, label, groupIndex]) => ({
      reactionType: emoji,
      emoji,
      label,
      groupIndex,
    })),
  }));

  return emojiCatalogPromise;
}

export function reactionOptionFromType(
  reactionType: LeagueActivityReactionType,
  label?: string,
): LeagueActivityReactionOption {
  return {
    reactionType,
    emoji: reactionType,
    label: label || leagueActivityReactionLabel(reactionType),
  };
}

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
  const reactionType = input.reactionType === null
    ? null
    : normalizeLeagueActivityReactionType(input.reactionType);

  if (!leagueId || !activityId || (input.reactionType !== null && !reactionType)) {
    throw new Error('Choose a valid League Wire reaction.');
  }

  try {
    const response = await setLeagueActivityReactionCallable({
      leagueId,
      activityId,
      reactionType,
    });
    return response.data;
  } catch (error) {
    throw new Error(callableMessage(error, 'Unable to update that reaction right now.'));
  }
}
