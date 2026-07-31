import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const colorPattern = /(?<![\w-])(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\))/g;

const tokenOnlyStyles = [
  'src/app/shared/navbar/navbar.css',
  'src/app/features/leagues/join-league/join-league.css',
  'src/app/features/support/support-home/support-home.css',
  'src/app/features/support/feedback/feedback.css',
  'src/app/features/errors/access-denied/access-denied.css',
  'src/app/features/legal/legal-page.css',
];

const requiredTemplateMarkers = new Map([
  ['src/app/shared/navbar/navbar.html', ['rr-nav-item', 'rr-nav-item--stacked']],
  ['src/app/features/leagues/create-league/create-league.html', ['rr-pixel-shell-page', 'rr-pixel-shell-form', 'rr-pixel-shell-submit', 'rr-pixel-shell-error']],
  ['src/app/features/leagues/join-league/join-league.html', ['rr-pixel-shell-page', 'rr-pixel-shell-mini-ref', 'rr-pixel-shell-submit', 'rr-pixel-shell-error']],
  ['src/app/features/support/feedback/feedback.html', ['rr-card', 'rr-select', 'rr-textarea', 'rr-button', 'rr-notice']],
  ['src/app/features/support/support-home/support-home.html', ['rr-card', 'rr-card--padded']],
  ['src/app/features/errors/access-denied/access-denied.html', ['rr-card', 'rr-card--padded']],
  ['src/app/features/legal/privacy/privacy.html', ['rr-card', 'rr-card--padded']],
  ['src/app/features/legal/terms/terms.html', ['rr-card', 'rr-card--padded']],
]);

let failed = false;
console.log('RinkRat shared UI migration audit');

for (const relativePath of tokenOnlyStyles) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const literalColors = source.match(colorPattern) ?? [];
  const importantCount = source.match(/!important\b/g)?.length ?? 0;
  const okay = literalColors.length === 0 && importantCount === 0;
  console.log(`  ${okay ? '✓' : '✗'} ${relativePath}: ${literalColors.length} literal colors, ${importantCount} important overrides`);
  if (!okay) failed = true;
}

for (const [relativePath, markers] of requiredTemplateMarkers) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const missing = markers.filter((marker) => !source.includes(marker));
  const okay = missing.length === 0;
  console.log(`  ${okay ? '✓' : '✗'} ${relativePath}: ${okay ? 'reviewed primitives present' : `missing ${missing.join(', ')}`}`);
  if (!okay) failed = true;
}

const joinCss = await readFile(
  path.join(root, 'src/app/features/leagues/join-league/join-league.css'),
  'utf8',
);
const duplicatedJoinSelectors = [
  '.pixel-shell-page',
  '.shell-copy',
  '.shell-card',
  '.form-field',
  '.primary-submit',
  '.status-message',
  '.mini-ref',
].filter((selector) => joinCss.includes(selector));
const joinOkay = duplicatedJoinSelectors.length === 0;
console.log(
  `  ${joinOkay ? '✓' : '✗'} join-league.css common shell duplication: ${joinOkay ? 'removed' : duplicatedJoinSelectors.join(', ')}`,
);
if (!joinOkay) failed = true;

if (failed) {
  process.exitCode = 1;
} else {
  console.log('✓ Shared navigation, shell, card, form, button, and notice migration checks passed');
}
