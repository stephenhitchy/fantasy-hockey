export interface ReleaseManifest {
  schemaVersion: 1;
  releaseLabel: string;
  buildId: string;
  builtAt: string;
  sourceRevision: string;
  packageVersion: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

export type ReleaseDeploymentDirection = 'same' | 'newer' | 'rollback' | 'different';

export type ReleaseUpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'update-available'
  | 'offline'
  | 'error';

export interface ReleaseUpdateSnapshot {
  bundled: ReleaseManifest;
  latest: ReleaseManifest | null;
  status: ReleaseUpdateStatus;
  direction: ReleaseDeploymentDirection;
  updateAvailable: boolean;
  checking: boolean;
  lastCheckedAt: string | null;
  errorMessage: string;
}
