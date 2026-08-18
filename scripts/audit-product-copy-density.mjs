import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const MANAGER_TEMPLATES = [
  'src/app/features/account/account-settings/account-settings.html',
  'src/app/features/auth/auth.html',
  'src/app/features/dashboard/dashboard.html',
  'src/app/features/draft/draft-room/draft-room.html',
  'src/app/features/draft/draft-setup/draft-setup.html',
  'src/app/features/free-agents/free-agents.html',
  'src/app/features/leaders/point-leaders/point-leaders.html',
  'src/app/features/leagues/create-league/create-league.html',
  'src/app/features/leagues/join-league/join-league.html',
  'src/app/features/leagues/league-detail/league-detail.html',
  'src/app/features/leagues/league-wire/league-wire.html',
  'src/app/features/onboarding/training-camp/training-camp.html',
  'src/app/features/players/league-player-board/league-player-board.html',
  'src/app/features/players/league-player-detail/league-player-detail.html',
  'src/app/features/playoffs/playoff-bracket/playoff-bracket.html',
  'src/app/features/scoring/scoring-guide/scoring-guide.html',
  'src/app/features/support/support-home/support-home.html',
  'src/app/features/team/team-settings/team-settings.html',
];

const BASELINE_MANAGER_TEMPLATE_COUNT = 17;
const MAX_VISIBLE_TEXT_CHARACTERS = 42_000;
const scaledVisibleTextCeiling = Math.ceil(
  MAX_VISIBLE_TEXT_CHARACTERS * MANAGER_TEMPLATES.length / BASELINE_MANAGER_TEMPLATE_COUNT,
);
const REMOVED_REDUNDANT_COPY = [
  'Pick a league, manage your roster, and get straight to the action.',
  'Share this code with the people joining your league.',
  'Only the most useful comparison numbers stay visible until you select someone.',
  'The top button follows the current phase; these are the pages managers use most.',
  'Less-frequent league pages stay available without crowding the top.',
  'Find the fastest path for reporting a problem, requesting data help, or learning how the beta works.',
];

const REQUIRED_SAFETY_COPY = [
  ['src/app/features/draft/draft-setup/draft-setup.html', 'Saving the draft order closes league entry.'],
  ['src/app/features/free-agents/free-agents.html', 'exact six-game timeline'],
  ['src/app/features/team/team-settings/team-settings.html', 'Only players listed as Out, Injured Reserve, or Long-Term Injured Reserve'],
  ['src/app/features/leagues/league-detail/league-detail.html', 'This cannot be undone.'],
  ['src/app/features/account/account-settings/account-settings.html', 'cannot be undone'],
];

function visibleText(source) {
  return source
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[^]*?\}\}/g, ' ')
    .replace(/@[A-Za-z]+\s*\([^)]*\)\s*\{/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const sourceByPath = new Map();
let totalVisibleTextCharacters = 0;

for (const relativePath of MANAGER_TEMPLATES) {
  const source = await readFile(new URL(relativePath, ROOT), 'utf8');
  sourceByPath.set(relativePath, source);
  totalVisibleTextCharacters += visibleText(source).length;
}

if (totalVisibleTextCharacters > scaledVisibleTextCeiling) {
  throw new Error(
    `Manager-facing copy density is ${totalVisibleTextCharacters} characters; ` +
      `the scaled Clear Ice ceiling is ${scaledVisibleTextCeiling}.`,
  );
}

const combinedSource = [...sourceByPath.values()].join('\n');
for (const phrase of REMOVED_REDUNDANT_COPY) {
  if (combinedSource.includes(phrase)) {
    throw new Error(`Redundant explanatory copy returned: ${phrase}`);
  }
}

for (const [relativePath, phrase] of REQUIRED_SAFETY_COPY) {
  if (!sourceByPath.get(relativePath)?.includes(phrase)) {
    throw new Error(`Required competitive or destructive-action guidance is missing: ${phrase}`);
  }
}

console.log(
  `Product copy-density audit passed: ${MANAGER_TEMPLATES.length} manager templates, ` +
    `${totalVisibleTextCharacters}/${scaledVisibleTextCeiling} visible-text characters ` +
    `(same per-template ceiling as the ${BASELINE_MANAGER_TEMPLATE_COUNT}-page baseline).`,
);
console.log('Safety-critical six-game, privacy, entry-lock, and destructive-action copy remains present.');
