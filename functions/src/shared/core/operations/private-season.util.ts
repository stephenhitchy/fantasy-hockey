import { createHash } from 'node:crypto';

export const PRIVATE_SEASON_MINIMUM_LEAGUES = 2;
export const PRIVATE_SEASON_MAXIMUM_LEAGUES = 4;
export const PRIVATE_SEASON_MINIMUM_MANAGERS_PER_LEAGUE = 6;
export const PRIVATE_SEASON_MINIMUM_TESTERS = 10;
export const PRIVATE_SEASON_MAXIMUM_TESTERS = 30;
export const PRIVATE_SEASON_DECISION_REASON_MINIMUM_LENGTH = 12;
export const PRIVATE_SEASON_RELEASE_LABEL = 'Release Candidate 56';
export const PRIVATE_SEASON_SCORING_VERSION = 4;
export const PRIVATE_SEASON_PROJECTION_VERSION = 11;

export const PRIVATE_SEASON_EXPERIENCES = [
  'hockey-expert',
  'casual-fan',
  'fantasy-beginner',
] as const;

export const PRIVATE_SEASON_DEVICES = [
  'iphone',
  'android',
  'desktop',
] as const;

export type PrivateSeasonStatus =
  | 'planning'
  | 'rehearsal'
  | 'approved'
  | 'delayed'
  | 'live'
  | 'complete';

export type PrivateSeasonExperience = typeof PRIVATE_SEASON_EXPERIENCES[number];
export type PrivateSeasonDevice = typeof PRIVATE_SEASON_DEVICES[number];
export type PrivateSeasonTesterRole = 'commissioner' | 'manager';
export type PrivateSeasonGateOutcome = 'approved' | 'delayed';

export interface PrivateSeasonLeagueSlot {
  slotId: string;
  leagueId: string;
  label: string;
  expectedManagerCount: number;
  draftRehearsalComplete: boolean;
  active: boolean;
}

export interface PrivateSeasonTester {
  testerId: string;
  alias: string;
  leagueSlotIds: string[];
  role: PrivateSeasonTesterRole;
  experience: PrivateSeasonExperience;
  devices: PrivateSeasonDevice[];
  isFounder: boolean;
  contactConfirmed: boolean;
  consentConfirmed: boolean;
  accountReady: boolean;
  draftRehearsalComplete: boolean;
}

export interface PrivateSeasonSupportReadiness {
  primaryOwner: string;
  deputyAlias: string;
  supportChannelReady: boolean;
  knownIssuesReady: boolean;
  rollbackRehearsed: boolean;
  deputyConfirmed: boolean;
  coverageConfirmed: boolean;
}

export interface PrivateSeasonFreezeReadiness {
  featureFreezeConfirmed: boolean;
  approvedReleaseLabel: string;
  approvedBuildId: string;
  nonGoals: string[];
}

export interface PrivateSeasonGateDecision {
  decisionId: string;
  gate: 'private-season';
  outcome: PrivateSeasonGateOutcome;
  reason: string;
  planRevision: number;
  planHash: string;
  releaseLabel: string;
  buildId: string;
  recordedAt: string | null;
  recordedBy: string;
}

export interface PrivateSeasonPlan {
  schemaVersion: 1;
  seasonLabel: '2026-27';
  revision: number;
  status: PrivateSeasonStatus;
  leagueSlots: PrivateSeasonLeagueSlot[];
  testers: PrivateSeasonTester[];
  support: PrivateSeasonSupportReadiness;
  freeze: PrivateSeasonFreezeReadiness;
  latestDecision: PrivateSeasonGateDecision | null;
  updatedAt: string | null;
  updatedBy: string;
}

export interface PrivateSeasonLiveLeagueEvidence {
  slotId: string;
  leagueId: string;
  exists: boolean;
  name: string;
  teamCount: number;
  maxTeams: number;
  draftStatus: string;
  draftOrderCount: number;
  draftScheduled: boolean;
}

