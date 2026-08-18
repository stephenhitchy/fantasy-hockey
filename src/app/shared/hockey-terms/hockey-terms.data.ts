export type HockeyExperienceLevel = 'new' | 'basic' | 'experienced';

export interface HockeyExperienceOption {
  value: HockeyExperienceLevel;
  title: string;
  description: string;
}

export type HockeyTermKey =
  | 'left-wing'
  | 'center'
  | 'right-wing'
  | 'defenseman'
  | 'team-goalie-unit'
  | 'shots-on-goal'
  | 'blocked-shots'
  | 'power-play-points'
  | 'short-handed-points'
  | 'save-percentage'
  | 'time-on-ice'
  | 'game-winning-goal'
  | 'injured-reserve'
  | 'fantasy-points-per-game';

export interface HockeyTermDefinition {
  key: HockeyTermKey;
  abbreviation: string;
  label: string;
  beginnerExplanation: string;
}

export const DEFAULT_HOCKEY_EXPERIENCE_LEVEL: HockeyExperienceLevel = 'basic';

export const HOCKEY_EXPERIENCE_OPTIONS: HockeyExperienceOption[] = [
  {
    value: 'new',
    title: 'New to hockey',
    description: 'Show fuller labels and extra page guidance.',
  },
  {
    value: 'basic',
    title: 'I know the basics',
    description: 'Keep pages concise with definitions and Coach Help one tap away.',
  },
  {
    value: 'experienced',
    title: 'Experienced fan',
    description: 'Use compact labels and hide most optional helper copy.',
  },
];

const HOCKEY_TERMS: Record<HockeyTermKey, HockeyTermDefinition> = {
  'left-wing': {
    key: 'left-wing',
    abbreviation: 'LW',
    label: 'Left Wing',
    beginnerExplanation:
      'A forward who usually attacks from the left side of the ice. RinkRat has three active left-wing spots.',
  },
  center: {
    key: 'center',
    abbreviation: 'C',
    label: 'Center',
    beginnerExplanation:
      'A forward who commonly takes faceoffs and supports play through the middle. RinkRat has three active center spots.',
  },
  'right-wing': {
    key: 'right-wing',
    abbreviation: 'RW',
    label: 'Right Wing',
    beginnerExplanation:
      'A forward who usually attacks from the right side of the ice. RinkRat has three active right-wing spots.',
  },
  defenseman: {
    key: 'defenseman',
    abbreviation: 'D',
    label: 'Defenseman',
    beginnerExplanation:
      'A skater who protects the defensive end and helps move the puck up ice. RinkRat rewards defensemen for several steady categories.',
  },
  'team-goalie-unit': {
    key: 'team-goalie-unit',
    abbreviation: 'G',
    label: 'Team Goalie Unit',
    beginnerExplanation:
      'This roster spot follows one NHL team, not one individual goalie. Every goalie appearance for that team is combined for the game.',
  },
  'shots-on-goal': {
    key: 'shots-on-goal',
    abbreviation: 'SOG',
    label: 'Shots on Goal',
    beginnerExplanation:
      'A shot that would enter the net unless the goalie stops it. Missed shots and shots blocked before reaching the goalie do not count.',
  },
  'blocked-shots': {
    key: 'blocked-shots',
    abbreviation: 'BLK',
    label: 'Blocked Shots',
    beginnerExplanation:
      'A player stops an opponent’s shot before it reaches the goal. This helps defensemen score more consistently in RinkRat.',
  },
  'power-play-points': {
    key: 'power-play-points',
    abbreviation: 'PPP',
    label: 'Power-Play Points',
    beginnerExplanation:
      'A goal or assist recorded while the player’s NHL team has more skaters on the ice because the opponent took a penalty.',
  },
  'short-handed-points': {
    key: 'short-handed-points',
    abbreviation: 'SHP',
    label: 'Short-Handed Points',
    beginnerExplanation:
      'A goal or assist recorded while the player’s NHL team has fewer skaters on the ice because it is serving a penalty.',
  },
  'save-percentage': {
    key: 'save-percentage',
    abbreviation: 'SV%',
    label: 'Save Percentage',
    beginnerExplanation:
      'The share of shots on goal stopped by the goalie unit. For example, stopping 27 of 30 shots is a .900 save percentage.',
  },
  'time-on-ice': {
    key: 'time-on-ice',
    abbreviation: 'TOI',
    label: 'Time on Ice',
    beginnerExplanation:
      'The number of minutes a skater plays in an NHL game. RinkRat uses it as a small scoring category, especially for defensemen.',
  },
  'game-winning-goal': {
    key: 'game-winning-goal',
    abbreviation: 'GWG',
    label: 'Game-Winning Goal',
    beginnerExplanation:
      'The goal that leaves the winning team one goal ahead after every later goal is counted.',
  },
  'injured-reserve': {
    key: 'injured-reserve',
    abbreviation: 'IR',
    label: 'Injured Reserve',
    beginnerExplanation:
      'A protected roster area for eligible injured players. Players on injured reserve remain owned but do not score while inactive.',
  },
  'fantasy-points-per-game': {
    key: 'fantasy-points-per-game',
    abbreviation: 'Pts/Game',
    label: 'Fantasy Points per Game',
    beginnerExplanation:
      'The player’s average RinkRat fantasy score for each counted NHL game. It is not the same as an NHL power-play goal abbreviation.',
  },
};

const HOCKEY_EXPERIENCE_STORAGE_KEY = 'rinkrat-hockey-experience';

export function normalizeHockeyExperienceLevel(
  value: unknown,
): HockeyExperienceLevel {
  return value === 'new' || value === 'experienced'
    ? value
    : DEFAULT_HOCKEY_EXPERIENCE_LEVEL;
}

export function storeHockeyExperienceLevel(
  value: unknown,
  options: { persist?: boolean } = {},
): HockeyExperienceLevel {
  const normalized = normalizeHockeyExperienceLevel(value);

  if (options.persist !== false && typeof localStorage !== 'undefined') {
    localStorage.setItem(HOCKEY_EXPERIENCE_STORAGE_KEY, normalized);
  }

  if (typeof document !== 'undefined') {
    document.documentElement.dataset['hockeyExperience'] = normalized;
  }

  return normalized;
}

export function loadStoredHockeyExperienceLevel(): HockeyExperienceLevel {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_HOCKEY_EXPERIENCE_LEVEL;
  }

  return normalizeHockeyExperienceLevel(
    localStorage.getItem(HOCKEY_EXPERIENCE_STORAGE_KEY),
  );
}

export function getHockeyTermDefinition(key: HockeyTermKey): HockeyTermDefinition {
  return HOCKEY_TERMS[key];
}

export function getHockeyTermDisplayLabel(
  key: HockeyTermKey,
  experience: HockeyExperienceLevel,
  compact = false,
): string {
  const term = getHockeyTermDefinition(key);

  if (compact || experience !== 'new') {
    return term.abbreviation;
  }

  return `${term.label} (${term.abbreviation})`;
}

export const HOCKEY_GLOSSARY_TERMS: HockeyTermDefinition[] = Object.values(HOCKEY_TERMS);
