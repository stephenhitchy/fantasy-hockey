import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildProspectProjectionPriorMap,
  normalizeProspectEvidenceSnapshot,
} from '../../src/app/core/projection/prospect-projection.util.ts';

const inputPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const printNormalized = process.argv.includes('--print-normalized');

if (!inputPath) {
  throw new Error(
    'Usage: npm run prospects:validate -- path/to/evidence.json [--print-normalized]',
  );
}

const absolutePath = resolve(process.cwd(), inputPath);
const raw = JSON.parse(await readFile(absolutePath, 'utf8'));
const normalized = normalizeProspectEvidenceSnapshot(raw);
const priors = buildProspectProjectionPriorMap(normalized);

if (printNormalized) {
  process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
} else {
  const provisionalProfileCount = normalized.translationProfiles.filter(
    (profile) => profile.provisional,
  ).length;
  const output = {
    valid: true,
    mode: normalized.mode,
    snapshotId: normalized.snapshotId,
    evidenceAsOf: normalized.evidenceAsOf,
    recordCount: normalized.records.length,
    usablePriorCount: priors.size,
    translationProfileCount: normalized.translationProfiles.length,
    provisionalProfileCount,
    firestoreDocument: 'appData/prospectProjectionEvidence',
    writesPerformed: false,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
