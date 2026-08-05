import type {
  ReleaseDeploymentDirection,
  ReleaseManifest,
} from './release-manifest.models';

const MAX_RELEASE_LABEL_LENGTH = 80;
const MAX_BUILD_ID_LENGTH = 160;
const MAX_REVISION_LENGTH = 80;
const MAX_PACKAGE_VERSION_LENGTH = 40;

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function normalizeReleaseManifest(value: unknown): ReleaseManifest | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<ReleaseManifest>;
  const releaseLabel = boundedText(candidate.releaseLabel, MAX_RELEASE_LABEL_LENGTH);
  const buildId = boundedText(candidate.buildId, MAX_BUILD_ID_LENGTH);
  const builtAt = validIso(candidate.builtAt);
  const sourceRevision = boundedText(candidate.sourceRevision, MAX_REVISION_LENGTH);
  const packageVersion = boundedText(candidate.packageVersion, MAX_PACKAGE_VERSION_LENGTH);
  const scoringRulesVersion = positiveInteger(candidate.scoringRulesVersion);
  const projectionVersion = positiveInteger(candidate.projectionVersion);

  if (
    candidate.schemaVersion !== 1 ||
    !releaseLabel ||
    !buildId ||
    !builtAt ||
    !sourceRevision ||
    !packageVersion ||
    scoringRulesVersion === null ||
    projectionVersion === null
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    releaseLabel,
    buildId,
    builtAt,
    sourceRevision,
    packageVersion,
    scoringRulesVersion,
    projectionVersion,
  };
}

export function compareReleaseManifests(
  bundled: ReleaseManifest,
  deployed: ReleaseManifest | null,
): ReleaseDeploymentDirection {
  if (!deployed || deployed.buildId === bundled.buildId) {
    return 'same';
  }

  const bundledTime = Date.parse(bundled.builtAt);
  const deployedTime = Date.parse(deployed.builtAt);

  if (Number.isFinite(bundledTime) && Number.isFinite(deployedTime)) {
    if (deployedTime > bundledTime) {
      return 'newer';
    }

    if (deployedTime < bundledTime) {
      return 'rollback';
    }
  }

  return 'different';
}

export function shortBuildIdentifier(manifest: ReleaseManifest): string {
  if (manifest.sourceRevision === 'unversioned') {
    const timestamp = manifest.buildId.match(/\d{8}T(\d{9})Z/)?.[1];
    return timestamp ?? manifest.buildId.slice(-10);
  }

  if (manifest.sourceRevision.endsWith('-dirty')) {
    return `${manifest.sourceRevision.slice(0, 9)}*`;
  }

  return manifest.sourceRevision.slice(0, 10);
}
