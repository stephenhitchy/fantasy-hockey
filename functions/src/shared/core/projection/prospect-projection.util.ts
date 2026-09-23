import type { DraftPosition } from '../draft/draft.models';

export const PROSPECT_EVIDENCE_SCHEMA_VERSION = 1;
export const PROSPECT_PROJECTION_MODEL_VERSION = 1;
export const MAX_PROSPECT_EVIDENCE_RECORDS = 250;

export type ProspectProjectionMode = 'disabled' | 'enabled';
export type ProspectRosterStatus =
  | 'nhl-active'
  | 'nhl-call-up'
  | 'training-camp'
  | 'minor-league'
  | 'other';

export interface ProspectTranslationProfile {
  league: string;
  scoringFactor: number;
  shotFactor: number;
  physicalFactor: number;
  timeOnIceFactor: number;
  source: string;
  asOf: string;
  provisional: boolean;
}

export interface ProspectSeasonEvidence {
  league: string;
  season: string;
  competition: 'regular-season' | 'playoffs';
  gamesPlayed: number;
  goals?: number;
  assists?: number;
  shotsOnGoal?: number;
  hits?: number;
  blockedShots?: number;
  powerPlayPoints?: number;
  shortHandedPoints?: number;
  gameWinningGoals?: number;
  overtimeGoals?: number;
  averageTimeOnIceMinutes?: number;
  observedAt: string;
  source: string;
}

export interface ProspectOpportunityScenario {
  label: 'not-in-lineup' | 'limited-role' | 'significant-role';
  probability: number;
  appearanceProbability: number;
  expectedTimeOnIceMinutes?: number;
}

export interface ProspectOpportunityWindow {
  effectiveFrom: string;
  effectiveThrough: string;
  source: string;
  observedAt: string;
  provisional: boolean;
  scenarios: ProspectOpportunityScenario[];
}

export interface ProspectEvidenceRecord {
  playerId: number;
  fullName: string;
  position: Exclude<DraftPosition, 'G'>;
  nhlOrganization: string;
  identityVerified: true;
  rosterStatus: ProspectRosterStatus;
  birthDate?: string;
  draftYear?: number;
  draftSelection?: number;
  defaultAppearanceProbability: number;
  defaultExpectedTimeOnIceMinutes?: number;
  evidenceAsOf: string;
  retrievedAt: string;
  source: string;
  reviewAfter?: string;
  qualityFlags: string[];
  seasons: ProspectSeasonEvidence[];
  opportunity: ProspectOpportunityWindow[];
}

export interface ProspectEvidenceSnapshot {
  schemaVersion: typeof PROSPECT_EVIDENCE_SCHEMA_VERSION;
  prospectModelVersion: typeof PROSPECT_PROJECTION_MODEL_VERSION;
  mode: ProspectProjectionMode;
  snapshotId: string;
  evidenceAsOf: string;
  retrievedAt: string;
  source: string;
  translationProfiles: ProspectTranslationProfile[];
  records: ProspectEvidenceRecord[];
}

export interface ProspectProjectionStatLine {
  gamesPlayed: number;
  goals?: number;
  assists?: number;
  shotsOnGoal?: number;
  hits?: number;
  blockedShots?: number;
  plusMinus?: number;
  powerPlayPoints?: number;
  shortHandedPoints?: number;
  gameWinningGoals?: number;
  overtimeGoals?: number;
  averageTimeOnIceMinutes?: number;
}

