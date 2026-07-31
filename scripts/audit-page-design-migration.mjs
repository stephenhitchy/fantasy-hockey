import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const colorPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g;

const templates = new Map([
  ['src/app/features/dashboard/dashboard.html', [
    'rr-card', 'rr-button', 'rr-notice', 'rr-badge', 'rr-section-heading',
  ]],
  ['src/app/features/account/account-settings/account-settings.html', [
    'rr-card', 'rr-stat-grid', 'rr-choice-card', 'rr-field-group', 'rr-field',
    'rr-select', 'rr-action-tile', 'rr-danger-zone',
  ]],
  ['src/app/features/leagues/league-detail/league-detail.html', [
    'rr-card', 'rr-stat-grid', 'rr-action-tile', 'rr-notice', 'rr-field',
    'rr-button--danger', 'rr-danger-zone',
  ]],
]);

const styles = [
  ['src/app/features/dashboard/dashboard.css', 29, 2, '--rr-dashboard-migration-color-'],
  ['src/app/features/leagues/league-detail/league-detail.css', 140, 8, '--rr-league-hq-migration-color-'],
  ['src/app/features/account/account-settings/account-settings.css', 111, 0, '--rr-account-migration-color-'],
];

let failed = false;
console.log('RinkRat Batch 7C.2 page design migration audit');

for (const [relativePath, markers] of templates) {
  const html = await readFile(path.join(root, relativePath), 'utf8');
  const missing = markers.filter((marker) => !html.includes(marker));
  const okay = missing.length === 0;
  console.log(`  ${okay ? '✓' : '✗'} ${relativePath}: ${okay ? 'shared primitives composed' : `missing ${missing.join(', ')}`}`);
  if (!okay) failed = true;
}

for (const [relativePath, colorBudget, importantBudget, aliasMarker] of styles) {
  const css = await readFile(path.join(root, relativePath), 'utf8');
  const colorCount = css.match(colorPattern)?.length ?? 0;
  const importantCount = css.match(/!important\b/g)?.length ?? 0;
  const aliasesPresent = css.includes(aliasMarker);
  const okay = colorCount <= colorBudget && importantCount <= importantBudget && aliasesPresent;
  console.log(
    `  ${okay ? '✓' : '✗'} ${relativePath}: ${colorCount}/${colorBudget} literal colors, ${importantCount}/${importantBudget} important overrides, aliases ${aliasesPresent ? 'present' : 'missing'}`,
  );
  if (!okay) failed = true;
}

const primitives = await readFile(path.join(root, 'src/rinkrat-shared-primitives.css'), 'utf8');
const requiredPrimitiveMarkers = [
  '.rr-card--interactive', '.rr-section-heading', '.rr-stat-grid', '.rr-stat-card',
  '.rr-action-tile', '.rr-choice-card', '.rr-danger-zone',
];
const missingPrimitives = requiredPrimitiveMarkers.filter((marker) => !primitives.includes(marker));
const primitiveColors = primitives.match(colorPattern)?.length ?? 0;
const primitiveImportant = primitives.match(/!important\b/g)?.length ?? 0;
const primitivesOkay = missingPrimitives.length === 0 && primitiveColors === 0 && primitiveImportant === 0;
console.log(
  `  ${primitivesOkay ? '✓' : '✗'} shared page primitives: ${missingPrimitives.length} missing, ${primitiveColors} literal colors, ${primitiveImportant} important overrides`,
);
if (!primitivesOkay) failed = true;

if (failed) {
  process.exitCode = 1;
} else {
  console.log('✓ Dashboard, League HQ, and Account Settings compose the shared design system');
}