export interface PrivateSeasonBuildIdentity {
  releaseLabel: string;
  buildId: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

export interface PrivateSeasonReadiness {
  status: 'blocked' | 'needs-attention' | 'ready';
  headline: string;
  blockers: string[];
  advisories: string[];
  leagueCount: number;
  testerCount: number;
  nonFounderCommissionerCount: number;
  experienceCoverage: Record<PrivateSeasonExperience, boolean>;
  deviceCoverage: Record<PrivateSeasonDevice, boolean>;
  liveLeagueEvidence: PrivateSeasonLiveLeagueEvidence[];
  exactBuildFrozen: boolean;
  currentDecisionValid: boolean;
  readyForApproval: boolean;
}

export interface PrivateSeasonPolicy {
  minimumLeagues: number;
  maximumLeagues: number;
  minimumManagersPerLeague: number;
  minimumTesters: number;
  maximumTesters: number;
  requiredExperiences: PrivateSeasonExperience[];
  requiredDevices: PrivateSeasonDevice[];
  requiresNonFounderCommissioner: true;
  decisionReasonMinimumLength: number;
  noContactDetails: true;
}

const PLAN_STATUSES = new Set<PrivateSeasonStatus>([
  'planning',
  'rehearsal',
  'approved',
  'delayed',
  'live',
  'complete',
]);
const TESTER_ROLES = new Set<PrivateSeasonTesterRole>(['commissioner', 'manager']);
const DECISION_OUTCOMES = new Set<PrivateSeasonGateOutcome>(['approved', 'delayed']);
const SIMPLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._:-]{4,180}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

