#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(
  projectRoot,
  'config/repository-automation/manifest.json',
);
const markerPath = path.join(projectRoot, '.github/rinkrat-automation-version');
const SECURITY_REPORT_IGNORE_RULE = '/.security-reports/';
const BETA_RELEASE_IGNORE_RULE = '/.beta-release/';
const SEASON_RELEASE_IGNORE_RULE = '/.season-release/';

function safeProjectPath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).some((segment) => segment === '..')
  ) {
    throw new Error(`Unsafe repository-automation path: ${String(relativePath)}`);
  }

  const resolved = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Repository-automation path escaped the project: ${relativePath}`);
  }
  return resolved;
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function ensureGeneratedIgnoreRules() {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let current = await readOptionalText(gitignorePath) ?? '';
  const additions = [];
  const normalizedLines = new Set(current.split(/\r?\n/).map((line) => line.trim()));

  if (!normalizedLines.has(SECURITY_REPORT_IGNORE_RULE)) {
    additions.push('# Generated security reports', SECURITY_REPORT_IGNORE_RULE);
  }
  if (!normalizedLines.has(BETA_RELEASE_IGNORE_RULE)) {
    additions.push('# Generated invite-beta freeze records', BETA_RELEASE_IGNORE_RULE);
  }
  if (!normalizedLines.has(SEASON_RELEASE_IGNORE_RULE)) {
    additions.push(
      '# Generated private-season freeze and recovery kits',
      SEASON_RELEASE_IGNORE_RULE,
    );
  }

  if (additions.length === 0) {
    return [];
  }

  if (current.length > 0 && !current.endsWith('\n')) {
    current += '\n';
  }
  await writeFile(gitignorePath, `${current}\n${additions.join('\n')}\n`, 'utf8');
  return additions.filter((line) => line.startsWith('/'));
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest?.schemaVersion !== 1 ||
    !Number.isInteger(manifest?.automationVersion) ||
    manifest.automationVersion < 1 ||
    !Array.isArray(manifest?.targets) ||
    manifest.targets.length === 0
  ) {
    throw new Error('Repository automation manifest is invalid.');
  }

  const existingMarker = Number.parseInt(
    (await readOptionalText(markerPath) ?? '').trim(),
    10,
  );
  const upgradeRequired = !Number.isInteger(existingMarker) ||
    existingMarker < manifest.automationVersion;
  const restored = [];

  for (const entry of manifest.targets) {
    const sourcePath = safeProjectPath(entry?.source);
    const targetPath = safeProjectPath(entry?.target);
    const source = await readFile(sourcePath, 'utf8');
    const target = await readOptionalText(targetPath);

    if (upgradeRequired || target === null) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, source, 'utf8');
      restored.push(entry.target);
    }
  }

  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${manifest.automationVersion}\n`, 'utf8');
  const restoredIgnoreRules = await ensureGeneratedIgnoreRules();

  if (restored.length > 0 || restoredIgnoreRules.length > 0) {
    console.log('Repository automation recovery completed:');
    restored.forEach((target) => console.log(`- restored ${target}`));
    restoredIgnoreRules.forEach((rule) => console.log(`- restored ${rule} in .gitignore`));
  } else {
    console.log(`Repository automation is ready (version ${manifest.automationVersion}).`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
