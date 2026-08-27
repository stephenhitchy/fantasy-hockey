import type {
  PrivateSeasonControlCenterSnapshot,
  PrivateSeasonGateDecision,
  PrivateSeasonLiveLeagueEvidence,
} from '../operations/private-season.models';
import type { ReleaseManifest } from './release-manifest.models';

export const PRIVATE_SEASON_FREEZE_EVIDENCE_SCHEMA_VERSION = 1;
export const PRIVATE_SEASON_FREEZE_EVIDENCE_REPORT_TYPE =
  'rinkrat-private-season-freeze-evidence';

export interface PrivateSeasonFreezeEvidenceGate {
  status: 'ready' | 'blocked';
  readyForFreeze: boolean;
  blockers: string[];
  advisories: string[];
}

export interface PrivateSeasonFreezeEvidenceReport {
  schemaVersion: 1;
  reportType: typeof PRIVATE_SEASON_FREEZE_EVIDENCE_REPORT_TYPE;
  generatedAt: string;
  build: ReleaseManifest;
  gate: PrivateSeasonFreezeEvidenceGate;
  season: {
    seasonLabel: string;
    planRevision: number;
    planStatus: string;
    planUpdatedAt: string | null;
    approvedReleaseLabel: string;
    approvedBuildId: string;
    featureFreezeConfirmed: boolean;
    nonGoals: string[];
  };
  cohort: {
    leagueCount: number;
    testerCount: number;
    nonFounderCommissionerCount: number;
    experienceCoverage: Record<string, boolean>;
    deviceCoverage: Record<string, boolean>;
    liveLeagueEvidence: PrivateSeasonLiveLeagueEvidence[];
  };
  support: {
    primaryOwnerConfigured: boolean;
    deputyConfigured: boolean;
    supportChannelReady: boolean;
    knownIssuesReady: boolean;
    rollbackRehearsed: boolean;
    deputyConfirmed: boolean;
    coverageConfirmed: boolean;
  };
  decision: PrivateSeasonGateDecision | null;
}

function sameBuild(
  build: ReleaseManifest,
  snapshot: PrivateSeasonControlCenterSnapshot,
): boolean {
  return build.releaseLabel === snapshot.build.releaseLabel &&
    build.buildId === snapshot.build.buildId &&
    build.scoringRulesVersion === snapshot.build.scoringRulesVersion &&
    build.projectionVersion === snapshot.build.projectionVersion;
}

