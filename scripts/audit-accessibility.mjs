import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const appRoot = path.join(root, 'src', 'app');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(fullPath) : [fullPath];
    }),
  );
  return nested.flat();
}

const htmlFiles = (await walk(appRoot)).filter((file) => file.endsWith('.html'));
let dialogCount = 0;
let trappedDialogCount = 0;
let unlabeledIconCloseButtons = 0;
const failures = [];

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  const dialogTags = html.match(/<[^>]*role="dialog"[^>]*>/gs) ?? [];

  dialogCount += dialogTags.length;
  for (const tag of dialogTags) {
    if (/appDialogFocusTrap/.test(tag)) {
      trappedDialogCount += 1;
    } else {
      failures.push(`${relative}: dialog is missing appDialogFocusTrap`);
    }
  }

  const closeButtons = html.match(/<button[^>]*>\s*×\s*<\/button>/gs) ?? [];
  for (const button of closeButtons) {
    if (!/aria-label=/.test(button)) {
      unlabeledIconCloseButtons += 1;
      failures.push(`${relative}: × close button is missing an aria-label`);
    }
  }
}

const [authHtml, routesSource, layoutHtml] = await Promise.all([
  readFile(path.join(appRoot, 'features', 'auth', 'auth.html'), 'utf8'),
  readFile(path.join(appRoot, 'app.routes.ts'), 'utf8'),
  readFile(path.join(appRoot, 'layouts', 'main-layout', 'main-layout.html'), 'utf8'),
]);

if (!/<form[\s\S]*\(ngSubmit\)="submit\(\)"/.test(authHtml)) {
  failures.push('Authentication controls are not contained in a semantic ngSubmit form.');
}
if (!/type="submit"\s+class="primary-submit"/.test(authHtml)) {
  failures.push('Authentication primary action is not a submit button.');
}
if (!/role="status"\s+aria-live="polite"\s+aria-atomic="true"/.test(layoutHtml)) {
  failures.push('Main layout is missing the route-change live announcement.');
}

const loadComponentCount = routesSource.match(/\bloadComponent\s*:/g)?.length ?? 0;
const titleCount = routesSource.match(/\btitle\s*:/g)?.length ?? 0;
// One loadComponent is the title-less authenticated layout shell. Every page route has a title.
if (titleCount < loadComponentCount - 1) {
  failures.push(`Only ${titleCount} route titles exist for ${loadComponentCount} lazy route components.`);
}

console.log('RinkRat accessibility audit');
console.log(`  HTML templates scanned: ${htmlFiles.length}`);
console.log(`  Dialogs using shared focus management: ${trappedDialogCount}/${dialogCount}`);
console.log(`  Unlabeled × close buttons: ${unlabeledIconCloseButtons}`);
console.log(`  Route titles: ${titleCount}/${loadComponentCount - 1} page routes`);
console.log(`  Semantic authentication form: ${/<form[\s\S]*\(ngSubmit\)="submit\(\)"/.test(authHtml) ? 'yes' : 'no'}`);

if (failures.length > 0) {
  console.error('\nAccessibility foundation audit failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('  ✓ Accessibility foundation checks passed.');
}