function boundedMultiline(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

function privacyLimitedAlias(value: unknown, fallback: string): string {
  const candidate = boundedString(value, 40);

  if (!candidate || candidate.includes('@') || /(?:\d[\s().-]*){7,}/.test(candidate)) {
    return fallback;
  }

  return candidate;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeId(value: unknown, fallback: string, seen: Set<string>): string {
  const candidate = boundedString(value, 80);
  let result = SIMPLE_ID_PATTERN.test(candidate) ? candidate : fallback;
  let suffix = 2;

  while (seen.has(result)) {
    result = `${fallback}-${suffix}`;
    suffix += 1;
  }

  seen.add(result);
  return result;
}

function normalizeDecision(value: unknown): PrivateSeasonGateDecision | null {
  const source = asRecord(value);
  const outcome = boundedString(source['outcome'], 20) as PrivateSeasonGateOutcome;
  const decisionId = boundedString(source['decisionId'], 80);
  const planHash = boundedString(source['planHash'], 64).toLowerCase();
  const releaseLabel = boundedString(source['releaseLabel'], 80);
  const buildId = boundedString(source['buildId'], 180);
  const reason = boundedMultiline(source['reason'], 600);

  if (
    !SIMPLE_ID_PATTERN.test(decisionId) ||
    !DECISION_OUTCOMES.has(outcome) ||
    !HASH_PATTERN.test(planHash) ||
    !releaseLabel ||
    !BUILD_ID_PATTERN.test(buildId) ||
    reason.length < PRIVATE_SEASON_DECISION_REASON_MINIMUM_LENGTH
  ) {
    return null;
  }

  return {
    decisionId,
    gate: 'private-season',
    outcome,
    reason,
    planRevision: boundedInteger(source['planRevision'], 0, 1_000_000, 0),
    planHash,
    releaseLabel,
    buildId,
    recordedAt: isoOrNull(source['recordedAt']),
    recordedBy: boundedString(source['recordedBy'], 128),
  };
}

export function privateSeasonPolicy(): PrivateSeasonPolicy {
  return {
    minimumLeagues: PRIVATE_SEASON_MINIMUM_LEAGUES,
    maximumLeagues: PRIVATE_SEASON_MAXIMUM_LEAGUES,
    minimumManagersPerLeague: PRIVATE_SEASON_MINIMUM_MANAGERS_PER_LEAGUE,
    minimumTesters: PRIVATE_SEASON_MINIMUM_TESTERS,
    maximumTesters: PRIVATE_SEASON_MAXIMUM_TESTERS,
    requiredExperiences: [...PRIVATE_SEASON_EXPERIENCES],
    requiredDevices: [...PRIVATE_SEASON_DEVICES],
    requiresNonFounderCommissioner: true,
    decisionReasonMinimumLength: PRIVATE_SEASON_DECISION_REASON_MINIMUM_LENGTH,
    noContactDetails: true,
  };
}

export function emptyPrivateSeasonPlan(): PrivateSeasonPlan {
  return {
    schemaVersion: 1,
    seasonLabel: '2026-27',
    revision: 0,
    status: 'planning',
    leagueSlots: [],
    testers: [],
    support: {
      primaryOwner: 'Stephen',
      deputyAlias: '',
      supportChannelReady: false,
      knownIssuesReady: false,
      rollbackRehearsed: false,
      deputyConfirmed: false,
      coverageConfirmed: false,
    },
    freeze: {
      featureFreezeConfirmed: false,
      approvedReleaseLabel: '',
      approvedBuildId: '',
      nonGoals: [],
    },
    latestDecision: null,
    updatedAt: null,
    updatedBy: '',
  };
}

export function normalizePrivateSeasonPlan(value: unknown): PrivateSeasonPlan {
  const defaults = emptyPrivateSeasonPlan();
  const source = asRecord(value);
  const leagueSources = Array.isArray(source['leagueSlots']) ? source['leagueSlots'] : [];
  const testerSources = Array.isArray(source['testers']) ? source['testers'] : [];
  const supportSource = asRecord(source['support']);
  const freezeSource = asRecord(source['freeze']);
  const statusCandidate = boundedString(source['status'], 30) as PrivateSeasonStatus;
  const leagueIds = new Set<string>();
  const testerIds = new Set<string>();
  const leagueSlots: PrivateSeasonLeagueSlot[] = [];

  for (const [index, raw] of leagueSources.slice(0, PRIVATE_SEASON_MAXIMUM_LEAGUES).entries()) {
    const item = asRecord(raw);
    const slotId = safeId(item['slotId'], `league-slot-${index + 1}`, leagueIds);
    leagueSlots.push({
      slotId,
      leagueId: boundedString(item['leagueId'], 128),
      label: boundedString(item['label'], 60) || `Tester League ${index + 1}`,
      expectedManagerCount: boundedInteger(
        item['expectedManagerCount'],
        PRIVATE_SEASON_MINIMUM_MANAGERS_PER_LEAGUE,
        12,
        PRIVATE_SEASON_MINIMUM_MANAGERS_PER_LEAGUE,
      ),
      draftRehearsalComplete: item['draftRehearsalComplete'] === true,
      active: item['active'] !== false,
    });
  }

  const activeSlotIds = new Set(leagueSlots.filter((item) => item.active).map((item) => item.slotId));
  const testers: PrivateSeasonTester[] = [];

  for (const [index, raw] of testerSources.slice(0, PRIVATE_SEASON_MAXIMUM_TESTERS).entries()) {
    const item = asRecord(raw);
    const testerId = safeId(item['testerId'], `tester-${index + 1}`, testerIds);
    const roleCandidate = boundedString(item['role'], 20) as PrivateSeasonTesterRole;
    const experienceCandidate = boundedString(item['experience'], 30) as PrivateSeasonExperience;
    const rawDevices = Array.isArray(item['devices']) ? item['devices'] : [];
    const devices = [...new Set(rawDevices
      .map((device) => boundedString(device, 20) as PrivateSeasonDevice)
      .filter((device) => PRIVATE_SEASON_DEVICES.includes(device)))]
      .slice(0, PRIVATE_SEASON_DEVICES.length);
    const legacyLeagueSlotId = boundedString(item['leagueSlotId'], 80);
    const rawLeagueSlotIds = Array.isArray(item['leagueSlotIds'])
      ? item['leagueSlotIds']
      : legacyLeagueSlotId
        ? [legacyLeagueSlotId]
        : [];
    const leagueSlotIds = [...new Set(rawLeagueSlotIds
      .map((slotId) => boundedString(slotId, 80))
      .filter(Boolean))]
      .slice(0, PRIVATE_SEASON_MAXIMUM_LEAGUES);

    testers.push({
      testerId,
      alias: privacyLimitedAlias(item['alias'], `Tester ${index + 1}`),
      leagueSlotIds,
      role: TESTER_ROLES.has(roleCandidate) ? roleCandidate : 'manager',
      experience: PRIVATE_SEASON_EXPERIENCES.includes(experienceCandidate)
        ? experienceCandidate
        : 'casual-fan',
      devices,
      isFounder: item['isFounder'] === true,
      contactConfirmed: item['contactConfirmed'] === true,
      consentConfirmed: item['consentConfirmed'] === true,
      accountReady: item['accountReady'] === true,
      draftRehearsalComplete: item['draftRehearsalComplete'] === true,
    });
  }

  const nonGoalsSource = Array.isArray(freezeSource['nonGoals']) ? freezeSource['nonGoals'] : [];
  const nonGoals = [...new Set(nonGoalsSource
    .map((item) => boundedMultiline(item, 180))
    .filter(Boolean))]
    .slice(0, 12);

  return {
    ...defaults,
    revision: boundedInteger(source['revision'], 0, 1_000_000, 0),
    status: PLAN_STATUSES.has(statusCandidate) ? statusCandidate : 'planning',
    leagueSlots,
    testers,
    support: {
      primaryOwner: privacyLimitedAlias(supportSource['primaryOwner'], 'Stephen'),
      deputyAlias: privacyLimitedAlias(supportSource['deputyAlias'], ''),
      supportChannelReady: supportSource['supportChannelReady'] === true,
      knownIssuesReady: supportSource['knownIssuesReady'] === true,
      rollbackRehearsed: supportSource['rollbackRehearsed'] === true,
      deputyConfirmed: supportSource['deputyConfirmed'] === true,
      coverageConfirmed: supportSource['coverageConfirmed'] === true,
    },
    freeze: {
      featureFreezeConfirmed: freezeSource['featureFreezeConfirmed'] === true,
      approvedReleaseLabel: boundedString(freezeSource['approvedReleaseLabel'], 80),
      approvedBuildId: boundedString(freezeSource['approvedBuildId'], 180),
      nonGoals,
    },
    latestDecision: normalizeDecision(source['latestDecision']),
    updatedAt: isoOrNull(source['updatedAt']),
    updatedBy: boundedString(source['updatedBy'], 128),
  };
}

export function privateSeasonPlanHashInput(plan: PrivateSeasonPlan): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    seasonLabel: plan.seasonLabel,
    revision: plan.revision,
    status: plan.status,
    leagueSlots: plan.leagueSlots.map((item) => ({ ...item })),
    testers: plan.testers.map((item) => ({
      ...item,
      devices: [...item.devices].sort(),
      leagueSlotIds: [...item.leagueSlotIds].sort(),
    })),
    support: { ...plan.support },
    freeze: { ...plan.freeze, nonGoals: [...plan.freeze.nonGoals] },
  };
}