export function buildPrivateSeasonFreezeEvidenceGate(input: {
  snapshot: PrivateSeasonControlCenterSnapshot;
  build: ReleaseManifest;
}): PrivateSeasonFreezeEvidenceGate {
  const { snapshot, build } = input;
  const plan = snapshot.plan;
  const readiness = snapshot.readiness;
  const blockers: string[] = [];
  const advisories: string[] = [];

  if (!/^[0-9a-f]{40}$/i.test(build.sourceRevision)) {
    blockers.push('The bundled release does not contain one clean source revision.');
  }

  if (!sameBuild(build, snapshot)) {
    blockers.push('The Private Season Control Center build does not match this deployed browser build.');
  }

  if (!readiness.exactBuildFrozen) {
    blockers.push('The private-season plan has not frozen this exact build.');
  }

  if (
    plan.freeze.approvedReleaseLabel !== build.releaseLabel ||
    plan.freeze.approvedBuildId !== build.buildId ||
    plan.freeze.featureFreezeConfirmed !== true
  ) {
    blockers.push('The private-season feature freeze is not bound to the exact deployed build.');
  }

  if (readiness.status !== 'ready' || readiness.blockers.length > 0) {
    blockers.push('The private-season plan still has stop-the-line readiness blockers.');
  }

  if (!readiness.currentDecisionValid) {
    blockers.push('The current private-season go/no-go decision is missing or no longer valid for this plan revision.');
  }

  if (
    plan.latestDecision?.outcome !== 'approved' ||
    plan.latestDecision.releaseLabel !== build.releaseLabel ||
    plan.latestDecision.buildId !== build.buildId ||
    plan.latestDecision.planRevision !== plan.revision
  ) {
    blockers.push('The formal private-season approval does not match this exact build and plan revision.');
  }

  if (!['approved', 'live'].includes(plan.status)) {
    blockers.push(`The private-season plan status is ${plan.status}, not approved or live.`);
  }

  if (
    !plan.support.primaryOwner.trim() ||
    !plan.support.deputyAlias.trim() ||
    !plan.support.supportChannelReady ||
    !plan.support.knownIssuesReady ||
    !plan.support.rollbackRehearsed ||
    !plan.support.deputyConfirmed ||
    !plan.support.coverageConfirmed
  ) {
    blockers.push('Support ownership, deputy coverage, Known Issues, or rollback readiness is incomplete.');
  }

  if (
    readiness.leagueCount < snapshot.policy.minimumLeagues ||
    readiness.leagueCount > snapshot.policy.maximumLeagues ||
    readiness.testerCount < snapshot.policy.minimumTesters ||
    readiness.testerCount > snapshot.policy.maximumTesters
  ) {
    blockers.push('The planned league or tester cohort is outside the approved private-season limits.');
  }

  if (readiness.nonFounderCommissionerCount < 1) {
    blockers.push('At least one non-founder commissioner is required.');
  }

  if (readiness.advisories.length > 0) {
    advisories.push(...readiness.advisories);
  }

  if (plan.freeze.nonGoals.length === 0) {
    advisories.push('The feature freeze contains no explicit non-goals. Record what will not change during the season.');
  }

  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    readyForFreeze: blockers.length === 0,
    blockers,
    advisories: [...new Set(advisories)],
  };
}

export function createPrivateSeasonFreezeEvidenceReport(input: {
  snapshot: PrivateSeasonControlCenterSnapshot;
  build: ReleaseManifest;
  generatedAt?: string;
}): PrivateSeasonFreezeEvidenceReport {
  const { snapshot, build } = input;
  const plan = snapshot.plan;

  return {
    schemaVersion: PRIVATE_SEASON_FREEZE_EVIDENCE_SCHEMA_VERSION,
    reportType: PRIVATE_SEASON_FREEZE_EVIDENCE_REPORT_TYPE,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    build: structuredClone(build),
    gate: buildPrivateSeasonFreezeEvidenceGate({ snapshot, build }),
    season: {
      seasonLabel: plan.seasonLabel,
      planRevision: plan.revision,
      planStatus: plan.status,
      planUpdatedAt: plan.updatedAt,
      approvedReleaseLabel: plan.freeze.approvedReleaseLabel,
      approvedBuildId: plan.freeze.approvedBuildId,
      featureFreezeConfirmed: plan.freeze.featureFreezeConfirmed,
      nonGoals: [...plan.freeze.nonGoals],
    },
    cohort: {
      leagueCount: snapshot.readiness.leagueCount,
      testerCount: snapshot.readiness.testerCount,
      nonFounderCommissionerCount:
        snapshot.readiness.nonFounderCommissionerCount,
      experienceCoverage: structuredClone(
        snapshot.readiness.experienceCoverage,
      ),
      deviceCoverage: structuredClone(snapshot.readiness.deviceCoverage),
      liveLeagueEvidence: structuredClone(
        snapshot.readiness.liveLeagueEvidence,
      ),
    },
    support: {
      primaryOwnerConfigured: Boolean(plan.support.primaryOwner.trim()),
      deputyConfigured: Boolean(plan.support.deputyAlias.trim()),
      supportChannelReady: plan.support.supportChannelReady,
      knownIssuesReady: plan.support.knownIssuesReady,
      rollbackRehearsed: plan.support.rollbackRehearsed,
      deputyConfirmed: plan.support.deputyConfirmed,
      coverageConfirmed: plan.support.coverageConfirmed,
    },
    decision: plan.latestDecision
      ? structuredClone(plan.latestDecision)
      : null,
  };
}
