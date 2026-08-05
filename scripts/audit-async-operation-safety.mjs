import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const errors = [];
let callableCount = 0;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await walk(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }

  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

const appTypeScriptFiles = (await walk(path.join(root, 'src', 'app')))
  .filter((file) => file.endsWith('.ts'));

for (const file of appTypeScriptFiles) {
  const source = await readFile(file, 'utf8');
  const callableMatches = [...source.matchAll(/httpsCallable\s*(?:<|\()/g)];

  for (let matchIndex = 0; matchIndex < callableMatches.length; matchIndex += 1) {
    const match = callableMatches[matchIndex];
    const index = match.index ?? 0;
    const nextIndex = callableMatches[matchIndex + 1]?.index;
    callableCount += 1;

    const snippetEnd = nextIndex ?? Math.min(source.length, index + 2_000);
    const snippet = source.slice(index, snippetEnd);

    if (!/timeout\s*:\s*\d[\d_]*/.test(snippet)) {
      errors.push(`${relative(file)} has a browser callable without an explicit timeout near character ${index}.`);
    }
  }
}

const sourceChecks = [
  {
    file: 'src/app/features/draft/draft-room/draft-room.html',
    reject: /draft-pick-submission-shield|appViewportOverlayPortal/,
    message: 'Draft pick submission must use the compact reconciliation dock, not a full-screen portaled lock.',
  },
  {
    file: 'src/app/features/draft/draft-setup/draft-setup.html',
    reject: /draft-save-lock|appViewportOverlayPortal/,
    message: 'Draft settings must remain readable while saving and must not use a full-screen portaled lock.',
  },
  {
    file: 'src/app/shared/action-sheet/action-sheet.ts',
    require: /DEFAULT_BUSY_VISUAL_RELEASE_MILLISECONDS\s*=\s*12_000[\s\S]*visualReleased\.set\(true\)/,
    message: 'Shared action sheets must release a stuck visual backdrop after the bounded watchdog.',
  },
  {
    file: 'src/app/shared/accessibility/viewport-overlay-portal.directive.ts',
    require: /activeViewportOverlays = new Set<HTMLElement>[\s\S]*repairViewportOverlayLock/,
    message: 'Viewport overlay locking must be based on connected nodes and support self-repair.',
  },
  {
    file: 'src/app/app.ts',
    require: /NavigationEnd[\s\S]*repairViewportOverlayLock\(\)/,
    message: 'Every Angular route completion must repair a stale viewport lock.',
  },
  {
    file: 'src/app/features/draft/draft-room/draft-room.ts',
    require: /armPendingPickReconciliationLoop[\s\S]*armPendingPickConfirmationTimeout[\s\S]*submissionId/,
    message: 'Draft picks must have recurring reconciliation, a hard local release, and an idempotency key.',
  },
  {
    file: 'src/app/features/draft/draft-setup/draft-setup.ts',
    require: /createDraftSettingsSubmissionId[\s\S]*awaitDraftSettingsConfirmation[\s\S]*getFantasyDraftFromServer/,
    message: 'Draft settings must use an exact submission identifier and authoritative document confirmation.',
  },
];

for (const check of sourceChecks) {
  const source = await readFile(path.join(root, check.file), 'utf8');

  if (check.require && !check.require.test(source)) {
    errors.push(check.message);
  }

  if (check.reject && check.reject.test(source)) {
    errors.push(check.message);
  }
}

if (callableCount === 0) {
  errors.push('No browser Firebase callable definitions were found.');
}

if (errors.length > 0) {
  console.error('Async-operation safety audit failed:\n');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Async-operation safety audit passed: ${callableCount} browser callables have explicit timeouts.`);
  console.log('Draft picks and settings use bounded authoritative reconciliation.');
  console.log('Shared modal backdrops and viewport locks have automatic visual recovery.');
}
