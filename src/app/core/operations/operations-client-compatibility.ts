import { BUNDLED_RELEASE_MANIFEST } from '../../../environments/generated-release-manifest';

export const OPERATIONS_API_VERSION = 1;
export const OPERATIONS_MINIMUM_RELEASE_CANDIDATE = 56;
export const OPERATIONS_SCORING_VERSION = 4;
export const OPERATIONS_PROJECTION_VERSION = 11;

export interface OperationsClientIdentity {
  operationsApiVersion: number;
  releaseLabel: string;
  buildId: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

export function currentOperationsClientIdentity(): OperationsClientIdentity {
  return {
    operationsApiVersion: OPERATIONS_API_VERSION,
    releaseLabel: BUNDLED_RELEASE_MANIFEST.releaseLabel,
    buildId: BUNDLED_RELEASE_MANIFEST.buildId,
    scoringRulesVersion: BUNDLED_RELEASE_MANIFEST.scoringRulesVersion,
    projectionVersion: BUNDLED_RELEASE_MANIFEST.projectionVersion,
  };
}
