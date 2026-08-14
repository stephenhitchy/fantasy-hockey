import { type LeagueActivityReactionType } from './league-activity.models';

export const LEAGUE_ACTIVITY_REACTION_MAX_BYTES = 64;

/**
 * C1G.4 keeps every deployed reaction readable while returning League Wire to
 * one canonical storage format: fully-qualified Unicode emoji strings.
 */
const LEGACY_REACTION_TYPE_TO_EMOJI: Readonly<Record<string, string>> = {
  'stick-tap': '🏒',
  fire: '🔥',
  wow: '😮',
  'rink-rat': '🐀',
  rr_stick_tap: '🏒',
  rr_on_fire: '🔥',
  rr_no_way: '😮',
  rr_rink_rat: '🐀',
  rr_laugh: '😂',
};

let rgiEmojiPattern: RegExp | null | undefined;

function getRgiEmojiPattern(): RegExp | null {
  if (rgiEmojiPattern !== undefined) {
    return rgiEmojiPattern;
  }

  try {
    rgiEmojiPattern = new RegExp('^(?:\\p{RGI_Emoji})$', 'v');
  } catch {
    rgiEmojiPattern = null;
  }

  return rgiEmojiPattern;
}

function resemblesEmojiSequence(value: string): boolean {
  // Compatibility fallback for browsers without the RGI_Emoji string
  // property. The callable remains authoritative through its generated set.
  return /\p{Extended_Pictographic}/u.test(value) ||
    /^(?:\p{Regional_Indicator}{2})$/u.test(value) ||
    /^(?:[#*0-9]\uFE0F?\u20E3)$/u.test(value);
}

export function normalizeLeagueActivityReactionType(
  value: unknown,
): LeagueActivityReactionType | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = (LEGACY_REACTION_TYPE_TO_EMOJI[value] ?? value).normalize('NFC');
  const byteLength = new TextEncoder().encode(normalized).length;

  if (
    !normalized ||
    byteLength > LEAGUE_ACTIVITY_REACTION_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }

  const rgiPattern = getRgiEmojiPattern();
  return (rgiPattern ? rgiPattern.test(normalized) : resemblesEmojiSequence(normalized))
    ? normalized
    : null;
}

export function leagueActivityReactionLabel(
  reactionType: LeagueActivityReactionType,
): string {
  return `Emoji ${reactionType}`;
}