export interface ProspectProjectionPrior {
  playerId: number;
  fullName: string;
  position: Exclude<DraftPosition, 'G'>;
  nhlOrganization: string;
  expectedStatsPer82: ProspectProjectionStatLine;
  evidenceConfidence: number;
  translationConfidence: number;
  evidenceSnapshotId: string;
  evidenceAsOf: string;
  evidenceSource: string;
  latestEvidenceSeason: string;
  roleLabel: string;
  roleConfidence: number;
  defaultAppearanceProbability: number;
  opportunity: ProspectOpportunityWindow[];
  observedCategories: string[];
  missingCategories: string[];
  qualityFlags: string[];
  provisional: boolean;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const SEASON_PATTERN = /^\d{4}(?:\d{4}|-\d{2})$/;
const NHL_TEAM_PATTERN = /^[A-Z]{3}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SKATER_POSITIONS = new Set(['LW', 'C', 'RW', 'D']);
const ROSTER_STATUSES = new Set<ProspectRosterStatus>([
  'nhl-active',
  'nhl-call-up',
  'training-camp',
  'minor-league',
  'other',
]);

type TranslatableStatKey = Exclude<
  keyof ProspectProjectionStatLine,
  'gamesPlayed' | 'plusMinus'
>;

const TRANSLATABLE_STAT_KEYS: TranslatableStatKey[] = [
  'goals',
  'assists',
  'shotsOnGoal',
  'hits',
  'blockedShots',
  'powerPlayPoints',
  'shortHandedPoints',
  'gameWinningGoals',
  'overtimeGoals',
  'averageTimeOnIceMinutes',
];

const SCORING_KEYS = new Set<TranslatableStatKey>([
  'goals',
  'assists',
  'powerPlayPoints',
  'shortHandedPoints',
  'gameWinningGoals',
  'overtimeGoals',
]);
const PHYSICAL_KEYS = new Set<TranslatableStatKey>(['hits', 'blockedShots']);

function fail(path: string, message: string): never {
  throw new Error(`Invalid prospect evidence at ${path}: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object');
  }

  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  path: string,
  maxLength = 160,
): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    fail(path, `expected a non-empty string no longer than ${maxLength} characters`);
  }

  return value.trim();
}

function finiteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(path, `expected a finite number from ${minimum} through ${maximum}`);
  }

  return value;
}

function optionalFiniteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return finiteNumber(value, path, minimum, maximum);
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  const parsed = finiteNumber(value, path, minimum, maximum);

  if (!Number.isInteger(parsed)) {
    fail(path, 'expected an integer');
  }

  return parsed;
}

function isoDate(value: unknown, path: string): string {
  const parsed = requiredString(value, path, 10);

  if (!ISO_DATE_PATTERN.test(parsed) || Number.isNaN(Date.parse(`${parsed}T12:00:00Z`))) {
    fail(path, 'expected a valid YYYY-MM-DD date');
  }

  return parsed;
}

function optionalIsoDate(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return isoDate(value, path);
}

function isoTimestamp(value: unknown, path: string): string {
  const parsed = requiredString(value, path, 40);

  if (!ISO_TIMESTAMP_PATTERN.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    fail(path, 'expected a valid ISO timestamp');
  }

  return new Date(parsed).toISOString();
}

function normalizeTranslationProfile(
  value: unknown,
  path: string,
): ProspectTranslationProfile {
  const record = asRecord(value, path);
  const league = requiredString(record['league'], `${path}.league`, 32).toUpperCase();

  return {
    league,
    scoringFactor: finiteNumber(record['scoringFactor'], `${path}.scoringFactor`, 0.05, 1.5),
    shotFactor: finiteNumber(record['shotFactor'], `${path}.shotFactor`, 0.05, 1.5),
    physicalFactor: finiteNumber(record['physicalFactor'], `${path}.physicalFactor`, 0.05, 1.5),
    timeOnIceFactor: finiteNumber(record['timeOnIceFactor'], `${path}.timeOnIceFactor`, 0.5, 1.5),
    source: requiredString(record['source'], `${path}.source`),
    asOf: isoDate(record['asOf'], `${path}.asOf`),
    provisional: record['provisional'] === true,
  };
}

function normalizeSeasonEvidence(value: unknown, path: string): ProspectSeasonEvidence {
  const record = asRecord(value, path);
  const competition = record['competition'];

  if (competition !== 'regular-season' && competition !== 'playoffs') {
    fail(`${path}.competition`, 'expected regular-season or playoffs');
  }

  const season = requiredString(record['season'], `${path}.season`, 9);

  if (!SEASON_PATTERN.test(season)) {
    fail(`${path}.season`, 'expected YYYY-YYYY or YYYYYYYY season format');
  }

  return {
    league: requiredString(record['league'], `${path}.league`, 32).toUpperCase(),
    season,
    competition,
    gamesPlayed: integer(record['gamesPlayed'], `${path}.gamesPlayed`, 1, 200),
    goals: optionalFiniteNumber(record['goals'], `${path}.goals`, 0, 300),
    assists: optionalFiniteNumber(record['assists'], `${path}.assists`, 0, 400),
    shotsOnGoal: optionalFiniteNumber(record['shotsOnGoal'], `${path}.shotsOnGoal`, 0, 1200),
    hits: optionalFiniteNumber(record['hits'], `${path}.hits`, 0, 1200),
    blockedShots: optionalFiniteNumber(record['blockedShots'], `${path}.blockedShots`, 0, 1200),
    powerPlayPoints: optionalFiniteNumber(record['powerPlayPoints'], `${path}.powerPlayPoints`, 0, 300),
    shortHandedPoints: optionalFiniteNumber(record['shortHandedPoints'], `${path}.shortHandedPoints`, 0, 100),
    gameWinningGoals: optionalFiniteNumber(record['gameWinningGoals'], `${path}.gameWinningGoals`, 0, 100),
    overtimeGoals: optionalFiniteNumber(record['overtimeGoals'], `${path}.overtimeGoals`, 0, 100),
    averageTimeOnIceMinutes: optionalFiniteNumber(
      record['averageTimeOnIceMinutes'],
      `${path}.averageTimeOnIceMinutes`,
      1,
      40,
    ),
    observedAt: isoDate(record['observedAt'], `${path}.observedAt`),
    source: requiredString(record['source'], `${path}.source`),
  };
}

function normalizeScenario(value: unknown, path: string): ProspectOpportunityScenario {
  const record = asRecord(value, path);
  const label = record['label'];

  if (label !== 'not-in-lineup' && label !== 'limited-role' && label !== 'significant-role') {
    fail(`${path}.label`, 'expected a supported role label');
  }

  return {
    label,
    probability: finiteNumber(record['probability'], `${path}.probability`, 0, 1),
    appearanceProbability: finiteNumber(
      record['appearanceProbability'],
      `${path}.appearanceProbability`,
      0,
      1,
    ),
    expectedTimeOnIceMinutes: optionalFiniteNumber(
      record['expectedTimeOnIceMinutes'],
      `${path}.expectedTimeOnIceMinutes`,
      1,
      35,
    ),
  };
}

function normalizeOpportunityWindow(
  value: unknown,
  path: string,
): ProspectOpportunityWindow {
  const record = asRecord(value, path);
  const effectiveFrom = isoDate(record['effectiveFrom'], `${path}.effectiveFrom`);
  const effectiveThrough = isoDate(record['effectiveThrough'], `${path}.effectiveThrough`);

  if (effectiveThrough < effectiveFrom) {
    fail(`${path}.effectiveThrough`, 'must not be earlier than effectiveFrom');
  }

  if (!Array.isArray(record['scenarios']) || record['scenarios'].length < 1) {
    fail(`${path}.scenarios`, 'expected at least one role scenario');
  }

  const scenarios = record['scenarios'].map((entry, index) =>
    normalizeScenario(entry, `${path}.scenarios[${index}]`)
  ).sort((first, second) => first.label.localeCompare(second.label));
  const labels = new Set(scenarios.map((scenario) => scenario.label));

  if (labels.size !== scenarios.length) {
    fail(`${path}.scenarios`, 'role labels must be unique within a window');
  }

  const totalProbability = scenarios.reduce((total, scenario) => total + scenario.probability, 0);

  if (Math.abs(totalProbability - 1) > 0.000001) {
    fail(`${path}.scenarios`, 'scenario probabilities must total exactly 1');
  }

  return {
    effectiveFrom,
    effectiveThrough,
    source: requiredString(record['source'], `${path}.source`),
    observedAt: isoDate(record['observedAt'], `${path}.observedAt`),
    provisional: record['provisional'] === true,
    scenarios,
  };
}

function normalizeEvidenceRecord(value: unknown, path: string): ProspectEvidenceRecord {
  const record = asRecord(value, path);
  const position = record['position'];
  const rosterStatus = record['rosterStatus'];
  const evidenceAsOf = isoDate(record['evidenceAsOf'], `${path}.evidenceAsOf`);
  const retrievedAt = isoTimestamp(record['retrievedAt'], `${path}.retrievedAt`);
  const reviewAfter = optionalIsoDate(record['reviewAfter'], `${path}.reviewAfter`);

  if (evidenceAsOf > retrievedAt.slice(0, 10)) {
    fail(`${path}.evidenceAsOf`, 'must not be later than retrievedAt');
  }

  if (reviewAfter && reviewAfter < evidenceAsOf) {
    fail(`${path}.reviewAfter`, 'must not be earlier than evidenceAsOf');
  }

  if (typeof position !== 'string' || !SKATER_POSITIONS.has(position)) {
    fail(`${path}.position`, 'expected LW, C, RW, or D');
  }

  if (typeof rosterStatus !== 'string' || !ROSTER_STATUSES.has(rosterStatus as ProspectRosterStatus)) {
    fail(`${path}.rosterStatus`, 'expected a supported roster status');
  }

  if (record['identityVerified'] !== true) {
    fail(`${path}.identityVerified`, 'must be true before evidence can affect projections');
  }

  const nhlOrganization = requiredString(
    record['nhlOrganization'],
    `${path}.nhlOrganization`,
    3,
  ).toUpperCase();

  if (!NHL_TEAM_PATTERN.test(nhlOrganization)) {
    fail(`${path}.nhlOrganization`, 'expected a three-letter NHL abbreviation');
  }

  if (!Array.isArray(record['seasons']) || record['seasons'].length > 6) {
    fail(`${path}.seasons`, 'expected an array with no more than six seasons');
  }

  const seasons = record['seasons'].map((entry, index) =>
    normalizeSeasonEvidence(entry, `${path}.seasons[${index}]`)
  );
  const seasonKeys = new Set<string>();

  for (const season of seasons) {
    const key = `${season.league}:${season.season}:${season.competition}`;

    if (seasonKeys.has(key)) {
      fail(`${path}.seasons`, `contains duplicate competition ${key}`);
    }

    seasonKeys.add(key);

    if (season.observedAt > evidenceAsOf) {
      fail(`${path}.seasons`, `${key} was observed after evidenceAsOf`);
    }
  }

  if (!Array.isArray(record['opportunity']) || record['opportunity'].length > 16) {
    fail(`${path}.opportunity`, 'expected an array with no more than 16 windows');
  }

  const opportunity = record['opportunity'].map((entry, index) =>
    normalizeOpportunityWindow(entry, `${path}.opportunity[${index}]`)
  ).sort((first, second) => first.effectiveFrom.localeCompare(second.effectiveFrom));

  for (let index = 1; index < opportunity.length; index += 1) {
    if (opportunity[index].effectiveFrom <= opportunity[index - 1].effectiveThrough) {
      fail(`${path}.opportunity`, 'date windows must not overlap');
    }
  }

  if (opportunity.some((window) => window.observedAt > evidenceAsOf)) {
    fail(`${path}.opportunity`, 'contains a window observed after evidenceAsOf');
  }

  const flags = Array.isArray(record['qualityFlags'])
    ? record['qualityFlags'].map((entry, index) =>
        requiredString(entry, `${path}.qualityFlags[${index}]`, 80)
      )
    : fail(`${path}.qualityFlags`, 'expected an array');

  return {
    playerId: integer(record['playerId'], `${path}.playerId`, 1, 99_999_999),
    fullName: requiredString(record['fullName'], `${path}.fullName`, 100),
    position: position as ProspectEvidenceRecord['position'],
    nhlOrganization,
    identityVerified: true,
    rosterStatus: rosterStatus as ProspectRosterStatus,
    birthDate: optionalIsoDate(record['birthDate'], `${path}.birthDate`),
    draftYear: record['draftYear'] === undefined
      ? undefined
      : integer(record['draftYear'], `${path}.draftYear`, 1963, 2200),
    draftSelection: record['draftSelection'] === undefined
      ? undefined
      : integer(record['draftSelection'], `${path}.draftSelection`, 1, 400),
    defaultAppearanceProbability: finiteNumber(
      record['defaultAppearanceProbability'],
      `${path}.defaultAppearanceProbability`,
      0,
      1,
    ),
    defaultExpectedTimeOnIceMinutes: optionalFiniteNumber(
      record['defaultExpectedTimeOnIceMinutes'],
      `${path}.defaultExpectedTimeOnIceMinutes`,
      1,
      35,
    ),
    evidenceAsOf,
    retrievedAt,
    source: requiredString(record['source'], `${path}.source`),
    reviewAfter,
    qualityFlags: [...new Set(flags)].sort(),
    seasons: seasons.sort((first, second) =>
      second.season.localeCompare(first.season) ||
      first.league.localeCompare(second.league)
    ),
    opportunity,
  };
}

/**
 * Strictly validates an offline/admin-authored evidence snapshot. An enabled
 * malformed snapshot fails closed so a projection refresh cannot silently
 * reinterpret missing prospect fields as observed zeroes.
 */
export function normalizeProspectEvidenceSnapshot(value: unknown): ProspectEvidenceSnapshot {
  const record = asRecord(value, 'root');

  if (record['schemaVersion'] !== PROSPECT_EVIDENCE_SCHEMA_VERSION) {
    fail('root.schemaVersion', `expected ${PROSPECT_EVIDENCE_SCHEMA_VERSION}`);
  }

  if (record['prospectModelVersion'] !== PROSPECT_PROJECTION_MODEL_VERSION) {
    fail('root.prospectModelVersion', `expected ${PROSPECT_PROJECTION_MODEL_VERSION}`);
  }

  const mode = record['mode'];

  if (mode !== 'disabled' && mode !== 'enabled') {
    fail('root.mode', 'expected disabled or enabled');
  }

  const snapshotId = requiredString(record['snapshotId'], 'root.snapshotId', 120);

  if (!SAFE_ID_PATTERN.test(snapshotId)) {
    fail('root.snapshotId', 'contains unsupported characters');
  }

  const evidenceAsOf = isoDate(record['evidenceAsOf'], 'root.evidenceAsOf');
  const retrievedAt = isoTimestamp(record['retrievedAt'], 'root.retrievedAt');

  if (evidenceAsOf > retrievedAt.slice(0, 10)) {
    fail('root.evidenceAsOf', 'must not be later than retrievedAt');
  }

  const base: Omit<ProspectEvidenceSnapshot, 'translationProfiles' | 'records'> = {
    schemaVersion: PROSPECT_EVIDENCE_SCHEMA_VERSION,
    prospectModelVersion: PROSPECT_PROJECTION_MODEL_VERSION,
    mode,
    snapshotId,
    evidenceAsOf,
    retrievedAt,
    source: requiredString(record['source'], 'root.source'),
  };

  // A disabled document is the rollback switch. Its stale payload cannot block
  // projection generation, and none of that payload is trusted or consumed.
  if (mode === 'disabled') {
    return {
      ...base,
      translationProfiles: [],
      records: [],
    };
  }

  if (!Array.isArray(record['translationProfiles'])) {
    fail('root.translationProfiles', 'expected an array');
  }

  const translationProfiles = record['translationProfiles'].map((entry, index) =>
    normalizeTranslationProfile(entry, `root.translationProfiles[${index}]`)
  );
  const translationsByLeague = new Map<string, ProspectTranslationProfile>();

  for (const profile of translationProfiles) {
    if (translationsByLeague.has(profile.league)) {
      fail('root.translationProfiles', `contains duplicate league ${profile.league}`);
    }

    translationsByLeague.set(profile.league, profile);

    if (profile.asOf > evidenceAsOf) {
      fail('root.translationProfiles', `${profile.league} was calibrated after evidenceAsOf`);
    }
  }

  if (!Array.isArray(record['records']) || record['records'].length > MAX_PROSPECT_EVIDENCE_RECORDS) {
    fail('root.records', `expected no more than ${MAX_PROSPECT_EVIDENCE_RECORDS} records`);
  }

  const records = record['records'].map((entry, index) =>
    normalizeEvidenceRecord(entry, `root.records[${index}]`)
  );
  const playerIds = new Set<number>();

  for (const prospect of records) {
    if (playerIds.has(prospect.playerId)) {
      fail('root.records', `contains duplicate playerId ${prospect.playerId}`);
    }

    playerIds.add(prospect.playerId);

    if (prospect.evidenceAsOf > evidenceAsOf) {
      fail('root.records', `player ${prospect.playerId} was observed after snapshot evidenceAsOf`);
    }

    for (const season of prospect.seasons) {
      if (
        season.competition === 'regular-season' &&
        !translationsByLeague.has(season.league)
      ) {
        fail(
          'root.translationProfiles',
          `is missing the ${season.league} profile required by player ${prospect.playerId}`,
        );
      }
    }
  }

  return {
    ...base,
    translationProfiles: [...translationProfiles].sort((first, second) =>
      first.league.localeCompare(second.league)
    ),
    records: [...records].sort((first, second) => first.playerId - second.playerId),
  };
}

function translationFactor(
  profile: ProspectTranslationProfile,
  key: TranslatableStatKey,
): number {
  if (key === 'shotsOnGoal') {
    return profile.shotFactor;
  }

  if (PHYSICAL_KEYS.has(key)) {
    return profile.physicalFactor;
  }

  if (key === 'averageTimeOnIceMinutes') {
    return profile.timeOnIceFactor;
  }

  if (SCORING_KEYS.has(key)) {
    return profile.scoringFactor;
  }

  return 1;
}

function latestRoleSummary(record: ProspectEvidenceRecord): {
  label: string;
  confidence: number;
  expectedTimeOnIceMinutes: number | undefined;
  provisional: boolean;
} {
  const window = record.opportunity.at(-1);

  if (!window) {
    return {
      label: 'Role unknown',
      confidence: 25,
      expectedTimeOnIceMinutes: record.defaultExpectedTimeOnIceMinutes,
      provisional: true,
    };
  }

  const appearanceProbability = window.scenarios.reduce(
    (total, scenario) => total + scenario.probability * scenario.appearanceProbability,
    0,
  );
  const appearanceWeightedToi = window.scenarios.reduce(
    (total, scenario) => total +
      scenario.probability *
      scenario.appearanceProbability *
      (scenario.expectedTimeOnIceMinutes ?? 0),
    0,
  );
  const role = [...window.scenarios].sort(
    (first, second) => second.probability - first.probability,
  )[0];

  return {
    label: role.label === 'significant-role'
      ? 'Significant NHL role'
      : role.label === 'limited-role'
        ? 'Limited NHL role'
        : 'Not expected in NHL lineup',
    confidence: Math.round(Math.max(...window.scenarios.map((scenario) => scenario.probability)) * 100),
    expectedTimeOnIceMinutes: appearanceProbability > 0 && appearanceWeightedToi > 0
      ? appearanceWeightedToi / appearanceProbability
      : record.defaultExpectedTimeOnIceMinutes,
    provisional: window.provisional,
  };
}

/**
 * Translates only observed regular-season categories. Unknown categories are
 * deliberately omitted so Projection V11 can apply its documented position
 * prior instead of treating missing provider coverage as a real zero.
 */
export function buildProspectProjectionPrior(
  snapshot: ProspectEvidenceSnapshot,
  record: ProspectEvidenceRecord,
): ProspectProjectionPrior | null {
  if (snapshot.mode !== 'enabled') {
    return null;
  }

  const translations = new Map(
    snapshot.translationProfiles.map((profile) => [profile.league, profile] as const),
  );
  const seasons = record.seasons.filter((season) => season.competition === 'regular-season');

  if (seasons.length === 0) {
    return null;
  }

  const expectedStatsPer82: ProspectProjectionStatLine = { gamesPlayed: 82 };
  const observedCategories: string[] = [];

  for (const key of TRANSLATABLE_STAT_KEYS) {
    let weightedRate = 0;
    let totalWeight = 0;

    seasons.forEach((season, index) => {
      const value = season[key];
      const profile = translations.get(season.league);

      if (typeof value !== 'number' || !profile) {
        return;
      }

      const recencyWeight = [1, 0.55, 0.3, 0.15, 0.1, 0.08][index] ?? 0.05;
      const sampleWeight = Math.sqrt(Math.min(1, season.gamesPlayed / 60));
      const weight = recencyWeight * sampleWeight;
      const perGameValue = key === 'averageTimeOnIceMinutes'
        ? value
        : value / season.gamesPlayed;

      weightedRate += perGameValue * translationFactor(profile, key) * weight;
      totalWeight += weight;
    });

    if (totalWeight > 0) {
      const translatedRate = weightedRate / totalWeight;
      expectedStatsPer82[key] = key === 'averageTimeOnIceMinutes'
        ? translatedRate
        : translatedRate * 82;
      observedCategories.push(key);
    }
  }

  if (observedCategories.length === 0) {
    return null;
  }

  const role = latestRoleSummary(record);

  if (typeof role.expectedTimeOnIceMinutes === 'number') {
    expectedStatsPer82.averageTimeOnIceMinutes = role.expectedTimeOnIceMinutes;
  }

  const regularSeasonGames = seasons.reduce(
    (total, season) => total + season.gamesPlayed,
    0,
  );
  const categoryCoverage = observedCategories.length / TRANSLATABLE_STAT_KEYS.length;
  const draftPedigreeConfidence = typeof record.draftSelection === 'number'
    ? Math.max(0, 4 - Math.floor((record.draftSelection - 1) / 64))
    : 0;
  const qualityPenalty = Math.min(12, record.qualityFlags.length * 2);
  const evidenceConfidence = Math.max(
    25,
    Math.min(
      82,
      32 +
        Math.min(1, regularSeasonGames / 100) * 25 +
        categoryCoverage * 22 +
        draftPedigreeConfidence -
        qualityPenalty,
    ),
  );
  const provisional = snapshot.translationProfiles.some((profile) => profile.provisional) ||
    role.provisional;

  return {
    playerId: record.playerId,
    fullName: record.fullName,
    position: record.position,
    nhlOrganization: record.nhlOrganization,
    expectedStatsPer82,
    evidenceConfidence: Number(evidenceConfidence.toFixed(1)),
    translationConfidence: Number(
      Math.max(20, Math.min(85, evidenceConfidence - (provisional ? 10 : 0))).toFixed(1),
    ),
    evidenceSnapshotId: snapshot.snapshotId,
    evidenceAsOf: record.evidenceAsOf,
    evidenceSource: record.source,
    latestEvidenceSeason: seasons[0].season,
    roleLabel: role.label,
    roleConfidence: role.confidence,
    defaultAppearanceProbability: record.defaultAppearanceProbability,
    opportunity: record.opportunity,
    observedCategories: [...observedCategories].sort(),
    missingCategories: TRANSLATABLE_STAT_KEYS
      .filter((key) => !observedCategories.includes(key))
      .sort(),
    qualityFlags: record.qualityFlags,
    provisional,
  };
}

export function buildProspectProjectionPriorMap(
  snapshot: ProspectEvidenceSnapshot,
): ReadonlyMap<number, ProspectProjectionPrior> {
  const priors = new Map<number, ProspectProjectionPrior>();

  for (const record of snapshot.records) {
    const prior = buildProspectProjectionPrior(snapshot, record);

    if (prior) {
      priors.set(record.playerId, prior);
    }
  }

  return priors;
}

export function getProspectAppearanceProbability(
  prior: ProspectProjectionPrior,
  gameDate?: string | null,
): number {
  const window = gameDate
    ? prior.opportunity.find(
        (candidate) => candidate.effectiveFrom <= gameDate && candidate.effectiveThrough >= gameDate,
      )
    : prior.opportunity.at(-1);

  if (!window) {
    return prior.defaultAppearanceProbability;
  }

  return window.scenarios.reduce(
    (total, scenario) => total + scenario.probability * scenario.appearanceProbability,
    0,
  );
}

export function calculateExpectedProspectWindowContribution(input: {
  conditionalPointsPerAppearance: number;
  appearanceProbabilities: number[];
}): number {
  if (
    !Number.isFinite(input.conditionalPointsPerAppearance) ||
    input.conditionalPointsPerAppearance < 0
  ) {
    throw new Error('Conditional prospect points must be a finite non-negative number.');
  }

  return input.appearanceProbabilities.reduce((total, probability, index) => {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Prospect appearance probability ${index + 1} must be between 0 and 1.`);
    }

    return total + input.conditionalPointsPerAppearance * probability;
  }, 0);
}
