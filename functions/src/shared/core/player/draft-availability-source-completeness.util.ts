import { createHash } from 'node:crypto';

export const DRAFT_AVAILABILITY_SOURCE_SCHEMA_VERSION = 2;
export const DRAFT_AVAILABILITY_MAX_ESPN_SOURCE_AGE_MILLISECONDS =
  30 * 60 * 1000;
export const DRAFT_AVAILABILITY_MAX_ESPN_FUTURE_SKEW_MILLISECONDS =
  5 * 60 * 1000;
export const DRAFT_AVAILABILITY_MIN_NHL_SKATERS_PER_TEAM = 12;
export const DRAFT_AVAILABILITY_MIN_NHL_FORWARDS_PER_TEAM = 6;
export const DRAFT_AVAILABILITY_MIN_NHL_DEFENSEMEN_PER_TEAM = 3;
export const DRAFT_NHL_ROSTER_IDENTITY_HASH_SCHEMA_VERSION = 1;

export type DraftAvailabilitySourceCompletenessIssue =
  | 'nhl-roster-coverage-incomplete'
  | 'nhl-roster-identity-changed'
  | 'espn-status-incomplete'
  | 'espn-timestamp-invalid'
  | 'espn-timestamp-stale'
  | 'espn-structure-incomplete'
  | 'espn-team-unrecognized'
  | 'espn-team-duplicate';

export interface DraftAvailabilitySourceCompletenessInput {
  expectedNhlTeamCount: number;
  loadedNhlTeamCount: number;
  failedNhlTeamCount: number;
  espnStatus: string;
  espnTimestamp: string;
  espnInjuriesArrayPresent: boolean;
  espnTeamGroupCount: number;
  espnRecognizedTeamCount: number;
  espnUnrecognizedTeamCount: number;
  espnDuplicateTeamGroupCount: number;
  espnMalformedTeamGroupCount: number;
  espnMalformedInjuryEntryCount: number;
  nowMilliseconds: number;
}

export interface DraftAvailabilitySourceCompletenessResult {
  complete: boolean;
  issues: DraftAvailabilitySourceCompletenessIssue[];
}

export interface DraftNhlTeamRosterCompletenessInput {
  forwardsArrayPresent: boolean;
  defensemenArrayPresent: boolean;
  validForwardCount: number;
  validDefensemanCount: number;
  uniqueSkaterCount: number;
}

export interface DraftNhlRosterIdentity {
  id: number;
  fullName: string;
  position: 'LW' | 'C' | 'RW' | 'D';
  nhlTeamAbbreviation: string;
}

function normalizeDraftRosterIdentityText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

export function isDraftNhlRosterIdentityHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Binds injury-name matching to the exact NHL skater identity universe used
 * by strict pre-Draft Projection generation without persisting player data.
 */
export function createDraftNhlRosterIdentityHash(
  identities: readonly DraftNhlRosterIdentity[],
): string {
  const normalized = identities.map((identity) => {
    if (
      !Number.isSafeInteger(identity.id) ||
      identity.id <= 0 ||
      !identity.fullName.trim() ||
      !/^(LW|C|RW|D)$/.test(identity.position) ||
      !identity.nhlTeamAbbreviation.trim()
    ) {
      throw new Error('Draft NHL roster identity input is invalid.');
    }

    return {
      playerId: identity.id,
      fullName: normalizeDraftRosterIdentityText(identity.fullName),
      position: identity.position,
      teamAbbreviation: identity.nhlTeamAbbreviation.trim().toUpperCase(),
    };
  }).sort((first, second) =>
    first.playerId - second.playerId ||
    first.teamAbbreviation.localeCompare(second.teamAbbreviation) ||
    first.position.localeCompare(second.position) ||
    first.fullName.localeCompare(second.fullName)
  );
  const uniquePlayerIds = new Set(normalized.map((identity) => identity.playerId));

  if (uniquePlayerIds.size !== normalized.length || normalized.length === 0) {
    throw new Error('Draft NHL roster identities must be non-empty and unique.');
  }

  return createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: DRAFT_NHL_ROSTER_IDENTITY_HASH_SCHEMA_VERSION,
      identities: normalized,
    }))
    .digest('hex');
}

export function isDraftNhlTeamRosterComplete(
  input: DraftNhlTeamRosterCompletenessInput,
): boolean {
  if (
    input.forwardsArrayPresent !== true ||
    input.defensemenArrayPresent !== true ||
    !Number.isInteger(input.validForwardCount) ||
    !Number.isInteger(input.validDefensemanCount) ||
    !Number.isInteger(input.uniqueSkaterCount)
  ) {
    return false;
  }

  return input.validForwardCount >=
      DRAFT_AVAILABILITY_MIN_NHL_FORWARDS_PER_TEAM &&
    input.validDefensemanCount >=
      DRAFT_AVAILABILITY_MIN_NHL_DEFENSEMEN_PER_TEAM &&
    input.uniqueSkaterCount >=
      DRAFT_AVAILABILITY_MIN_NHL_SKATERS_PER_TEAM;
}

