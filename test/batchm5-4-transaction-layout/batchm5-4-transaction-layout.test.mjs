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

test('the transaction workbench uses the scrollable-chrome action-sheet mode', async () => {
  const [sheetSource, sheetTemplate, sheetStyles, freeAgentTemplate] = await Promise.all([
    read('src/app/shared/action-sheet/action-sheet.ts'),
    read('src/app/shared/action-sheet/action-sheet.html'),
    read('src/app/shared/action-sheet/action-sheet.css'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(sheetSource, /@Input\(\) scrollChrome = false/);
  assert.match(sheetTemplate, /rr-action-sheet--scroll-chrome/);
  assert.match(sheetTemplate, /data-overlay-scroll-root/);
  assert.match(sheetStyles, /\.rr-action-sheet--scroll-chrome[\s\S]*overflow-y:\s*auto/);
  assert.match(sheetStyles, /\.rr-action-sheet--scroll-chrome \.rr-action-sheet__content[\s\S]*overflow:\s*visible/);
  assert.match(freeAgentTemplate, /\[scrollChrome\]="true"/);
});

test('transaction helper copy remains available but is no longer pinned above the content', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /transaction-workbench-help/);
  assert.match(template, /How RinkRat verifies the move/);
  assert.match(template, /Incoming Player/);
  assert.match(template, /verifies the exact six-game timeline for both/);
  assert.doesNotMatch(template, /description="Review the incoming player first/);
});

test('replacement choices are full-width vertical cards with no carousel controls', async () => {
  const [source, template, styles] = await Promise.all([
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/rinkrat-transaction-workbench.css'),
  ]);

  assert.ok(template.indexOf('incoming-scout-card') < template.indexOf('replacement-card-list'));
  assert.match(template, /Review each legal roster option below/);
  assert.match(template, /class="replacement-card-list"/);
  assert.doesNotMatch(template, /replacement-card-rail|replacement-rail-controls|#replacementRail/);
  assert.doesNotMatch(source, /scrollReplacementRail|ViewChild|ElementRef/);
  assert.match(styles, /\.replacement-card-list\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.replacement-player-card\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /grid-auto-flow:\s*column|scroll-snap-type:\s*x mandatory/);
});

test('mobile workbench favors visible content and readable two-column game cards', async () => {
  const [sheetStyles, styles] = await Promise.all([
    read('src/app/shared/action-sheet/action-sheet.css'),
    read('src/rinkrat-transaction-workbench.css'),
  ]);

  assert.match(sheetStyles, /\.rr-action-sheet\.rr-action-sheet--scroll-chrome\s*\{[\s\S]*max-height:\s*96dvh/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.workbench-game-strip,[\s\S]*\.compact-game-strip[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.transaction-player-pair[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.selected-candidate-action[\s\S]*grid-template-columns:\s*1fr/);
});

test('the selected roster card offers confirmation without forcing a return to the top', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /isSelectedDropCandidate\(candidate\)[\s\S]*selected-candidate-action/);
  assert.match(template, /selected-candidate-action[\s\S]*confirmAddDrop\(\)/);
  assert.match(template, /selected-candidate-action[\s\S]*getConfirmButtonLabel\(\)/);
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
