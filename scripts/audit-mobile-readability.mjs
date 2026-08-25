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

const [
  tokens,
  navbarSource,
  navbarTemplate,
  navbarCss,
  layoutCss,
  dashboardCss,
  leagueCss,
  draftCss,
  gameCenterCss,
  teamCss,
  freeAgentsCss,
] = await Promise.all([
  read('src/rinkrat-design-tokens.css'),
  read('src/app/shared/navbar/navbar.ts'),
  read('src/app/shared/navbar/navbar.html'),
  read('src/app/shared/navbar/navbar.css'),
  read('src/app/layouts/main-layout/main-layout.css'),
  read('src/app/features/dashboard/dashboard.css'),
  read('src/app/features/leagues/league-detail/league-detail.css'),
  read('src/app/features/draft/draft-room/draft-room.css'),
  read('src/app/features/cycles/cycle-one/cycle-one.css'),
  read('src/app/features/team/team-settings/team-settings.css'),
  read('src/app/features/free-agents/free-agents.css'),
]);

requireMatch(
  tokens,
  /--rr-mobile-text-micro:\s*var\(--rr-text-xs\)/,
  'Shared 12px mobile microcopy token is missing.',
);
requireMatch(
  tokens,
  /--rr-mobile-control-min-height:\s*var\(--rr-touch-target\)/,
  'Shared mobile control-height token is missing.',
);
requireMatch(
  navbarSource,
  /listenToAuthState/,
  'Navbar is not following authentication state.',
);
requireMatch(
  navbarSource,
  /NavigationEnd/,
  'Navbar is not following route changes for active-link state.',
);
forbidMatch(
  navbarSource,
  /listenToFantasyDraft|listenToEarliestUnfinishedOwnerMatchup|getRememberedLastLeagueId/,
  'Global navigation still opens league, Draft, or matchup listeners.',
);
for (const [label, expression] of [
  ['Dashboard', /routerLink="\/dashboard"[\s\S]*?<span>Dashboard<\/span>/],
  ['Create', /routerLink="\/leagues\/create"[\s\S]*?<span>Create<\/span>/],
  ['Join', /routerLink="\/leagues\/join"[\s\S]*?<span>Join<\/span>/],
  ['Scoring', /routerLink="\/scoring"[\s\S]*?<span>Scoring<\/span>/],
]) {
  requireMatch(
    navbarTemplate,
    expression,
    `Mobile ${label} destination is missing from the durable global navigation.`,
  );
}
requireMatch(
  navbarTemplate,
  /<strong>Support<\/strong>/,
  'Support is not preserved in the mobile More menu.',
);
requireMatch(
  navbarTemplate,
  /<strong>Account<\/strong>/,
  'Account is not preserved in the mobile More menu.',
);
forbidMatch(
  navbarTemplate,
  /mobileLeaguePrimary|<strong>League HQ<\/strong>/,
  'Mobile global navigation still contains the retired phase-aware league destination.',
);
requireMatch(
  navbarCss,
  /--rr-nav-item-font-size:\s*var\(--rr-mobile-text-micro\)/,
  'Mobile bottom navigation is not using the shared readable label size.',
);
requireMatch(
  layoutCss,
  /Batch M1: quieter decorative ribbon on narrow phones/,
  'Narrow-phone decorative ribbon reduction is missing.',
);

const surfaces = [
  ['Dashboard', dashboardCss],
  ['League HQ', leagueCss],
  ['Draft Room', draftCss],
  ['Game Center', gameCenterCss],
  ['My Team', teamCss],
  ['Free Agents', freeAgentsCss],
];

for (const [name, source] of surfaces) {
  requireMatch(
    source,
    /--rr-mobile-text-(?:micro|label|player|score)/,
    `${name} is not using the shared mobile type scale.`,
  );
}

for (const [name, source] of [
  ['League HQ', leagueCss],
  ['Draft Room', draftCss],
  ['Game Center', gameCenterCss],
  ['My Team', teamCss],
  ['Free Agents', freeAgentsCss],
]) {
  requireMatch(
    source,
    /min-height:\s*var\(--rr-mobile-control-min-height\)/,
    `${name} is missing shared 44px frequent-action targets.`,
  );
}

const tinyBottomNavLabel = /\.mobile-bottom-nav[\s\S]{0,500}font-size:\s*(?:9|10)px/;
if (tinyBottomNavLabel.test(navbarCss)) {
  failures.push('Mobile bottom navigation still contains a 9px or 10px label override.');
}

console.log('RinkRat Batch M1 mobile audit');
console.log(`  League-independent global navigation: ${!/listenToFantasyDraft|listenToEarliestUnfinishedOwnerMatchup|getRememberedLastLeagueId/.test(navbarSource) ? 'yes' : 'no'}`);
console.log(`  Shared 12px mobile floor: ${/--rr-mobile-text-micro:\s*var\(--rr-text-xs\)/.test(tokens) ? 'yes' : 'no'}`);
console.log(`  Shared 44px action target: ${/--rr-mobile-control-min-height:\s*var\(--rr-touch-target\)/.test(tokens) ? 'yes' : 'no'}`);
console.log(`  Primary surfaces covered: ${surfaces.filter(([, source]) => /--rr-mobile-text-(?:micro|label|player|score)/.test(source)).length}/${surfaces.length}`);
console.log(`  Narrow-phone decoration reduction: ${/Batch M1: quieter decorative ribbon/.test(layoutCss) ? 'yes' : 'no'}`);

if (failures.length > 0) {
  console.error('\nMobile readability audit failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('  ✓ Mobile readability and durable-navigation checks passed.');
}
