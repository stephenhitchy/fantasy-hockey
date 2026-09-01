import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ensureReleaseManifestGitignore } from './release-manifest-gitignore.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../', import.meta.url);

const gitignoreRepair = await ensureReleaseManifestGitignore(ROOT);

if (gitignoreRepair.changed) {
  console.log(
    `Restored generated release-manifest ignore rules: ${gitignoreRepair.addedEntries.join(', ')}.`,
  );
}

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function extract(source, pattern, label) {
  const match = source.match(pattern);

  if (!match?.[1]) {
    throw new Error(`Unable to read ${label} while generating the release manifest.`);
  }

  return match[1];
}

function releaseSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'rinkrat';
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

async function pathExists(url) {
  try {
    await stat(url);
    return true;
  } catch {
    return false;
  }
}

async function readPackagedSourceRevision() {
  try {
    const revision = (await readFile(new URL('.rinkrat-source-revision', ROOT), 'utf8')).trim();
    return /^[0-9a-f]{7,80}$/i.test(revision) ? revision.slice(0, 80) : null;
  } catch {
    return null;
  }
}

async function resolveSourceRevision() {
  const explicitRevision = process.env.RINKRAT_SOURCE_REVISION;

  if (typeof explicitRevision === 'string' && explicitRevision.trim()) {
    return explicitRevision.trim().slice(0, 80);
  }

  // Release ZIPs intentionally omit .git so the source tree is not duplicated.
  // A tiny packaged revision file preserves the exact clean commit for manifest
  // generation. Only use Git when this project root actually owns Git metadata;
  // otherwise a parent repository could supply an unrelated revision.
  if (await pathExists(new URL('.git', ROOT))) {
    try {
      const [{ stdout: revisionOutput }, { stdout: statusOutput }] = await Promise.all([
        execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: new URL('.', ROOT),
          windowsHide: true,
        }),
        execFileAsync(
          'git',
          [
            'status',
            '--porcelain',
            '--untracked-files=normal',
            '--',
            '.',
            ':(exclude)public/release-manifest.json',
            ':(exclude)src/environments/generated-release-manifest.ts',
          ],
          {
            cwd: new URL('.', ROOT),
            windowsHide: true,
          },
        ),
      ]);
      const revision = revisionOutput.trim();

      if (revision) {
        return statusOutput.trim()
          ? `${revision.slice(0, 40)}-dirty`
          : revision.slice(0, 80);
      }
    } catch {
      // Continue to the packaged-revision fallback below.
    }
  }

  const packagedRevision = await readPackagedSourceRevision();

  if (packagedRevision) {
    return packagedRevision;
  }

  const providerRevision = [
    process.env.GITHUB_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.COMMIT_SHA,
  ].find((value) => typeof value === 'string' && value.trim());

  return providerRevision?.trim().slice(0, 80) ?? 'unversioned';
}

const [runtimeSource, productionRuntimeSource, scoringSource, projectionSource, packageSource] =
  await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('package.json'),
  ]);

const releaseLabel = extract(
  runtimeSource,
  /releaseLabel:\s*['"]([^'"]+)['"]/,
  'the development release label',
);
const productionReleaseLabel = extract(
  productionRuntimeSource,
  /releaseLabel:\s*['"]([^'"]+)['"]/,
  'the production release label',
);

if (releaseLabel !== productionReleaseLabel) {
  throw new Error(
    `Development and production release labels differ (${releaseLabel} vs ${productionReleaseLabel}).`,
  );
}

const scoringRulesVersion = Number(extract(
  scoringSource,
  /CURRENT_SCORING_RULES_VERSION\s*=\s*(\d+)/,
  'the scoring-rules version',
));
const projectionVersion = Number(extract(
  projectionSource,
  /SHARED_PROJECTION_VERSION\s*=\s*(\d+)/,
  'the projection version',
));
const packageJson = JSON.parse(packageSource);
const packageVersion = typeof packageJson.version === 'string' && packageJson.version.trim()
  ? packageJson.version.trim().slice(0, 40)
  : '0.0.0';
const sourceRevision = await resolveSourceRevision();
const builtAt = new Date();
const automaticBuildId = [
  releaseSlug(releaseLabel),
  compactTimestamp(builtAt),
  sourceRevision === 'unversioned' ? 'local' : sourceRevision.slice(0, 10),
].join('-');
const buildId = (
  typeof process.env.RINKRAT_BUILD_ID === 'string' && process.env.RINKRAT_BUILD_ID.trim()
    ? process.env.RINKRAT_BUILD_ID.trim()
    : automaticBuildId
).slice(0, 160);

const manifest = {
  schemaVersion: 1,
  releaseLabel,
  buildId,
  builtAt: builtAt.toISOString(),
  sourceRevision,
  packageVersion,
  scoringRulesVersion,
  projectionVersion,
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
const typescript = `// Generated by scripts/generate-release-manifest.mjs. Do not edit manually.\n` +
  `import type { ReleaseManifest } from '../app/core/release/release-manifest.models';\n\n` +
  `export const BUNDLED_RELEASE_MANIFEST: ReleaseManifest = ${JSON.stringify(manifest, null, 2)};\n`;

await Promise.all([
  writeFile(new URL('public/release-manifest.json', ROOT), json, 'utf8'),
  writeFile(new URL('src/environments/generated-release-manifest.ts', ROOT), typescript, 'utf8'),
]);

console.log(
  `Prepared ${manifest.releaseLabel} build ${manifest.buildId} ` +
  `(Scoring V${manifest.scoringRulesVersion}, Projection V${manifest.projectionVersion}).`,
);
