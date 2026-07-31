import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const colorPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g;

const templates = new Map([
  ['src/app/features/team/team-settings/team-settings.html', [
    'rr-page-shell', 'rr-stat-grid', 'rr-list-row', 'rr-data-panel', 'rr-dialog',
  ]],
  ['src/app/features/free-agents/free-agents.html', [
    'rr-page-shell', 'rr-toolbar', 'rr-list-row', 'rr-choice-card', 'rr-notice',
  ]],
  ['src/app/features/draft/draft-setup/draft-setup.html', [
    'rr-page-shell', 'rr-stat-grid', 'rr-field', 'rr-select', 'rr-list-row',
  ]],
  ['src/app/features/draft/draft-room/draft-room.html', [
    'rr-page-shell', 'rr-toolbar', 'rr-choice-card', 'rr-list-row', 'rr-card',
  ]],
  ['src/app/features/cycles/cycle-one/cycle-one.html', [
    'rr-page-shell', 'rr-card', 'rr-data-panel', 'rr-button', 'rr-state',
  ]],
]);

const styles = [
  ['src/app/features/team/team-settings/team-settings.css', 224, 4, '--rr-team-migration-color-'],
  ['src/app/features/free-agents/free-agents.css', 168, 8, '--rr-free-agents-migration-color-'],
  ['src/app/features/draft/draft-setup/draft-setup.css', 91, 0, '--rr-draft-setup-migration-color-'],
  ['src/app/features/draft/draft-room/draft-room.css', 189, 1, '--rr-draft-room-migration-color-'],
  ['src/app/features/cycles/cycle-one/cycle-one.css', 392, 1, null],
];

let failed = false;
console.log('RinkRat Batch 7C.3 competition surface migration audit');

for (const [relativePath, markers] of templates) {
  const html = await readFile(path.join(root, relativePath), 'utf8');
  const missing = markers.filter((marker) => !html.includes(marker));
  const okay = missing.length === 0;
  console.log(`  ${okay ? '✓' : '✗'} ${relativePath}: ${okay ? 'shared primitives composed' : `missing ${missing.join(', ')}`}`);
  failed ||= !okay;
}

for (const [relativePath, colorBudget, importantBudget, aliasMarker] of styles) {
  const css = await readFile(path.join(root, relativePath), 'utf8');
  const colorCount = css.match(colorPattern)?.length ?? 0;
  const importantCount = css.match(/!important\b/g)?.length ?? 0;
  const aliasesPresent = aliasMarker ? css.includes(aliasMarker) : !css.includes('--rr-game-center-migration-color-');
  const okay = colorCount <= colorBudget && importantCount <= importantBudget && aliasesPresent;
  const paletteMode = aliasMarker ? `aliases ${aliasesPresent ? 'present' : 'missing'}` : `budget-safe local palette ${aliasesPresent ? 'preserved' : 'unexpected aliases found'}`;
  console.log(
    `  ${okay ? '✓' : '✗'} ${relativePath}: ${colorCount}/${colorBudget} literal colors, ${importantCount}/${importantBudget} important overrides, ${paletteMode}`,
  );
  failed ||= !okay;
}

const primitives = await readFile(path.join(root, 'src/rinkrat-shared-primitives.css'), 'utf8');
const required = ['.rr-toolbar', '.rr-list-row', '.rr-data-panel', '.rr-dialog-backdrop', '.rr-dialog', '.rr-score-number'];
const missing = required.filter((marker) => !primitives.includes(marker));
const primitiveColors = primitives.match(colorPattern)?.length ?? 0;
const primitiveImportant = primitives.match(/!important\b/g)?.length ?? 0;
const primitivesOkay = missing.length === 0 && primitiveColors === 0 && primitiveImportant === 0;
console.log(`  ${primitivesOkay ? '✓' : '✗'} competition primitives: ${missing.length} missing, ${primitiveColors} literal colors, ${primitiveImportant} important overrides`);
failed ||= !primitivesOkay;

const teamPanel = await readFile(path.join(root, 'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'), 'utf8');
const progressOkay = teamPanel.includes('team-roster-progress-track rr-progress') && teamPanel.includes('team-roster-progress-fill rr-progress__value');
console.log(`  ${progressOkay ? '✓' : '✗'} Game Center roster progress composes the shared semantic progress primitive`);
failed ||= !progressOkay;

if (failed) {
  process.exitCode = 1;
} else {
  console.log('✓ My Team, Free Agents, Draft, and Game Center compose the shared design system');
}
