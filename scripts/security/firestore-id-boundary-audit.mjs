import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryPath = path.join(projectRoot, 'config/firestore-document-id-boundaries.json');
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const failures = [];

function fail(message) {
  failures.push(message);
}

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const coreSource = await readFile(
  path.join(projectRoot, 'functions/src/shared/security/firestore-document-id-core.util.ts'),
  'utf8',
);
const callableSource = await readFile(
  path.join(projectRoot, 'functions/src/shared/security/firestore-document-id.util.ts'),
  'utf8',
);
const policySource = await readFile(
  path.join(projectRoot, 'functions/src/shared/security/firestore-document-id-policies.ts'),
  'utf8',
);

for (const token of [
  'resolveSafeFirestoreDocumentId',
  'Buffer.byteLength',
  "id.includes('/')",
  'RESERVED_DOCUMENT_ID_PATTERN',
]) {
  if (!coreSource.includes(token)) {
    fail(`The core document-ID validator is missing ${token}.`);
  }
}

for (const token of [
  'requireFirestoreDocumentId',
  'requireServerFirestoreDocumentId',
  'resolveSafeFirestoreDocumentId',
]) {
  if (!callableSource.includes(token)) {
    fail(`The callable/server validator module is missing ${token}.`);
  }
}

for (const policyName of Object.values(inventory.policies)) {
  if (!policySource.includes(`export const ${policyName}`)) {
    fail(`The semantic document-ID policy ${policyName} is missing.`);
  }
}

for (const boundary of inventory.boundaries) {
  const sourcePath = path.join(projectRoot, boundary.file);
  let source;
  try {
    source = await readFile(sourcePath, 'utf8');
  } catch {
    fail(`Boundary inventory file is missing: ${boundary.file}.`);
    continue;
  }

  for (const token of boundary.requiredTokens) {
    if (!source.includes(token)) {
      fail(`${boundary.file} is missing required boundary token ${token}.`);
    }
  }
}

const functionFiles = await collectTypeScriptFiles(path.join(projectRoot, 'functions/src'));
const unsafePathPattern = /(?:db\.doc|doc|collection)\(\s*`[^`]*\$\{\s*(?:event\.params|request\.auth\.uid|request\.data|payload\.)/gs;
const directEventAssignmentPattern = /const\s+(?:leagueId|ownerId|userId|playerId|pickId|requestId)\s*=\s*event\.params\./g;

for (const sourcePath of functionFiles) {
  const relativePath = path.relative(projectRoot, sourcePath);
  const source = await readFile(sourcePath, 'utf8');

  if (unsafePathPattern.test(source)) {
    fail(`${relativePath} interpolates an unvalidated external identifier directly into a Firestore path.`);
  }
  unsafePathPattern.lastIndex = 0;

  if (directEventAssignmentPattern.test(source)) {
    fail(`${relativePath} assigns a Firestore trigger parameter directly without resolving it.`);
  }
  directEventAssignmentPattern.lastIndex = 0;

  if (source.includes('onTaskDispatched<') && source.includes('request.data')) {
    if (!source.includes('resolveSafeFirestoreDocumentId')) {
      fail(`${relativePath} has a Cloud Tasks boundary without normalized document-ID resolution.`);
    }
  }

  if (source.includes('event.params.') && !source.includes('resolveSafeFirestoreDocumentId')) {
    fail(`${relativePath} consumes Firestore trigger parameters without the shared resolver.`);
  }
}

for (const forbidden of [
  'const normalizedSnapshotId = snapshotId.trim()',
  'const normalizedCatalogId = catalogId.trim()',
  'const leagueId = event.params.leagueId;',
]) {
  const matches = [];
  for (const sourcePath of functionFiles) {
    const source = await readFile(sourcePath, 'utf8');
    if (source.includes(forbidden)) {
      matches.push(path.relative(projectRoot, sourcePath));
    }
  }
  if (matches.length > 0) {
    fail(`Unsafe legacy identifier normalization remains (${forbidden}) in ${matches.join(', ')}.`);
  }
}

if (failures.length > 0) {
  console.error('Firestore identifier boundary audit failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Firestore identifier boundary audit passed: ${inventory.boundaries.length} boundary modules and ${functionFiles.length} Functions TypeScript files inspected.`,
);
