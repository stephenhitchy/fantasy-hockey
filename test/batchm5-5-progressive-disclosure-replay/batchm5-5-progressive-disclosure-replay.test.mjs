import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import {
  createHistoricalReplayAdvanceBaseline,
  evaluateHistoricalReplayAdvance,
} from '../../src/app/features/cycles/cycle-one/historical-replay-ui-state.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

async function hashTree(relativeDirectory, excludedPaths = new Set()) {
  const directoryUrl = new URL(relativeDirectory.endsWith('/') ? relativeDirectory : `${relativeDirectory}/`, ROOT);
  const rootPath = decodeURIComponent(directoryUrl.pathname);
  const files = [];

  async function visit(currentPath, relativePath = '') {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name === 'node_modules' || entry.name === 'lib') {
        continue;
      }

      const childPath = `${currentPath}/${entry.name}`;
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (excludedPaths.has(childRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(childPath, childRelativePath);
      } else if (entry.isFile()) {
        files.push({ path: childPath, relativePath: childRelativePath });
      }
    }
  }

  await visit(rootPath);
  const digest = createHash('sha256');

  for (const file of files) {
    const metadata = await stat(file.path);
    const bytes = await readFile(file.path);
    const pathBytes = Buffer.from(file.relativePath);

    digest.update(Buffer.from(Uint32Array.of(pathBytes.length).buffer).reverse());
    digest.update(pathBytes);
    digest.update(Buffer.from(BigUint64Array.of(BigInt(metadata.size)).buffer).reverse());
    digest.update(bytes);
  }

  return digest.digest('hex');
}

function control(overrides = {}) {
  return {
    status: 'ready',
    daysAdvanced: 4,
    simulatedDate: '2026-10-10',
    lastError: '',
    message: 'Previous day complete.',
    lastReleasedGameCount: 3,
    totalReleasedGameCount: 18,
    updatedAt: { seconds: 100, nanoseconds: 0 },
    ...overrides,
  };
}

test('an unchanged terminal replay snapshot does not prematurely unlock a new request', () => {
  const saved = control();
  const baseline = createHistoricalReplayAdvanceBaseline(saved);
  const evaluation = evaluateHistoricalReplayAdvance(baseline, saved, false);

  assert.deepEqual(evaluation, {
    state: 'pending',
    sawServerStart: false,
  });
});

test('the authoritative replay control unlocks after advancing then returning ready', () => {
  const baseline = createHistoricalReplayAdvanceBaseline(control());
  const started = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'advancing',
      simulatedDate: '2026-10-11',
      daysAdvanced: 5,
      message: 'Processing 2026-10-11.',
      updatedAt: { seconds: 101, nanoseconds: 0 },
    }),
    false,
  );
  const finished = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'ready',
      simulatedDate: '2026-10-11',
      daysAdvanced: 5,
      message: '2026-10-11 processed.',
      totalReleasedGameCount: 22,
      updatedAt: { seconds: 102, nanoseconds: 0 },
    }),
    started.sawServerStart,
  );

  assert.equal(started.state, 'pending');
  assert.equal(started.sawServerStart, true);
  assert.equal(finished.state, 'ready');
  assert.equal(finished.sawServerStart, true);
});

test('a same-date retry can settle from a newer Firestore update even if the advancing snapshot was missed', () => {
  const baseline = createHistoricalReplayAdvanceBaseline(
    control({
      status: 'error',
      lastError: 'Temporary lease collision.',
      message: 'Temporary lease collision.',
    }),
  );
  const finished = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'ready',
      lastError: '',
      message: 'The same simulated date was retried successfully.',
      updatedAt: { seconds: 103, nanoseconds: 0 },
    }),
    false,
  );

  assert.equal(finished.state, 'ready');
});

test('a newly saved replay error releases the local request while preserving the server error', () => {
  const baseline = createHistoricalReplayAdvanceBaseline(control());
  const failed = evaluateHistoricalReplayAdvance(
    baseline,
    control({
      status: 'error',
      lastError: 'The scoring lease remained unavailable.',
      message: 'The scoring lease remained unavailable.',
      updatedAt: { seconds: 104, nanoseconds: 0 },
    }),
    true,
  );

  assert.equal(failed.state, 'error');
});

test('the transaction workbench presents the decision summary before optional detail', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /incoming-scout-card/);
  assert.match(template, /View exact games/);
  assert.match(template, /View point formula/);
  assert.match(template, /@if \(incomingScheduleExpanded\(\)\)[\s\S]*incoming-six-game-details/);
  assert.match(template, /@if \(incomingScoringExpanded\(\)\)[\s\S]*incoming-season-formula/);
  assert.ok(template.indexOf('candidate-impact-strip') < template.indexOf('candidate-details-toggle'));
  assert.ok(template.indexOf('candidate-start-card') < template.indexOf('candidate-details-toggle'));
  assert.match(template, /@if \(isCandidateDetailsExpanded\(candidate\)\)[\s\S]*candidate-expanded-details/);
  assert.match(template, /Directly Comparable Options/);
  assert.match(template, /Show other bench options/);
  assert.match(template, /@if \(showFlexibleBenchOptions\(\)\)/);
  assert.match(template, /View first six scheduled games/);
  assert.match(template, /@if \(startWindowScheduleExpanded\(\)\)/);
});

