import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

test('the unified transaction workbench is page-native and vertically scrollable', async () => {
  const [template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  assert.match(template, /<main class="unified-player-page rr-page-shell">/);
  assert.match(template, /flowStep\(\) === 'player-pool'/);
  assert.match(template, /transaction-incoming-row/);
  assert.doesNotMatch(template, /app-action-sheet|data-overlay-scroll-root|scrollChrome/);
  assert.match(styles, /\.unified-player-page[\s\S]*display:\s*grid/);
  assert.doesNotMatch(styles, /backdrop-filter/);
});

test('transaction timing guidance remains concise and available beside the decision', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /RinkRat verifies the exact six-game timeline before confirmation/);
  assert.match(template, /getSelectedAssetCycleHeadline\(\)/);
  assert.match(template, /getSelectedAssetCycleDetail\(\)/);
  assert.match(template, /<details class="transaction-timing-details">/);
  assert.doesNotMatch(template, /description="Review the incoming player first/);
});

test('replacement choices are full-width vertical player rows with no carousel controls', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  assert.ok(template.indexOf('transaction-incoming-row') < template.indexOf('transaction-roster-list'));
  assert.match(template, /class="unified-player-row transaction-roster-row rr-card"/);
  assert.match(template, /@for \(candidate of dropCandidates\(\)/);
  assert.doesNotMatch(template, /replacement-card-rail|replacement-rail-controls|#replacementRail/);
  assert.doesNotMatch(source, /scrollReplacementRail|ViewChild|ElementRef/);
  assert.match(styles, /\.transaction-roster-list[\s\S]*display:\s*grid/);
  assert.doesNotMatch(styles, /grid-auto-flow:\s*column|scroll-snap-type:\s*x mandatory/);
});

test('mobile workbench favors visible rows, six-game dots, and stacked actions', async () => {
  const styles = await read('src/app/features/free-agents/free-agents.css');

  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /\.unified-player-row[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.unified-player-actions[\s\S]*grid-template-columns:/);
  assert.match(styles, /\.unified-cycle-dots[\s\S]*grid-template-columns:\s*repeat\(3, 20px\)/);
  assert.match(styles, /min-height:\s*var\(--rr-mobile-control-min-height\)/);
});

test('the selected roster row uses a separate selection control and compact confirmation section', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /isSelectedDropCandidate\(candidate\)/);
  assert.match(template, /getDropCandidateActionLabel\(candidate\)/);
  assert.match(template, /selectDropCandidate\(candidate\)/);
  assert.match(template, /@if \(selectedDropCandidate\(\); as selectedCandidate\)/);
  assert.match(template, /transaction-confirmation[\s\S]*confirmAddDrop\(\)/);
  assert.match(template, /transaction-confirmation[\s\S]*getConfirmButtonLabel\(\)/);
});

test('M5.4 verification and deployment documentation remain available', async () => {
  const [packageJson, docs] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);

  assert.match(packageJson, /test:batchm5-4:run/);
  assert.match(packageJson, /verify:batchm5-4/);
  assert.match(docs, /Batch M5\.4 — Transaction Workbench Vertical Layout and Scrollable Dialog/);
  assert.match(docs, /Hosting-only presentation update/);
});

test('production scoring and Projection V11 remain unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    'd0ba8838c17737b00cdc5f0dea5e24ffb4e1af2154c2575baf28c3aa83de4901',
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    'f9cdb69372437c4cf4e70e678d98227d8777ccc13d37b7ef000ac71ba36d4e15',
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
