import { readFile, writeFile } from 'node:fs/promises';

export const GENERATED_RELEASE_IGNORE_SECTION = '# Generated deployment fingerprints';

export const GENERATED_RELEASE_IGNORE_ENTRIES = Object.freeze([
  '/public/release-manifest.json',
  '/src/environments/generated-release-manifest.ts',
]);

/**
 * Restores the generated release-manifest ignore rules when a manual project
 * replacement omits the hidden .gitignore file or leaves an older copy behind.
 * Existing rules are preserved and repeated runs are idempotent.
 */
export async function ensureReleaseManifestGitignore(rootUrl) {
  const gitignoreUrl = new URL('.gitignore', rootUrl);
  let source = '';

  try {
    source = await readFile(gitignoreUrl, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const normalizedLines = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missingEntries = GENERATED_RELEASE_IGNORE_ENTRIES.filter(
    (entry) => !normalizedLines.has(entry),
  );

  if (missingEntries.length === 0) {
    return {
      changed: false,
      addedEntries: [],
    };
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let nextSource = source;

  if (nextSource.length > 0 && !nextSource.endsWith('\n') && !nextSource.endsWith('\r')) {
    nextSource += newline;
  }

  if (nextSource.length > 0 && !nextSource.endsWith(`${newline}${newline}`)) {
    nextSource += newline;
  }

  if (!normalizedLines.has(GENERATED_RELEASE_IGNORE_SECTION)) {
    nextSource += `${GENERATED_RELEASE_IGNORE_SECTION}${newline}`;
  }

  for (const entry of missingEntries) {
    nextSource += `${entry}${newline}`;
  }

  await writeFile(gitignoreUrl, nextSource, 'utf8');

  return {
    changed: true,
    addedEntries: missingEntries,
  };
}