export function privateSeasonPlanHash(plan: PrivateSeasonPlan): string {
  return createHash('sha256')
    .update(JSON.stringify(privateSeasonPlanHashInput(plan)))
    .digest('hex');
}

export function buildPrivateSeasonReadiness(input: {
  plan: PrivateSeasonPlan;
  liveLeagueEvidence: PrivateSeasonLiveLeagueEvidence[];
  build: PrivateSeasonBuildIdentity;
}): PrivateSeasonReadiness {
  const plan = normalizePrivateSeasonPlan(input.plan);
  const activeLeagues = plan.leagueSlots.filter((item) => item.active);
  const activeSlotIds = new Set(activeLeagues.map((item) => item.slotId));
  const testers = plan.testers;
  const blockers: string[] = [];
  const advisories: string[] = [];
  const experienceCoverage = Object.fromEntries(
    PRIVATE_SEASON_EXPERIENCES.map((experience) => [
      experience,
      testers.some((tester) => tester.experience === experience),
    ]),
  ) as Record<PrivateSeasonExperience, boolean>;
  const deviceCoverage = Object.fromEntries(
    PRIVATE_SEASON_DEVICES.map((device) => [
      device,
      testers.some((tester) => tester.devices.includes(device)),
    ]),
  ) as Record<PrivateSeasonDevice, boolean>;
  const nonFounderCommissionerCount = testers.filter((tester) =>
    tester.role === 'commissioner' && !tester.isFounder
  ).length;
  const exactBuildFrozen = plan.freeze.featureFreezeConfirmed &&
    plan.freeze.approvedReleaseLabel === input.build.releaseLabel &&
    plan.freeze.approvedBuildId === input.build.buildId &&
    input.build.scoringRulesVersion === PRIVATE_SEASON_SCORING_VERSION &&
    input.build.projectionVersion === PRIVATE_SEASON_PROJECTION_VERSION;

  if (
    activeLeagues.length < PRIVATE_SEASON_MINIMUM_LEAGUES ||
    activeLeagues.length > PRIVATE_SEASON_MAXIMUM_LEAGUES
  ) {
    blockers.push(`Configure ${PRIVATE_SEASON_MINIMUM_LEAGUES}–${PRIVATE_SEASON_MAXIMUM_LEAGUES} active tester leagues.`);
  }

  if (
    testers.length < PRIVATE_SEASON_MINIMUM_TESTERS ||
    testers.length > PRIVATE_SEASON_MAXIMUM_TESTERS
  ) {
    blockers.push(`Track ${PRIVATE_SEASON_MINIMUM_TESTERS}–${PRIVATE_SEASON_MAXIMUM_TESTERS} privacy-limited tester aliases.`);
  }

  if (nonFounderCommissionerCount < 1) {
    blockers.push('Assign at least one non-founder commissioner to the cohort.');
  }

  for (const experience of PRIVATE_SEASON_EXPERIENCES) {
    if (!experienceCoverage[experience]) {
      blockers.push(`Add ${experience.replaceAll('-', ' ')} coverage.`);
    }
  }

  for (const device of PRIVATE_SEASON_DEVICES) {
    if (!deviceCoverage[device]) {
      blockers.push(`Add ${device} device coverage.`);
    }
  }

  if (testers.some((tester) =>
    tester.leagueSlotIds.length === 0 ||
    tester.leagueSlotIds.some((slotId) => !activeSlotIds.has(slotId))
  )) {
    blockers.push('Assign every tester alias to at least one active tester league.');
  }

  if (testers.some((tester) => !tester.contactConfirmed)) {
    blockers.push('Confirm an approved external contact path for every tester alias.');
  }

  if (testers.some((tester) => !tester.consentConfirmed)) {
    blockers.push('Confirm beta consent for every tester alias.');
  }

  if (testers.some((tester) => !tester.accountReady)) {
    blockers.push('Confirm every tester account can sign in and is ready.');
  }

  if (testers.some((tester) => !tester.draftRehearsalComplete)) {
    blockers.push('Complete and record a Draft rehearsal for every tester alias.');
  }

  const normalizedAliases = testers.map((tester) => tester.alias.trim().toLocaleLowerCase()).filter(Boolean);
  if (new Set(normalizedAliases).size !== normalizedAliases.length) {
    blockers.push('Give every tester a unique privacy-limited alias.');
  }

  const evidenceBySlot = new Map(input.liveLeagueEvidence.map((item) => [item.slotId, item]));
  const duplicateLeagueIds = new Set<string>();
  const seenLeagueIds = new Set<string>();

  for (const slot of activeLeagues) {
    const normalizedLeagueId = slot.leagueId.trim();
    if (normalizedLeagueId) {
      if (seenLeagueIds.has(normalizedLeagueId)) {
        duplicateLeagueIds.add(normalizedLeagueId);
      }
      seenLeagueIds.add(normalizedLeagueId);
    }
  }

  for (const duplicateLeagueId of duplicateLeagueIds) {
    blockers.push(`Tester league ${duplicateLeagueId} is listed more than once.`);
  }

  for (const slot of activeLeagues) {
    if (!slot.leagueId) {
      blockers.push(`${slot.label} does not have an exact production league ID.`);
      continue;
    }

    const evidence = evidenceBySlot.get(slot.slotId);

    if (!evidence?.exists) {
      blockers.push(`${slot.label} could not be verified in the current project.`);
      continue;
    }

    if (evidence.teamCount < slot.expectedManagerCount) {
      blockers.push(`${slot.label} has ${evidence.teamCount}/${slot.expectedManagerCount} expected managers.`);
    }

    const assignedTesterCount = testers.filter((tester) => tester.leagueSlotIds.includes(slot.slotId)).length;
    if (assignedTesterCount < slot.expectedManagerCount) {
      blockers.push(`${slot.label} has ${assignedTesterCount}/${slot.expectedManagerCount} tester aliases assigned.`);
    }

    if (!evidence.draftScheduled) {
      blockers.push(`${slot.label} does not have a scheduled Draft time.`);
    }

    if (evidence.draftOrderCount < slot.expectedManagerCount) {
      blockers.push(`${slot.label} has an incomplete saved Draft order.`);
    }

    if (!slot.draftRehearsalComplete) {
      blockers.push(`${slot.label} has not completed the planned mixed-device Draft rehearsal.`);
    }
  }

  if (!plan.support.primaryOwner) {
    blockers.push('Assign the primary private-season support owner.');
  }
  if (!plan.support.supportChannelReady) {
    blockers.push('Prepare the tester support channel.');
  }
  if (!plan.support.knownIssuesReady) {
    blockers.push('Confirm the public Known Issues path before the season begins.');
  }
  if (!plan.support.rollbackRehearsed) {
    blockers.push('Complete the exact-release rollback rehearsal.');
  }
  if (!plan.support.deputyAlias || !plan.support.deputyConfirmed) {
    blockers.push('Confirm a deputy communicator alias and role.');
  }
  if (!plan.support.coverageConfirmed) {
    blockers.push('Confirm Draft-week and first-week support coverage.');
  }

  if (!plan.freeze.featureFreezeConfirmed) {
    blockers.push('Confirm the noncritical feature freeze.');
  }
  if (!exactBuildFrozen) {
    blockers.push(`Freeze this exact ${PRIVATE_SEASON_RELEASE_LABEL} / Scoring V${input.build.scoringRulesVersion} / Projection V${input.build.projectionVersion} build.`);
  }
  if (plan.freeze.nonGoals.length === 0) {
    blockers.push('Record at least one tester-season non-goal.');
  }

  if (plan.status === 'planning') {
    blockers.push('Move the plan to Rehearsal before recording an approval.');
  }

  const currentHash = privateSeasonPlanHash(plan);
  const decision = plan.latestDecision;
  const currentDecisionValid = Boolean(
    decision &&
    decision.planRevision === plan.revision &&
    decision.planHash === currentHash &&
    decision.releaseLabel === input.build.releaseLabel &&
    decision.buildId === input.build.buildId,
  );

  if (decision && !currentDecisionValid) {
    advisories.push('The last recorded decision belongs to an older plan revision or build. Record a new decision after review.');
  }

  const readyForApproval = blockers.length === 0 && plan.status === 'rehearsal';
  let status: PrivateSeasonReadiness['status'] = blockers.length > 0
    ? 'blocked'
    : advisories.length > 0
      ? 'needs-attention'
      : 'ready';
  let headline = status === 'ready'
    ? 'Ready for an explicit go/no-go decision'
    : status === 'needs-attention'
      ? 'Core gates are green; review the remaining advisories'
      : 'Private-season approval is blocked';

  if (currentDecisionValid && decision?.outcome === 'approved') {
    status = 'ready';
    headline = 'Private season approved for this exact build';
  } else if (currentDecisionValid && decision?.outcome === 'delayed') {
    status = 'needs-attention';
    headline = 'Private season delayed for this exact build';
  }

  return {
    status,
    headline,
    blockers,
    advisories,
    leagueCount: activeLeagues.length,
    testerCount: testers.length,
    nonFounderCommissionerCount,
    experienceCoverage,
    deviceCoverage,
    liveLeagueEvidence: input.liveLeagueEvidence,
    exactBuildFrozen,
    currentDecisionValid,
    readyForApproval,
  };
}
