import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

test('control-center league documents use the broader DocumentSnapshot type', async () => {
  const automation = await read('functions/src/league-automation.ts');

  assert.match(
    automation,
    /import type \{ DocumentSnapshot \} from 'firebase-admin\/firestore';/,
    'league-automation.ts must import DocumentSnapshot as a Firebase Admin type',
  );
  assert.match(
    automation,
    /const leagueDocuments:\s*DocumentSnapshot<DocumentData,\s*DocumentData>\[\]\s*=\s*\[\s*\.\.\.snapshot\.docs,\s*\];/,
    'the mixed query/getAll collection must be typed as DocumentSnapshot[]',
  );
  assert.match(
    automation,
    /if \(managedSnapshot\.exists\) \{\s*leagueDocuments\.unshift\(managedSnapshot\);\s*\}/,
  );
  assert.doesNotMatch(
    automation,
    /const leagueDocuments\s*=\s*\[\.\.\.snapshot\.docs\];/,
    'letting TypeScript infer QueryDocumentSnapshot[] recreates TS2345 when getAll snapshots are inserted',
  );
});

test('P1F.1 documentation records the Firebase Admin snapshot compile hotfix', async () => {
  const [documentation, runbook, packageJson] = await Promise.all([
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md'),
    read('package.json'),
  ]);

  assert.match(documentation, /Batch P1F\.1 — Functions Document Snapshot Type Hotfix/);
  assert.match(documentation, /TS2345/);
  assert.match(documentation, /DocumentSnapshot<DocumentData, DocumentData>\[\]/);
  assert.match(runbook, /Batch P1F\.1/);
  assert.match(packageJson, /"verify:batchp1f-1"/);
});
