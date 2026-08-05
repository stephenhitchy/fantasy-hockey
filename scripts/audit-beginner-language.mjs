import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');
const failures = [];

function requireMatch(source, expression, message) {
  if (!expression.test(source)) {
    failures.push(message);
  }
}

function forbidMatch(source, expression, message) {
  if (expression.test(source)) {
    failures.push(message);
  }
}

const templatePaths = [
  'src/app/features/auth/auth.html',
  'src/app/features/dashboard/dashboard.html',
  'src/app/features/account/account-settings/account-settings.html',
  'src/app/features/onboarding/training-camp/training-camp.html',
  'src/app/features/scoring/scoring-guide/scoring-guide.html',
  'src/app/features/draft/draft-setup/draft-setup.html',
  'src/app/features/draft/draft-room/draft-room.html',
  'src/app/features/free-agents/free-agents.html',
  'src/app/features/leagues/join-league/join-league.html',
  'src/app/features/leagues/league-detail/league-detail.html',
  'src/app/features/leagues/league-standings/league-standings.html',
  'src/app/features/cycles/cycle-one/cycle-one.html',
  'src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.html',
  'src/app/features/cycles/cycle-one/components/cycle-page-header/cycle-page-header.html',
  'src/app/features/cycles/cycle-one/components/cycle-matchup-toolbar/cycle-matchup-toolbar.html',
  'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html',
  'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
  'src/app/features/cycles/matchup-overview/cycle-matchup-overview.html',
  'src/app/features/cycles/schedule-preview/cycle-schedule-preview.html',
  'src/app/features/team/team-settings/team-settings.html',
  'src/app/features/leaders/point-leaders/point-leaders.html',
  'src/app/features/playoffs/playoff-bracket/playoff-bracket.html',
  'src/app/features/projections/projection-lab/projection-lab.html',
  'src/app/features/players/player-detail/player-detail.html',
  'src/app/features/support/support-home/support-home.html',
  'src/app/shared/coach-help/coach-help.html',
  'src/app/shared/navbar/navbar.html',
  'src/app/shared/roster-board/roster-board.html',
];

const [
  templates,
  themeSource,
  authSource,
  authTemplate,
  authService,
  accountSource,
  userService,
  userThemeService,
  glossarySource,
  glossaryChipSource,
  glossaryChipTemplate,
  trainingSource,
  scoringSource,
  coachSource,
  rules,
  functionsIndex,
  teamSettings,
  freeAgents,
] = await Promise.all([
  Promise.all(templatePaths.map(read)).then((sources) => sources.join('\n')),
  read('src/app/shared/pixel-theme/pixel-theme.data.ts'),
  read('src/app/features/auth/auth.ts'),
  read('src/app/features/auth/auth.html'),
  read('src/app/core/auth/auth.service.ts'),
  read('src/app/features/account/account-settings/account-settings.ts'),
  read('src/app/core/user/user.service.ts'),
  read('src/app/core/user/user-theme.service.ts'),
  read('src/app/shared/hockey-terms/hockey-terms.data.ts'),
  read('src/app/shared/hockey-terms/hockey-term-chip.ts'),
  read('src/app/shared/hockey-terms/hockey-term-chip.html'),
  read('src/app/features/onboarding/training-camp/training-camp.ts'),
  read('src/app/features/scoring/scoring-guide/scoring-guide.ts'),
  read('src/app/shared/coach-help/coach-help.ts'),
  read('firestore.rules'),
  read('functions/src/index.ts'),
  read('src/app/features/team/team-settings/team-settings.ts'),
  read('src/app/features/free-agents/free-agents.ts'),
]);

requireMatch(
  themeSource,
  /RINKRAT_NEUTRAL_ABBREVIATION\s*=\s*'RR'/,
  'Neutral RR identity constant is missing.',
);
requireMatch(
  themeSource,
  /USER_SELECTABLE_PIXEL_THEMES[\s\S]*RINKRAT_NEUTRAL_THEME/,
  'Neutral identity is not part of the selectable account themes.',
);
requireMatch(
  authSource,
  /signal\(RINKRAT_NEUTRAL_ABBREVIATION\)/,
  'Registration does not default to neutral RinkRat colors.',
);
requireMatch(
  authTemplate,
  /Optional · You can choose or change this later/,
  'Favorite-team choice is not explained as optional.',
);
forbidMatch(
  authSource,
  /Choose your favorite NHL team to finish creating your profile/,
  'Registration still requires an NHL favorite.',
);
requireMatch(
  authService,
  /hockeyExperience: HockeyExperienceLevel/,
  'Registration is not accepting the hockey-familiarity preference.',
);
requireMatch(
  accountSource,
  /hockeyExperience: this\.hockeyExperience/,
  'Account settings are not saving hockey familiarity.',
);
requireMatch(
  userService,
  /hockeyExperience\?: HockeyExperienceLevel/,
  'Private user profiles do not include the optional familiarity field.',
);
requireMatch(
  userThemeService,
  /storeHockeyExperienceLevel/,
  'The local UI preference is not being synchronized.',
);

