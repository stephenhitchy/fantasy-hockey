export const OPERATIONS_API_VERSION = 1;
export const OPERATIONS_MINIMUM_RELEASE_CANDIDATE = 56;
export const OPERATIONS_LEGACY_CLIENT_RELEASE_CANDIDATE = 56;
export const OPERATIONS_SCORING_VERSION = 4;
export const OPERATIONS_PROJECTION_VERSION = 11;

export interface OperationsClientIdentity {
  operationsApiVersion: number;
  releaseLabel: string;
  buildId: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

export interface OperationsClientCompatibility {
  compatible: boolean;
  deployable: boolean;
  releaseCandidate: number | null;
  buildReleaseCandidate: number | null;
  message: string;
}

const RELEASE_LABEL_PATTERN = /^Release Candidate (\d{1,4})$/;
const BUILD_ID_PATTERN = /^release-candidate-(\d{1,4})-[A-Za-z0-9._:-]{4,160}$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function integer(value: unknown, minimum = 0, maximum = 10_000): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : 0;
}

function candidateFrom(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  const candidate = Number(match[1]);
  return Number.isInteger(candidate) ? candidate : null;
}

export function normalizeOperationsClientIdentity(value: unknown): OperationsClientIdentity {
  const source = record(value);
  return {
    operationsApiVersion: integer(source['operationsApiVersion'], 0, 100),
    releaseLabel: text(source['releaseLabel'], 80),
    buildId: text(source['buildId'], 180),
    scoringRulesVersion: integer(source['scoringRulesVersion'], 0, 100),
    projectionVersion: integer(source['projectionVersion'], 0, 100),
  };
}

export function assessOperationsClientCompatibility(
  identity: OperationsClientIdentity,
  options: { requireDeployableBuild?: boolean } = {},
): OperationsClientCompatibility {
  const releaseCandidate = candidateFrom(identity.releaseLabel, RELEASE_LABEL_PATTERN);
  const buildReleaseCandidate = candidateFrom(identity.buildId, BUILD_ID_PATTERN);
  const deployable = Boolean(identity.buildId) && !identity.buildId.endsWith('-local');

  const legacyRc56Client =
    identity.operationsApiVersion === 0 &&
    releaseCandidate === OPERATIONS_LEGACY_CLIENT_RELEASE_CANDIDATE &&
    buildReleaseCandidate === OPERATIONS_LEGACY_CLIENT_RELEASE_CANDIDATE;

  if (identity.operationsApiVersion !== OPERATIONS_API_VERSION && !legacyRc56Client) {
    return {
      compatible: false,
      deployable,
      releaseCandidate,
      buildReleaseCandidate,
      message: `This RinkRat build uses operations contract v${identity.operationsApiVersion || 'unknown'}; v${OPERATIONS_API_VERSION} is required. Refresh the site.`,
    };
  }

  if (
    releaseCandidate === null ||
    buildReleaseCandidate === null ||
    releaseCandidate !== buildReleaseCandidate ||
    releaseCandidate < OPERATIONS_MINIMUM_RELEASE_CANDIDATE
  ) {
    return {
      compatible: false,
      deployable,
      releaseCandidate,
      buildReleaseCandidate,
      message: `This operations endpoint requires Release Candidate ${OPERATIONS_MINIMUM_RELEASE_CANDIDATE} or newer with a matching signed release identity. Refresh the site.`,
    };
  }

  if (
    identity.scoringRulesVersion !== OPERATIONS_SCORING_VERSION ||
    identity.projectionVersion !== OPERATIONS_PROJECTION_VERSION
  ) {
    return {
      compatible: false,
      deployable,
      releaseCandidate,
      buildReleaseCandidate,
      message: `This operations endpoint requires Scoring V${OPERATIONS_SCORING_VERSION} and Projection V${OPERATIONS_PROJECTION_VERSION}. Refresh the site.`,
    };
  }

  if (options.requireDeployableBuild && !deployable) {
    return {
      compatible: false,
      deployable,
      releaseCandidate,
      buildReleaseCandidate,
      message: 'Open the deployed RinkRat site before completing this operation.',
    };
  }

  return {
    compatible: true,
    deployable,
    releaseCandidate,
    buildReleaseCandidate,
    message: legacyRc56Client
      ? 'Compatible legacy RC56 operations client.'
      : 'Compatible operations client.',
  };
}