export type DraftAvailabilityIdentityCompletenessIssue =
  | 'injury-identity-count-invalid'
  | 'injury-identity-ambiguous'
  | 'injury-alias-target-missing';

export interface DraftAvailabilityIdentityCompletenessInput {
  nameNotFoundCount: number;
  ambiguousNameCount: number;
  aliasTargetMissingCount: number;
}

export interface DraftAvailabilityIdentityCompletenessResult {
  complete: boolean;
  issues: DraftAvailabilityIdentityCompletenessIssue[];
  nameNotFoundAdvisoryCount: number;
}

export function evaluateDraftAvailabilityIdentityCompleteness(
  input: DraftAvailabilityIdentityCompletenessInput,
): DraftAvailabilityIdentityCompletenessResult {
  const counts = [
    input.nameNotFoundCount,
    input.ambiguousNameCount,
    input.aliasTargetMissingCount,
  ];

  if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
    return {
      complete: false,
      issues: ['injury-identity-count-invalid'],
      nameNotFoundAdvisoryCount: 0,
    };
  }

  const issues: DraftAvailabilityIdentityCompletenessIssue[] = [];

  if (input.ambiguousNameCount > 0) {
    issues.push('injury-identity-ambiguous');
  }

  if (input.aliasTargetMissingCount > 0) {
    issues.push('injury-alias-target-missing');
  }

  return {
    complete: issues.length === 0,
    issues,
    // D1B deliberately keeps name-not-found entries visible for identity
    // review without guessing. They cannot be applied to a draftable NHL
    // roster asset until a verified identity mapping exists.
    nameNotFoundAdvisoryCount: input.nameNotFoundCount,
  };
}

export function evaluateDraftAvailabilitySourceCompleteness(
  input: DraftAvailabilitySourceCompletenessInput,
): DraftAvailabilitySourceCompletenessResult {
  const issues: DraftAvailabilitySourceCompletenessIssue[] = [];

  if (
    !Number.isInteger(input.expectedNhlTeamCount) ||
    input.expectedNhlTeamCount <= 0 ||
    input.loadedNhlTeamCount !== input.expectedNhlTeamCount ||
    input.failedNhlTeamCount !== 0
  ) {
    issues.push('nhl-roster-coverage-incomplete');
  }

  if (input.espnStatus.toLowerCase() !== 'success') {
    issues.push('espn-status-incomplete');
  }

  const espnTimestampMilliseconds = Date.parse(input.espnTimestamp);

  if (
    !Number.isFinite(input.nowMilliseconds) ||
    !Number.isFinite(espnTimestampMilliseconds)
  ) {
    issues.push('espn-timestamp-invalid');
  } else {
    const ageMilliseconds = input.nowMilliseconds - espnTimestampMilliseconds;

    if (
      ageMilliseconds > DRAFT_AVAILABILITY_MAX_ESPN_SOURCE_AGE_MILLISECONDS ||
      ageMilliseconds < -DRAFT_AVAILABILITY_MAX_ESPN_FUTURE_SKEW_MILLISECONDS
    ) {
      issues.push('espn-timestamp-stale');
    }
  }

  if (
    input.espnInjuriesArrayPresent !== true ||
    !Number.isInteger(input.espnTeamGroupCount) ||
    input.espnTeamGroupCount < 0 ||
    !Number.isInteger(input.espnRecognizedTeamCount) ||
    input.espnRecognizedTeamCount < 0 ||
    !Number.isInteger(input.espnMalformedTeamGroupCount) ||
    input.espnMalformedTeamGroupCount !== 0 ||
    !Number.isInteger(input.espnMalformedInjuryEntryCount) ||
    input.espnMalformedInjuryEntryCount !== 0
  ) {
    issues.push('espn-structure-incomplete');
  }

  if (
    !Number.isInteger(input.espnUnrecognizedTeamCount) ||
    input.espnUnrecognizedTeamCount !== 0 ||
    input.espnRecognizedTeamCount +
      input.espnUnrecognizedTeamCount +
      input.espnDuplicateTeamGroupCount !==
      input.espnTeamGroupCount
  ) {
    issues.push('espn-team-unrecognized');
  }

  if (
    !Number.isInteger(input.espnDuplicateTeamGroupCount) ||
    input.espnDuplicateTeamGroupCount !== 0
  ) {
    issues.push('espn-team-duplicate');
  }

  return {
    complete: issues.length === 0,
    issues,
  };
}
