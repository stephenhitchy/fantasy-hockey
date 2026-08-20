import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  COMPETITION_STYLE_EXPECTATIONS,
  COMPETITION_TEMPLATE_EXPECTATIONS,
} from './competition-design-migration.expectations.mjs';

const root = process.cwd();
const colorPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g;

let failed = false;
console.log('RinkRat current competition surface design audit');

for (const expectation of COMPETITION_TEMPLATE_EXPECTATIONS) {
  const html = await readFile(path.join(root, expectation.relativePath), 'utf8');
  const missing = expectation.requiredMarkers.filter((marker) => !html.includes(marker));
  const unexpected = expectation.forbiddenMarkers.filter((marker) => html.includes(marker));
  const okay = missing.length === 0 && unexpected.length === 0;
  const details = okay
    ? 'current reviewed composition preserved'
    : [
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        unexpected.length > 0 ? `unexpected ${unexpected.join(', ')}` : '',
      ].filter(Boolean).join('; ');

  console.log(`  ${okay ? '✓' : '✗'} ${expectation.label}: ${details}`);
  failed ||= !okay;
}

for (const expectation of COMPETITION_STYLE_EXPECTATIONS) {
  const css = await readFile(path.join(root, expectation.relativePath), 'utf8');
  const colorCount = css.match(colorPattern)?.length ?? 0;
  const importantCount = css.match(/!important\b/g)?.length ?? 0;
  const missing = expectation.requiredMarkers.filter((marker) => !css.includes(marker));
  const unexpected = expectation.forbiddenMarkers.filter((marker) => css.includes(marker));
  const okay =
    colorCount <= expectation.literalColorBudget &&
    importantCount <= expectation.importantBudget &&
    missing.length === 0 &&
    unexpected.length === 0;
  const paletteDetails = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    unexpected.length > 0 ? `unexpected ${unexpected.join(', ')}` : '',
  ].filter(Boolean).join('; ') || 'reviewed palette contract preserved';

  console.log(
    `  ${okay ? '✓' : '✗'} ${expectation.label} styles: ${colorCount}/${expectation.literalColorBudget} literal colors, ${importantCount}/${expectation.importantBudget} important overrides, ${paletteDetails}`,
  );
  failed ||= !okay;
}

const primitives = await readFile(
  path.join(root, 'src/rinkrat-shared-primitives.css'),
  'utf8',
);
const required = [
  '.rr-toolbar',
  '.rr-list-row',
  '.rr-data-panel',
  '.rr-dialog-backdrop',
  '.rr-dialog',
  '.rr-score-number',
];
const missing = required.filter((marker) => !primitives.includes(marker));
const primitiveColors = primitives.match(colorPattern)?.length ?? 0;
const primitiveImportant = primitives.match(/!important\b/g)?.length ?? 0;
const primitivesOkay = missing.length === 0 && primitiveColors === 0 && primitiveImportant === 0;
console.log(
  `  ${primitivesOkay ? '✓' : '✗'} competition primitives: ${missing.length} missing, ${primitiveColors} literal colors, ${primitiveImportant} important overrides`,
);
failed ||= !primitivesOkay;

const teamPanel = await readFile(
  path.join(
    root,
    'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
  ),
  'utf8',
);
const progressOkay =
  teamPanel.includes('team-roster-progress-track rr-progress') &&
  teamPanel.includes('team-roster-progress-fill rr-progress__value');
console.log(
  `  ${progressOkay ? '✓' : '✗'} Game Center roster progress composes the shared semantic progress primitive`,
);
failed ||= !progressOkay;

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    '✓ My Team, unified Add / Drop, Draft, and Game Center match the current reviewed design system',
  );
}