test('only one replacement comparison is expanded at a time and disclosure state resets between moves', async () => {
  const source = await read('src/app/features/free-agents/free-agents.ts');

  assert.match(source, /expandedCandidateSlotId = signal\(''\)/);
  assert.match(source, /slotId === candidate\.slotId \? '' : candidate\.slotId/);
  assert.match(source, /showFlexibleBenchOptions = signal\(false\)/);
  assert.match(source, /resetTransactionDisclosureState\(\)/);
  assert.match(source, /this\.incomingScheduleExpanded\.set\(false\)/);
  assert.match(source, /this\.incomingScoringExpanded\.set\(false\)/);
  assert.match(source, /this\.expandedCandidateSlotId\.set\(''\)/);
  assert.match(source, /this\.showFlexibleBenchOptions\.set\(false\)/);
  assert.match(source, /this\.startWindowScheduleExpanded\.set\(false\)/);
});

test('the final decision is compact and avoids repeating two full player cards', async () => {
  const template = await read('src/app/features/free-agents/free-agents.html');

  assert.match(template, /Final Move Summary/);
  assert.match(template, /selected-final-copy/);
  assert.match(template, /getMoveProjectionDeltaLabel\('NEXT_CYCLE'\)/);
  assert.match(template, /getMoveProjectionDeltaLabel\('REST_OF_SEASON'\)/);
  assert.doesNotMatch(template, /class="transaction-player-pair"/);
  assert.doesNotMatch(template, /class="transaction-player-outgoing selected-final-player"/);
});

test('the replay button follows the Firestore control rather than waiting indefinitely for callable transport', async () => {
  const [source, template] = await Promise.all([
    read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    read('src/app/features/cycles/cycle-one/cycle-one.html'),
  ]);

  assert.match(source, /createHistoricalReplayAdvanceBaseline/);
  assert.match(source, /reconcileReplayAdvanceFromControl\(control\)/);
  assert.match(source, /evaluateHistoricalReplayAdvance/);
  assert.match(source, /replayAdvanceGeneration/);
  assert.match(source, /isCurrentReplayAdvance\(generation\)/);
  assert.match(source, /cancelReplayAdvanceTracking\(\)/);
  assert.match(source, /this\.historicalReplayControl\(\)\?\.status === 'advancing'/);
  assert.match(template, /\[disabled\]="isHistoricalReplayAdvanceLocked\(\)"/);
  assert.match(template, /historical-replay-transport-note/);
});

test('other dense decision surfaces continue using progressive disclosure', async () => {
  const [gameFilm, freeAgents] = await Promise.all([
    read('src/app/features/cycles/cycle-asset-detail/cycle-asset-detail.html'),
    read('src/app/features/free-agents/free-agents.html'),
  ]);

  assert.match(gameFilm, /<details class="projection-metadata-card">/);
  assert.match(gameFilm, /<details class="breakdown-details">/);
  assert.match(freeAgents, /<details class="decision-details selected-decision-details projection-explanation-details">/);
  assert.match(freeAgents, /<details class="transaction-workbench-help">/);
});

test('M5.5 verification and documentation are available', async () => {
  const [packageJson, docs] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);

  assert.match(packageJson, /test:batchm5-5:run/);
  assert.match(packageJson, /verify:batchm5-5/);
  assert.match(docs, /Batch M5\.5 — Progressive Transaction Decisions and Replay Control Recovery/);
  assert.match(docs, /Hosting-only/);
});

test('competitive scoring, Projection V11, and Functions unrelated to later replay or draft recovery remain unchanged', async () => {
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
  assert.equal(
    await hashTree(
      'functions',
      new Set([
        'src/index.ts',
        'src/league-lifecycle-authority.ts',
    'src/league-lifecycle-authority.util.ts',
        'src/league-automation.ts',
        'src/shared/core/cycle/cycle.service.ts',
        'src/shared/core/projection/window-projection.service.ts',
        'src/projection-authority.ts',
        'src/shared/core/projection/projection-asset-catalog.service.ts',
        'src/shared/core/projection/projection-asset-catalog.util.ts',
        'src/shared/core/projection/projection-snapshot.service.ts',
        'src/shared/core/projection/projection-snapshot-hash.util.ts',
        'src/draft-authority.ts',
        'src/draft-automation.ts',
        'src/shared/core/draft/draft.models.ts',
        'package.json',
      ]),
    ),
    '3212052cca056d9bfd89bdcd9e11fb58969650a28767d000455199897ce9c1cb',
  );
});
