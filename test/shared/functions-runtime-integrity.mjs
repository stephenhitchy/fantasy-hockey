import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FUNCTIONS_ROOT = fileURLToPath(new URL('../../functions/', import.meta.url));

const GENERATED_DIRECTORY_NAMES = new Set([
  '.firebase',
  '.cache',
  'coverage',
  'node_modules',
]);

/**
 * The protected fingerprint covers source-controlled inputs that define the
 * Firebase Functions runtime, build/dependency contract, and operational
 * tooling. Repository instructions and generated output are intentionally not
 * part of that contract. The explicit directory inventory excludes top-level
 * generated output such as functions/lib while preserving legitimate nested
 * source directories such as functions/src/lib and functions/scripts/lib.
 */
export const FUNCTIONS_RUNTIME_INTEGRITY_INVENTORY = Object.freeze({
  files: Object.freeze([
    'package-lock.json',
    'package.json',
    'tsconfig.json',
  ]),
  directories: Object.freeze([
    'scripts',
    'src',
  ]),
});

function normalizeFunctionsRoot(functionsRoot) {
  if (functionsRoot instanceof URL) {
    return fileURLToPath(functionsRoot);
  }

  return path.resolve(functionsRoot);
}

function isGeneratedFile(relativePath) {
  return relativePath.endsWith('.log') || path.basename(relativePath) === '.DS_Store';
}

function isRepositoryInstructionFile(relativePath) {
  return path.basename(relativePath) === 'AGENTS.md';
}

async function collectDirectoryFiles(rootPath, relativeDirectory, files) {
  const directoryPath = path.join(rootPath, relativeDirectory);
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    const childRelativePath = `${relativeDirectory}/${entry.name}`;

    if (entry.isDirectory()) {
      if (!GENERATED_DIRECTORY_NAMES.has(entry.name)) {
        await collectDirectoryFiles(rootPath, childRelativePath, files);
      }
    } else if (
      entry.isFile() &&
      !isGeneratedFile(childRelativePath) &&
      !isRepositoryInstructionFile(childRelativePath)
    ) {
      files.push(childRelativePath);
    }
  }
}

export async function listFunctionsRuntimeIntegrityFiles({
  functionsRoot = DEFAULT_FUNCTIONS_ROOT,
  excludedPaths = new Set(),
} = {}) {
  const rootPath = normalizeFunctionsRoot(functionsRoot);
  const files = [...FUNCTIONS_RUNTIME_INTEGRITY_INVENTORY.files];

  for (const relativeDirectory of FUNCTIONS_RUNTIME_INTEGRITY_INVENTORY.directories) {
    await collectDirectoryFiles(rootPath, relativeDirectory, files);
  }

  return files
    .filter((relativePath) => !excludedPaths.has(relativePath))
    .sort((first, second) => first.localeCompare(second));
}

export async function hashFunctionsRuntimeIntegrity(options = {}) {
  const rootPath = normalizeFunctionsRoot(options.functionsRoot ?? DEFAULT_FUNCTIONS_ROOT);
  const files = await listFunctionsRuntimeIntegrityFiles({ ...options, functionsRoot: rootPath });
  const digest = createHash('sha256');

  for (const relativePath of files) {
    const filePath = path.join(rootPath, relativePath);
    const metadata = await stat(filePath);
    const bytes = await readFile(filePath);
    const pathBytes = Buffer.from(relativePath);
    const pathLength = Buffer.allocUnsafe(4);
    const fileSize = Buffer.allocUnsafe(8);

    pathLength.writeUInt32BE(pathBytes.length);
    fileSize.writeBigUInt64BE(BigInt(metadata.size));

    digest.update(pathLength);
    digest.update(pathBytes);
    digest.update(fileSize);
    digest.update(bytes);
  }

  return digest.digest('hex');
}
