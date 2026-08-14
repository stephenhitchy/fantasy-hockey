import { type LeagueActivityReactionType } from './league-activity.models';

export const LEAGUE_ACTIVITY_REACTION_MAX_BYTES = 64;

export type LeagueActivityQuickReactionId =
  | 'rr_stick_tap'
  | 'rr_on_fire'
  | 'rr_no_way'
  | 'rr_rink_rat'
  | 'rr_laugh';

export interface LeagueActivityQuickReactionOption {
  reactionType: LeagueActivityQuickReactionId;
  label: string;
  assetPath: string;
}

export const LEAGUE_ACTIVITY_QUICK_REACTIONS = [
  {
    reactionType: 'rr_stick_tap',
    label: 'Stick tap',
    assetPath: 'assets/reactions/stick-tap.svg',
  },
  {
    reactionType: 'rr_on_fire',
    label: 'On fire',
    assetPath: 'assets/reactions/on-fire.svg',
  },
  {
    reactionType: 'rr_no_way',
    label: 'No way',
    assetPath: 'assets/reactions/no-way.svg',
  },
  {
    reactionType: 'rr_rink_rat',
    label: 'Rink Rat',
    assetPath: 'assets/reactions/rink-rat.svg',
  },
  {
    reactionType: 'rr_laugh',
    label: 'Laughing',
    assetPath: 'assets/reactions/laugh.svg',
  },
] as const satisfies readonly LeagueActivityQuickReactionOption[];

const QUICK_REACTION_TYPE_SET = new Set<string>(
  LEAGUE_ACTIVITY_QUICK_REACTIONS.map((option) => option.reactionType),
);

const LEGACY_REACTION_TYPE_MAP: Readonly<Record<string, string>> = {
  'stick-tap': 'rr_stick_tap',
  fire: 'rr_on_fire',
  wow: 'rr_no_way',
  'rink-rat': 'rr_rink_rat',
  '🏒': 'rr_stick_tap',
  '🔥': 'rr_on_fire',
  '😮': 'rr_no_way',
  '🐀': 'rr_rink_rat',
  '😂': 'rr_laugh',
};

const QUICK_REACTION_BY_TYPE = new Map<string, LeagueActivityQuickReactionOption>(
  LEAGUE_ACTIVITY_QUICK_REACTIONS.map((option) => [option.reactionType, option]),
);

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

  const normalized = (LEGACY_REACTION_TYPE_MAP[value] ?? value).normalize('NFC');
  const byteLength = new TextEncoder().encode(normalized).length;

  if (
    !normalized ||
    byteLength > LEAGUE_ACTIVITY_REACTION_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }

  if (QUICK_REACTION_TYPE_SET.has(normalized)) {
    return normalized;
  }

  const rgiPattern = getRgiEmojiPattern();
  return (rgiPattern ? rgiPattern.test(normalized) : resemblesEmojiSequence(normalized))
    ? normalized
    : null;
}

export function isLeagueActivityQuickReaction(
  reactionType: LeagueActivityReactionType,
): reactionType is LeagueActivityQuickReactionId {
  return QUICK_REACTION_TYPE_SET.has(reactionType);
}

export function quickReactionOption(
  reactionType: LeagueActivityReactionType,
): LeagueActivityQuickReactionOption | null {
  return QUICK_REACTION_BY_TYPE.get(reactionType) ?? null;
}

export function leagueActivityReactionLabel(
  reactionType: LeagueActivityReactionType,
): string {
  return QUICK_REACTION_BY_TYPE.get(reactionType)?.label ?? `Emoji ${reactionType}`;
}