for (const abbreviation of [
  'LW',
  'C',
  'RW',
  'D',
  'G',
  'SOG',
  'BLK',
  'PPP',
  'SHP',
  'SV%',
  'TOI',
  'GWG',
  'IR',
  'Pts/Game',
]) {
  requireMatch(
    glossarySource,
    new RegExp(`abbreviation:\\s*['\"]${abbreviation.replace('%', '\\%').replace('/', '\\/')}['\"]`),
    `Glossary definition for ${abbreviation} is missing.`,
  );
}
requireMatch(
  glossaryChipTemplate,
  /aria-expanded/,
  'Glossary term controls do not expose their open state.',
);
requireMatch(
  glossaryChipTemplate,
  /role="region"[\s\S]*aria-labelledby/,
  'Glossary definitions are not exposed as labelled popovers.',
);
requireMatch(
  glossaryChipSource,
  /HostListener\('document:keydown\.escape'\)/,
  'Glossary popovers cannot be closed with Escape.',
);
requireMatch(trainingSource, /HockeyTermChip/, 'Training Camp is missing contextual term definitions.');
requireMatch(scoringSource, /HockeyTermChip/, 'Scoring Guide is missing contextual term definitions.');
requireMatch(coachSource, /HOCKEY_GLOSSARY_TERMS/, 'Coach Help is missing the complete glossary.');

const forbiddenManagerPhrases = [
  [/Available Assets/i, 'Available Assets'],
  [/Active asset/i, 'Active asset'],
  [/Current asset/i, 'Current asset'],
  [/Incoming asset/i, 'Incoming asset'],
  [/Asset window/i, 'Asset window'],
  [/Cycle total/i, 'Cycle total'],
  [/Next[- ]cycle projection/i, 'Next-cycle projection'],
  [/Cycle boundary/i, 'Cycle boundary'],
  [/Current Cycle/i, 'Current Cycle'],
  [/Cycle Matchups/i, 'Cycle Matchups'],
  [/Games Per Cycle/i, 'Games Per Cycle'],
  [/Window Progress/i, 'Window Progress'],
  [/Bench assets/i, 'Bench assets'],
  [/queued move/i, 'queued move'],
  [/six-game windows/i, 'six-game windows'],
];

for (const [expression, label] of forbiddenManagerPhrases) {
  forbidMatch(templates, expression, `Primary manager templates still display “${label}”.`);
}

requireMatch(templates, /Next 6 Games/, 'Primary templates do not use the beginner-facing Next 6 Games label.');
requireMatch(templates, /The Six-Game Tape/, 'Game Film does not explain the six-game assignment clearly.');
requireMatch(templates, /Injured Reserve \(IR\)/, 'Injured Reserve is not expanded before its abbreviation.');
requireMatch(templates, /No favorite yet/, 'Neutral onboarding choice is not visible.');

requireMatch(rules, /validHockeyExperience/, 'Firestore rules do not validate hockey familiarity.');
requireMatch(rules, /\['new', 'basic', 'experienced'\]/, 'Firestore rules do not restrict familiarity values.');
requireMatch(rules, /'RR'/, 'Firestore rules do not allow the neutral RR identity.');
requireMatch(functionsIndex, /PUBLIC_PROFILE_TEAM_ABBREVIATIONS[\s\S]*?'RR'/, 'Functions do not allow RR in public profiles.');
requireMatch(functionsIndex, /:\s*'RR',/, 'Functions do not fall back to RR for invalid public identities.');

// Internal names remain intentionally stable to avoid a risky migration.
requireMatch(teamSettings, /effectiveLabel:\s*`Cycle \$\{effectiveCycleNumber\}`/, 'Existing transaction cycle labels were unexpectedly migrated.');
requireMatch(freeAgents, /const effectiveLabel = `Cycle \$\{effectiveCycleNumber\}`/, 'Existing free-agent transaction cycle labels were unexpectedly migrated.');

console.log('RinkRat Batch M2 beginner-language audit');
console.log(`  Neutral identity available: ${/RINKRAT_NEUTRAL_ABBREVIATION\s*=\s*'RR'/.test(themeSource) ? 'yes' : 'no'}`);
console.log(`  Familiarity preference persisted: ${/hockeyExperience: this\.hockeyExperience/.test(accountSource) ? 'yes' : 'no'}`);
console.log(`  Glossary abbreviations covered: ${['LW','C','RW','D','G','SOG','BLK','PPP','SHP','SV%','TOI','GWG','IR','Pts/Game'].filter((value) => glossarySource.includes(`abbreviation: '${value}'`)).length}/14`);
console.log(`  Primary templates checked: ${templatePaths.length}`);
console.log(`  Internal cycle schema retained: ${/effectiveLabel:\s*`Cycle \$\{effectiveCycleNumber\}`/.test(teamSettings) ? 'yes' : 'no'}`);

if (failures.length > 0) {
  console.error('\nBeginner-language audit failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('  ✓ Neutral onboarding, glossary, and beginner-language checks passed.');
}
