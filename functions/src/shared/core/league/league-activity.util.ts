import { createHash } from 'node:crypto';

export const LEAGUE_ACTIVITY_SCHEMA_VERSION = 1;
export const LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH = 72;
export const LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH = 500;
export const LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES = 8;

export type LeagueActivitySourceKind =
  | 'audit'
  | 'draft-pick'
  | 'transaction'
  | 'matchup'
  | 'commissioner-availability'
  | 'draft-control'
  | 'announcement'
  | 'cycle-recap';
export type LeagueActivityCategory =
  | 'league'
  | 'draft'
  | 'roster'
  | 'matchup'
  | 'commissioner'
  | 'announcement'
  | 'recap';

export type LeagueActivityEventType =
  | 'league-created'
  | 'member-joined'
  | 'member-removed'
  | 'league-presentation-updated'
  | 'draft-settings-saved'
  | 'draft-pick'
  | 'add-drop'
  | 'add-open-slot'
  | 'move-to-ir'
  | 'activate-from-ir'
  | 'drop-to-waivers'
  | 'waiver-award'
  | 'waiver-cleared'
  | 'slot-move-activated'
  | 'active-bench-swap-activated'
  | 'move-bench-to-ir'
  | 'activate-ir-to-bench'
  | 'matchup-result'
  | 'commissioner-availability-override-set'
  | 'commissioner-availability-override-cleared'
  | 'commissioner-draft-opened'
  | 'commissioner-draft-clock-paused'
  | 'commissioner-draft-clock-resumed'
  | 'commissioner-announcement'
  | 'matchup-round-recap';

export type LeagueActivityAvailabilityStatus =
  | 'active'
  | 'day-to-day'
  | 'out'
  | 'injured-reserve'
  | 'long-term-injured-reserve'
  | 'suspended'
  | 'personal-leave'
  | 'unknown';

export interface LeagueActivityAssetSummary {
  name: string;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G' | null;
  assetType: 'skater' | 'team-goalie-unit' | null;
}

export interface LeagueActivityRecapPerformer {
  ownerId: string;
  asset: LeagueActivityAssetSummary;
}

export interface LeagueActivityRecapPickup {
  ownerId: string;
  asset: LeagueActivityAssetSummary;
}

export interface SanitizedLeagueActivity {
  schemaVersion: typeof LEAGUE_ACTIVITY_SCHEMA_VERSION;
  category: LeagueActivityCategory;
  eventType: LeagueActivityEventType;
  ownerId: string | null;
  primaryAsset: LeagueActivityAssetSummary | null;
  secondaryAsset: LeagueActivityAssetSummary | null;
  overallPick: number | null;
  round: number | null;
  selectionType: 'manual' | 'queue' | 'automatic' | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
  matchupPhase?: 'regular_season' | 'playoffs';
  matchupCycleNumber?: number;
  teamAOwnerId?: string;
  teamBOwnerId?: string;
  teamAScore?: number;
  teamBScore?: number;
  winnerOwnerId?: string | null;
  playoffBracketType?: 'championship' | 'consolation' | null;
  playoffRoundNumber?: number | null;
  winnerPlace?: number | null;
  loserPlace?: number | null;
  tieBrokenByHigherSeed?: boolean;
  availabilityPlayerName?: string | null;
  availabilityStatus?: LeagueActivityAvailabilityStatus | null;
  announcementTitle?: string | null;
  announcementBody?: string | null;
  recapCycleNumber?: number;
  recapMatchupCount?: number;
  recapTopScoreOwnerIds?: string[];
  recapTopScore?: number;
  recapClosestTeamAOwnerId?: string;
  recapClosestTeamBOwnerId?: string;
  recapClosestWinnerOwnerId?: string | null;
  recapClosestMargin?: number;
  recapNewLeagueHighScore?: boolean;
  recapPreviousLeagueHighScore?: number | null;
  recapTopPerformers?: LeagueActivityRecapPerformer[];
  recapTopPerformerScore?: number;
  recapTopPerformerTieCount?: number;
  recapTopPickups?: LeagueActivityRecapPickup[];
  recapTopPickupScore?: number;
  recapTopPickupTieCount?: number;
  recapUpsetWinnerOwnerId?: string;
  recapUpsetLoserOwnerId?: string;
  recapUpsetProjectionGap?: number;
  recapUpsetWinnerProjection?: number;
  recapUpsetLoserProjection?: number;
}

const PUBLIC_AUDIT_ACTIONS = new Set<LeagueActivityEventType>([
  'league-created',
  'member-joined',
  'member-removed',
  'league-presentation-updated',
  'draft-settings-saved',
]);

const PUBLIC_TRANSACTION_TYPES = new Set<LeagueActivityEventType>([
  'add-drop',
  'add-open-slot',
  'move-to-ir',
  'activate-from-ir',
  'drop-to-waivers',
  'waiver-award',
  'waiver-cleared',
  'slot-move-activated',
  'active-bench-swap-activated',
  'move-bench-to-ir',
  'activate-ir-to-bench',
]);

const TRANSACTION_TYPE_ALIASES = new Map<string, LeagueActivityEventType>([
  ['queue-waiver-award', 'waiver-award'],
]);

const SUPPORTED_POSITIONS = new Set(['LW', 'C', 'RW', 'D', 'G']);
const SUPPORTED_SELECTION_TYPES = new Set(['manual', 'queue', 'automatic']);
const SUPPORTED_AVAILABILITY_STATUSES = new Set<LeagueActivityAvailabilityStatus>([
  'active',
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
  'unknown',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asBoundedString(value: unknown, maximumLength = 100): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximumLength)
    : '';
}


function stripUnsafeAnnouncementCharacters(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
}

export function normalizeLeagueAnnouncementText(value: unknown): {
  title: string;
  body: string;
  valid: boolean;
} {
  const source = asRecord(value);
  const rawTitle = typeof source['title'] === 'string'
    ? stripUnsafeAnnouncementCharacters(source['title'])
    : '';
  const rawBody = typeof source['body'] === 'string'
    ? stripUnsafeAnnouncementCharacters(source['body'])
    : '';
  const title = rawTitle.trim().replace(/\s+/g, ' ');
  const bodyLines = rawBody
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, ' ').trim().replace(/[ ]{2,}/g, ' '));

  while (bodyLines.length > 0 && !bodyLines[0]) {
    bodyLines.shift();
  }

  while (bodyLines.length > 0 && !bodyLines[bodyLines.length - 1]) {
    bodyLines.pop();
  }

  const body = bodyLines.join('\n');
  const valid = title.length > 0 &&
    title.length <= LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH &&
    body.length > 0 &&
    body.length <= LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH &&
    bodyLines.length <= LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES;

  return { title, body, valid };
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asBoundedScore(value: unknown): number | null {
  return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= -100_000 &&
      value <= 100_000
    ? value
    : null;
}

function asPosition(value: unknown): LeagueActivityAssetSummary['position'] {
  const position = asBoundedString(value, 3).toUpperCase();
  return SUPPORTED_POSITIONS.has(position)
    ? position as LeagueActivityAssetSummary['position']
    : null;
}

function sanitizeOwnerId(value: unknown): string | null {
  return asBoundedString(value, 128) || null;
}

function sanitizeEffectiveLabel(value: unknown): string | null {
  const label = asBoundedString(value, 80);

  if (!label) {
    return null;
  }

  const matchup = label.match(/^(?:Cycle|Matchup)\s+([1-9][0-9]{0,3})$/i);

  if (matchup) {
    return `Cycle ${matchup[1]}`;
  }

  const playoffWindow = label.match(/^Playoff Window\s+([1-9][0-9]{0,3})$/i);

  if (playoffWindow) {
    return `Playoff Window ${playoffWindow[1]}`;
  }

  return /^After current slot window$/i.test(label)
    ? 'After current slot window'
    : null;
}

function sanitizeAsset(value: unknown): LeagueActivityAssetSummary | null {
  const source = asRecord(value);
  const assetType = asBoundedString(source['assetType'], 32);
  const position = asPosition(source['position']);

  if (assetType === 'skater') {
    const player = asRecord(source['player']);
    const name = asBoundedString(player['fullName'], 80);

    return name
      ? {
          name,
          position,
          assetType: 'skater',
        }
      : null;
  }

  if (assetType === 'team-goalie-unit') {
    const teamName = asBoundedString(source['teamName'], 80);
    const teamAbbreviation = asBoundedString(source['teamAbbreviation'], 8).toUpperCase();
    const name = teamName || (teamAbbreviation ? `${teamAbbreviation} Goalie Unit` : '');

    return name
      ? {
          name,
          position: 'G',
          assetType: 'team-goalie-unit',
        }
      : null;
  }

  return null;
}

function baseActivity(
  category: LeagueActivityCategory,
  eventType: LeagueActivityEventType,
  ownerId: string | null,
): SanitizedLeagueActivity {
  return {
    schemaVersion: LEAGUE_ACTIVITY_SCHEMA_VERSION,
    category,
    eventType,
    ownerId,
    primaryAsset: null,
    secondaryAsset: null,
    overallPick: null,
    round: null,
    selectionType: null,
    effectiveCycleNumber: null,
    effectiveLabel: null,
  };
}

export function getLeagueActivityFingerprint(
  sourceKind: LeagueActivitySourceKind,
  sourceDocumentId: string,
): string {
  return createHash('sha256')
    .update(`rinkrat-league-activity:${sourceKind}:${sourceDocumentId}`)
    .digest('hex')
    .slice(0, 40);
}

export function getLeagueActivityDocumentId(
  sourceKind: LeagueActivitySourceKind,
  sourceDocumentId: string,
): string {
  return `activity-${getLeagueActivityFingerprint(sourceKind, sourceDocumentId)}`;
}

export function isPublicLeagueActivityTransactionType(value: unknown): boolean {
  const transactionType = asBoundedString(value, 48);
  const normalizedType = TRANSACTION_TYPE_ALIASES.get(transactionType) ?? transactionType;
  return PUBLIC_TRANSACTION_TYPES.has(normalizedType as LeagueActivityEventType);
}

export function buildAuditLeagueActivity(
  value: unknown,
): SanitizedLeagueActivity | null {
  const source = asRecord(value);
  const action = asBoundedString(source['action'], 64) as LeagueActivityEventType;

  if (!PUBLIC_AUDIT_ACTIONS.has(action)) {
    return null;
  }

  if (action === 'league-presentation-updated' && source['changed'] !== true) {
    return null;
  }

  return baseActivity('league', action, sanitizeOwnerId(source['actorId']));
}

export function buildCommissionerAvailabilityLeagueActivity(
  beforeValue: unknown,
  afterValue: unknown,
  commissionerIdValue: unknown,
): SanitizedLeagueActivity | null {
  const beforeSource = asRecord(beforeValue);
  const afterSource = asRecord(afterValue);
  const hasBefore = Object.keys(beforeSource).length > 0;
  const hasAfter = Object.keys(afterSource).length > 0;
  const commissionerId = sanitizeOwnerId(commissionerIdValue);
  const source = hasAfter ? afterSource : beforeSource;
  const ownerId = sanitizeOwnerId(source['updatedBy']);
  const playerName = asBoundedString(source['playerName'], 80);

  if (
    !commissionerId ||
    !ownerId ||
    ownerId !== commissionerId ||
    source['source'] !== 'commissioner' ||
    !playerName ||
    (!hasBefore && !hasAfter)
  ) {
    return null;
  }

  if (!hasAfter) {
    const activity = baseActivity(
      'commissioner',
      'commissioner-availability-override-cleared',
      commissionerId,
    );
    activity.availabilityPlayerName = playerName;
    activity.availabilityStatus = null;
    return activity;
  }

  const status = asBoundedString(
    afterSource['status'],
    40,
  ) as LeagueActivityAvailabilityStatus;

  if (!SUPPORTED_AVAILABILITY_STATUSES.has(status)) {
    return null;
  }

  if (
    hasBefore &&
    beforeSource['status'] === afterSource['status'] &&
    beforeSource['irEligible'] === afterSource['irEligible']
  ) {
    // Commissioner notes remain outside League Wire. A note-only edit should
    // not create social noise or imply that the competitive status changed.
    return null;
  }

  const activity = baseActivity(
    'commissioner',
    'commissioner-availability-override-set',
    commissionerId,
  );
  activity.availabilityPlayerName = playerName;
  activity.availabilityStatus = status;
  return activity;
}


export function buildCommissionerAnnouncementLeagueActivity(
  value: unknown,
  commissionerIdValue: unknown,
): SanitizedLeagueActivity | null {
  const source = asRecord(value);
  const commissionerId = sanitizeOwnerId(commissionerIdValue);
  const ownerId = sanitizeOwnerId(source['ownerId']);
  const announcement = normalizeLeagueAnnouncementText(source);

  if (!commissionerId || ownerId !== commissionerId || !announcement.valid) {
    return null;
  }

  const activity = baseActivity(
    'announcement',
    'commissioner-announcement',
    commissionerId,
  );
  activity.announcementTitle = announcement.title;
  activity.announcementBody = announcement.body;
  return activity;
}

export function buildCommissionerDraftControlLeagueActivity(
  beforeValue: unknown,
  afterValue: unknown,
  commissionerIdValue: unknown,
): SanitizedLeagueActivity | null {
  const beforeSource = asRecord(beforeValue);
  const afterSource = asRecord(afterValue);
  const commissionerId = sanitizeOwnerId(commissionerIdValue);
  const actorId = sanitizeOwnerId(afterSource['clockUpdatedBy']);

  if (!commissionerId || !actorId || actorId !== commissionerId) {
    // Automatic server openings and first-manager clock starts stay off the
    // commissioner wire because they are not commissioner control actions.
    return null;
  }

  const beforeStatus = asBoundedString(beforeSource['status'], 20);
  const afterStatus = asBoundedString(afterSource['status'], 20);
  const beforeClockStatus = asBoundedString(beforeSource['clockStatus'], 20);
  const afterClockStatus = asBoundedString(afterSource['clockStatus'], 20);
  let eventType: LeagueActivityEventType | null = null;

  if (beforeStatus !== 'live' && afterStatus === 'live') {
    eventType = 'commissioner-draft-opened';
  } else if (beforeClockStatus === 'running' && afterClockStatus === 'paused') {
    eventType = 'commissioner-draft-clock-paused';
  } else if (beforeClockStatus === 'paused' && afterClockStatus === 'running') {
    eventType = 'commissioner-draft-clock-resumed';
  }

  if (!eventType) {
    return null;
  }

  const activity = baseActivity('commissioner', eventType, commissionerId);
  activity.overallPick = asPositiveInteger(afterSource['nextOverallPick']);
  return activity;
}

export function buildDraftPickLeagueActivity(
  value: unknown,
): SanitizedLeagueActivity | null {
  const source = asRecord(value);
  const primaryAsset = sanitizeAsset(source['asset']);
  const ownerId = sanitizeOwnerId(source['ownerId']);
  const overallPick = asPositiveInteger(source['overallPick']);

  if (!primaryAsset || !ownerId || !overallPick) {
    return null;
  }

  const activity = baseActivity('draft', 'draft-pick', ownerId);
  const selectionType = asBoundedString(source['selectionType'], 16);

  activity.primaryAsset = primaryAsset;
  activity.overallPick = overallPick;
  activity.round = asPositiveInteger(source['round']);
  activity.selectionType = SUPPORTED_SELECTION_TYPES.has(selectionType)
    ? selectionType as SanitizedLeagueActivity['selectionType']
    : null;

  return activity;
}

export function buildTransactionLeagueActivity(
  value: unknown,
): SanitizedLeagueActivity | null {
  const source = asRecord(value);
  const rawType = asBoundedString(source['type'], 48);
  const eventType = (
    TRANSACTION_TYPE_ALIASES.get(rawType) ?? rawType
  ) as LeagueActivityEventType;

  if (!PUBLIC_TRANSACTION_TYPES.has(eventType)) {
    return null;
  }

  // Pending waiver claims, queued roster plans, and cancellations are deliberately
  // absent from PUBLIC_TRANSACTION_TYPES. Only public outcomes reach League Wire.
  const ownerId = eventType === 'waiver-cleared'
    ? null
    : sanitizeOwnerId(source['winningOwnerId'] ?? source['ownerId']);
  const activity = baseActivity('roster', eventType, ownerId);

  switch (eventType) {
    case 'add-drop':
    case 'add-open-slot':
    case 'waiver-award':
    case 'slot-move-activated':
      activity.primaryAsset = sanitizeAsset(source['addedAsset'] ?? source['waiverAsset']);
      activity.secondaryAsset = sanitizeAsset(source['droppedAsset']);
      break;

    case 'active-bench-swap-activated':
      activity.primaryAsset = sanitizeAsset(source['addedAsset'] ?? source['movedAsset']);
      activity.secondaryAsset = sanitizeAsset(source['droppedAsset']);
      break;

    case 'move-to-ir':
    case 'move-bench-to-ir':
      activity.primaryAsset = sanitizeAsset(source['movedAsset']);
      break;

    case 'activate-from-ir':
    case 'activate-ir-to-bench':
      activity.primaryAsset = sanitizeAsset(source['activatedAsset']);
      activity.secondaryAsset = sanitizeAsset(source['droppedAsset']);
      break;

    case 'drop-to-waivers':
      activity.primaryAsset = sanitizeAsset(source['droppedAsset']);
      break;

    case 'waiver-cleared':
      activity.primaryAsset = sanitizeAsset(source['waiverAsset']);
      break;
  }

  if (!activity.primaryAsset) {
    return null;
  }

  activity.effectiveCycleNumber = asPositiveInteger(source['effectiveCycleNumber']);
  activity.effectiveLabel = sanitizeEffectiveLabel(source['effectiveLabel']);

  return activity;
}

export function buildMatchupResultLeagueActivity(
  value: unknown,
): SanitizedLeagueActivity | null {
  const source = asRecord(value);

  if (source['status'] !== 'complete') {
    return null;
  }

  const matchupPhase = source['phase'];
  const matchupCycleNumber = asPositiveInteger(source['cycleNumber']);
  const teamAOwnerId = sanitizeOwnerId(source['teamAOwnerId']);
  const teamBOwnerId = sanitizeOwnerId(source['teamBOwnerId']);
  const teamAScore = asBoundedScore(source['teamAScore']);
  const teamBScore = asBoundedScore(source['teamBScore']);
  const winnerOwnerId = sanitizeOwnerId(source['winnerOwnerId']);

  if (
    (matchupPhase !== 'regular_season' && matchupPhase !== 'playoffs') ||
    matchupCycleNumber === null ||
    !teamAOwnerId ||
    !teamBOwnerId ||
    teamAOwnerId === teamBOwnerId ||
    teamAScore === null ||
    teamBScore === null
  ) {
    // Bye matchups have no opponent and stay off the wire. The feed should
    // celebrate completed competition, not routine bracket bookkeeping.
    return null;
  }

  const scoresAreTied = teamAScore === teamBScore;
  const expectedWinnerOwnerId = teamAScore > teamBScore
    ? teamAOwnerId
    : teamBScore > teamAScore
      ? teamBOwnerId
      : null;

  if (
    (!scoresAreTied && winnerOwnerId !== expectedWinnerOwnerId) ||
    (scoresAreTied && winnerOwnerId !== null &&
      winnerOwnerId !== teamAOwnerId && winnerOwnerId !== teamBOwnerId)
  ) {
    return null;
  }

  if (
    (matchupPhase === 'regular_season' && scoresAreTied && winnerOwnerId !== null) ||
    (matchupPhase === 'playoffs' &&
      (!winnerOwnerId || (scoresAreTied && source['tieBrokenByHigherSeed'] !== true)))
  ) {
    return null;
  }

  const playoffBracketType = source['bracketType'] === 'championship' ||
      source['bracketType'] === 'consolation'
    ? source['bracketType']
    : null;
  const activity = baseActivity('matchup', 'matchup-result', winnerOwnerId);

  activity.matchupPhase = matchupPhase;
  activity.matchupCycleNumber = matchupCycleNumber;
  activity.teamAOwnerId = teamAOwnerId;
  activity.teamBOwnerId = teamBOwnerId;
  activity.teamAScore = teamAScore;
  activity.teamBScore = teamBScore;
  activity.winnerOwnerId = winnerOwnerId;
  activity.playoffBracketType = matchupPhase === 'playoffs'
    ? playoffBracketType
    : null;
  activity.playoffRoundNumber = matchupPhase === 'playoffs'
    ? asPositiveInteger(source['playoffRoundNumber'])
    : null;
  activity.winnerPlace = matchupPhase === 'playoffs'
    ? asPositiveInteger(source['winnerPlace'])
    : null;
  activity.loserPlace = matchupPhase === 'playoffs'
    ? asPositiveInteger(source['loserPlace'])
    : null;
  activity.tieBrokenByHigherSeed = matchupPhase === 'playoffs' &&
    scoresAreTied &&
    source['tieBrokenByHigherSeed'] === true;

  return activity;
}


export interface LeagueRoundRecapResult {
  activity: SanitizedLeagueActivity;
  highestScore: number;
  highestScoreOwnerIds: string[];
  topPerformers: LeagueActivityRecapPerformer[];
  topPerformerTieCount: number;
  topPerformerScore: number | null;
  topPickups: LeagueActivityRecapPickup[];
  topPickupTieCount: number;
  topPickupScore: number | null;
  upsetWinnerOwnerId: string | null;
  upsetLoserOwnerId: string | null;
  upsetProjectionGap: number | null;
  upsetWinnerProjection: number | null;
  upsetLoserProjection: number | null;
}

function roundActivityScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const MAX_RECAP_TOP_PERFORMERS = 3;
const MAX_RECAP_TOP_PICKUPS = 3;

interface RoundRecapWindowCandidate {
  ownerId: string;
  assetKey: string;
  asset: LeagueActivityAssetSummary;
  fantasyPoints: number;
  frozenProjectionPoints: number | null;
  rosterSlotId: string;
}

interface RoundRecapWindowValidationResult {
  candidates: RoundRecapWindowCandidate[];
  projectionTotalsByOwnerId: ReadonlyMap<string, number> | null;
}

interface RoundRecapTopPerformerResult {
  performers: LeagueActivityRecapPerformer[];
  performerTieCount: number;
  performerScore: number;
}

interface RoundRecapTopPickupResult {
  pickups: LeagueActivityRecapPickup[];
  pickupTieCount: number;
  pickupScore: number;
}

interface RoundRecapUpsetResult {
  winnerOwnerId: string;
  loserOwnerId: string;
  projectionGap: number;
  winnerProjection: number;
  loserProjection: number;
  actualMargin: number;
}

const ROUND_RECAP_PICKUP_TRANSACTION_TYPES = new Set([
  'add-drop',
  'add-open-slot',
  'waiver-award',
  'slot-move-activated',
]);

function buildRoundRecapWindowCandidates(
  values: readonly unknown[],
  cycleNumber: number,
  expectedOwnerIds: ReadonlySet<string>,
): RoundRecapWindowValidationResult | null {
  if (values.length === 0 || expectedOwnerIds.size === 0) {
    return null;
  }

  const seenOwnerIds = new Set<string>();
  const candidates: RoundRecapWindowCandidate[] = [];
  const projectionTotalsByOwnerId = new Map<string, number>();
  let completeProjectionEvidence = true;

  for (const value of values) {
    const source = asRecord(value);
    const ownerId = sanitizeOwnerId(source['ownerId']);

    if (!ownerId || !expectedOwnerIds.has(ownerId)) {
      continue;
    }

    const expectedRosterSlotIdValues = source['expectedRosterSlotIds'];
    const expectedRosterSlotIds = Array.isArray(expectedRosterSlotIdValues)
      ? expectedRosterSlotIdValues
        .map((slotId) => asBoundedString(slotId, 80))
        .filter(Boolean)
      : [];
    const expectedRosterSlotIdSet = new Set(expectedRosterSlotIds);
    const totalWindowCount = asPositiveInteger(source['totalWindowCount']);
    const completedWindowCount = asPositiveInteger(source['completedWindowCount']);

    if (
      seenOwnerIds.has(ownerId) ||
      asPositiveInteger(source['cycleNumber']) !== cycleNumber ||
      source['status'] !== 'complete' ||
      !Array.isArray(source['windows']) ||
      source['windows'].length === 0 ||
      source['windows'].length > 64 ||
      expectedRosterSlotIds.length === 0 ||
      expectedRosterSlotIds.length > 32 ||
      expectedRosterSlotIdSet.size !== expectedRosterSlotIds.length ||
      totalWindowCount !== expectedRosterSlotIds.length ||
      completedWindowCount !== expectedRosterSlotIds.length
    ) {
      return null;
    }

    seenOwnerIds.add(ownerId);
    const seenRosterSlotIds = new Set<string>();
    const seenAssetKeys = new Set<string>();
    let ownerProjectionTotal = 0;
    let ownerProjectionComplete = true;

    for (const rawWindow of source['windows']) {
      const window = asRecord(rawWindow);
      const rosterSlotId = asBoundedString(window['rosterSlotId'], 80);

      if (!rosterSlotId || !expectedRosterSlotIdSet.has(rosterSlotId)) {
        // Retained historical assignments are not part of the current round.
        continue;
      }

      const windowOwnerId = sanitizeOwnerId(window['ownerId']);
      const fantasyPoints = asBoundedScore(window['fantasyPoints']);
      const frozenProjectionPoints = asBoundedScore(window['frozenProjectionPoints']);
      const rawAsset = asRecord(window['asset']);
      const assetKey = asSafeAssetKey(window['assetKey'] ?? rawAsset['assetKey']);
      const asset = sanitizeAsset(rawAsset);

      if (
        seenRosterSlotIds.has(rosterSlotId) ||
        !assetKey ||
        seenAssetKeys.has(assetKey) ||
        windowOwnerId !== ownerId ||
        asPositiveInteger(window['cycleNumber']) !== cycleNumber ||
        window['status'] !== 'complete' ||
        fantasyPoints === null ||
        !asset
      ) {
        return null;
      }

      seenRosterSlotIds.add(rosterSlotId);
      seenAssetKeys.add(assetKey);

      if (frozenProjectionPoints === null) {
        ownerProjectionComplete = false;
      } else {
        ownerProjectionTotal += frozenProjectionPoints;
      }

      candidates.push({
        ownerId,
        assetKey,
        asset,
        fantasyPoints: roundActivityScore(fantasyPoints),
        frozenProjectionPoints: frozenProjectionPoints === null
          ? null
          : roundActivityScore(frozenProjectionPoints),
        rosterSlotId,
      });
    }

    if (seenRosterSlotIds.size !== expectedRosterSlotIdSet.size) {
      return null;
    }

    if (ownerProjectionComplete) {
      projectionTotalsByOwnerId.set(ownerId, roundActivityScore(ownerProjectionTotal));
    } else {
      completeProjectionEvidence = false;
    }
  }

  if (seenOwnerIds.size !== expectedOwnerIds.size || candidates.length === 0) {
    return null;
  }

  return {
    candidates,
    projectionTotalsByOwnerId: completeProjectionEvidence &&
        projectionTotalsByOwnerId.size === expectedOwnerIds.size
      ? projectionTotalsByOwnerId
      : null,
  };
}

function buildRoundRecapTopPerformers(
  candidates: readonly RoundRecapWindowCandidate[],
): RoundRecapTopPerformerResult | null {
  const skaterCandidates = candidates.filter(
    (candidate) => candidate.asset.assetType === 'skater',
  );

  if (skaterCandidates.length === 0) {
    return null;
  }

  const performerScore = Math.max(
    ...skaterCandidates.map((candidate) => candidate.fantasyPoints),
  );
  const tiedPerformers = skaterCandidates
    .filter((candidate) => candidate.fantasyPoints === performerScore)
    .sort((left, right) =>
      left.asset.name.localeCompare(right.asset.name) ||
      left.ownerId.localeCompare(right.ownerId) ||
      left.rosterSlotId.localeCompare(right.rosterSlotId),
    );

  return {
    performers: tiedPerformers.slice(0, MAX_RECAP_TOP_PERFORMERS).map((candidate) => ({
      ownerId: candidate.ownerId,
      asset: candidate.asset,
    })),
    performerTieCount: tiedPerformers.length,
    performerScore,
  };
}

function buildRoundRecapTopPickups(
  transactionValues: readonly unknown[],
  cycleNumber: number,
  expectedOwnerIds: ReadonlySet<string>,
  windowCandidates: readonly RoundRecapWindowCandidate[],
  transactionValuesComplete: boolean,
): RoundRecapTopPickupResult | null {
  if (!transactionValuesComplete || transactionValues.length === 0) {
    return null;
  }

  const acquiredOwnerAssetKeys = new Set<string>();

  for (const value of transactionValues) {
    const source = asRecord(value);
    const type = asBoundedString(source['type'], 48);

    if (!ROUND_RECAP_PICKUP_TRANSACTION_TYPES.has(type)) {
      continue;
    }

    if (asPositiveInteger(source['effectiveCycleNumber']) !== cycleNumber) {
      continue;
    }

    const ownerId = type === 'waiver-award'
      ? sanitizeOwnerId(source['winningOwnerId'] ?? source['ownerId'])
      : sanitizeOwnerId(source['ownerId']);

    if (!ownerId) {
      return null;
    }

    if (!expectedOwnerIds.has(ownerId)) {
      continue;
    }

    const addedAsset = asRecord(source['addedAsset'] ?? source['waiverAsset']);
    const assetKey = asSafeAssetKey(addedAsset['assetKey']);
    const asset = sanitizeAsset(addedAsset);

    if (!assetKey || !asset) {
      return null;
    }

    acquiredOwnerAssetKeys.add(`${ownerId}::${assetKey}`);
  }

  const pickupCandidates = windowCandidates.filter((candidate) =>
    candidate.asset.assetType === 'skater' &&
    candidate.fantasyPoints > 0 &&
    acquiredOwnerAssetKeys.has(`${candidate.ownerId}::${candidate.assetKey}`),
  );

  if (pickupCandidates.length === 0) {
    return null;
  }

  const pickupScore = Math.max(
    ...pickupCandidates.map((candidate) => candidate.fantasyPoints),
  );
  const tiedPickups = pickupCandidates
    .filter((candidate) => candidate.fantasyPoints === pickupScore)
    .sort((left, right) =>
      left.asset.name.localeCompare(right.asset.name) ||
      left.ownerId.localeCompare(right.ownerId) ||
      left.assetKey.localeCompare(right.assetKey) ||
      left.rosterSlotId.localeCompare(right.rosterSlotId),
    );

  return {
    pickups: tiedPickups.slice(0, MAX_RECAP_TOP_PICKUPS).map((candidate) => ({
      ownerId: candidate.ownerId,
      asset: candidate.asset,
    })),
    pickupTieCount: tiedPickups.length,
    pickupScore,
  };
}

function buildRoundRecapBiggestUpset(
  completedMatchups: readonly SanitizedLeagueActivity[],
  projectionTotalsByOwnerId: ReadonlyMap<string, number> | null,
): RoundRecapUpsetResult | null {
  if (!projectionTotalsByOwnerId) {
    return null;
  }

  const candidates: RoundRecapUpsetResult[] = [];

  for (const matchup of completedMatchups) {
    const winnerOwnerId = matchup.winnerOwnerId ?? null;
    const teamAOwnerId = matchup.teamAOwnerId ?? null;
    const teamBOwnerId = matchup.teamBOwnerId ?? null;

    if (!winnerOwnerId || !teamAOwnerId || !teamBOwnerId) {
      continue;
    }

    const loserOwnerId = winnerOwnerId === teamAOwnerId
      ? teamBOwnerId
      : winnerOwnerId === teamBOwnerId
        ? teamAOwnerId
        : null;

    if (!loserOwnerId) {
      return null;
    }

    const winnerProjection = projectionTotalsByOwnerId.get(winnerOwnerId);
    const loserProjection = projectionTotalsByOwnerId.get(loserOwnerId);

    if (winnerProjection === undefined || loserProjection === undefined) {
      return null;
    }

    const projectionGap = roundActivityScore(loserProjection - winnerProjection);

    if (projectionGap <= 0) {
      continue;
    }

    const actualMargin = roundActivityScore(
      Math.abs((matchup.teamAScore ?? 0) - (matchup.teamBScore ?? 0)),
    );

    candidates.push({
      winnerOwnerId,
      loserOwnerId,
      projectionGap,
      winnerProjection,
      loserProjection,
      actualMargin,
    });
  }

  return candidates
    .sort((left, right) =>
      right.projectionGap - left.projectionGap ||
      right.actualMargin - left.actualMargin ||
      left.winnerOwnerId.localeCompare(right.winnerOwnerId) ||
      left.loserOwnerId.localeCompare(right.loserOwnerId),
    )[0] ?? null;
}

/**
 * Builds one compact regular-season recap from immutable completed matchup
 * results. A scheduled bye is neutral. Any malformed real matchup fails the
 * whole recap closed so League Wire never summarizes partial competition.
 */
export function buildRegularSeasonRoundRecapLeagueActivity(
  values: readonly unknown[],
  previousHighScoreValue: unknown = null,
  allowNewHighScoreClaim = true,
  teamWindowValues: readonly unknown[] = [],
  transactionValues: readonly unknown[] = [],
  transactionValuesComplete = true,
): LeagueRoundRecapResult | null {
  const hasPreviousHighScore =
    previousHighScoreValue !== null && previousHighScoreValue !== undefined;
  const previousHighScore = asBoundedScore(previousHighScoreValue);

  if (hasPreviousHighScore && previousHighScore === null) {
    return null;
  }

  const completedMatchups: SanitizedLeagueActivity[] = [];

  for (const value of values) {
    const source = asRecord(value);
    const teamBOwnerId = sanitizeOwnerId(source['teamBOwnerId']);

    if (!teamBOwnerId) {
      continue;
    }

    const matchup = buildMatchupResultLeagueActivity(source);

    if (!matchup || matchup.matchupPhase !== 'regular_season') {
      return null;
    }

    completedMatchups.push(matchup);
  }

  if (completedMatchups.length < 2) {
    return null;
  }

  const cycleNumber = completedMatchups[0].matchupCycleNumber ?? null;
  const seenOwnerIds = new Set<string>();

  if (!cycleNumber) {
    return null;
  }

  for (const matchup of completedMatchups) {
    const teamAOwnerId = matchup.teamAOwnerId;
    const teamBOwnerId = matchup.teamBOwnerId;

    if (
      matchup.matchupCycleNumber !== cycleNumber ||
      !teamAOwnerId ||
      !teamBOwnerId ||
      seenOwnerIds.has(teamAOwnerId) ||
      seenOwnerIds.has(teamBOwnerId)
    ) {
      return null;
    }

    seenOwnerIds.add(teamAOwnerId);
    seenOwnerIds.add(teamBOwnerId);
  }

  const windowValidation = teamWindowValues.length > 0
    ? buildRoundRecapWindowCandidates(teamWindowValues, cycleNumber, seenOwnerIds)
    : null;
  const topPerformerResult = windowValidation
    ? buildRoundRecapTopPerformers(windowValidation.candidates)
    : null;
  const topPickupResult = windowValidation
    ? buildRoundRecapTopPickups(
      transactionValues,
      cycleNumber,
      seenOwnerIds,
      windowValidation.candidates,
      transactionValuesComplete,
    )
    : null;
  const biggestUpset = windowValidation
    ? buildRoundRecapBiggestUpset(
      completedMatchups,
      windowValidation.projectionTotalsByOwnerId,
    )
    : null;

  if (teamWindowValues.length > 0 && (!windowValidation || !topPerformerResult)) {
    return null;
  }

  let highestScore = Number.NEGATIVE_INFINITY;
  const highestScoreOwnerIds: string[] = [];

  for (const matchup of completedMatchups) {
    const scores = [
      [matchup.teamAOwnerId, matchup.teamAScore],
      [matchup.teamBOwnerId, matchup.teamBScore],
    ] as const;

    for (const [ownerId, score] of scores) {
      if (!ownerId || score === null || score === undefined) {
        return null;
      }

      const roundedScore = roundActivityScore(score);

      if (roundedScore > highestScore) {
        highestScore = roundedScore;
        highestScoreOwnerIds.length = 0;
        highestScoreOwnerIds.push(ownerId);
      } else if (roundedScore === highestScore) {
        highestScoreOwnerIds.push(ownerId);
      }
    }
  }

  if (!Number.isFinite(highestScore) || highestScoreOwnerIds.length === 0) {
    return null;
  }

  highestScoreOwnerIds.sort();

  const closestMatchup = [...completedMatchups]
    .sort((first, second) => {
      const firstMargin = Math.abs((first.teamAScore ?? 0) - (first.teamBScore ?? 0));
      const secondMargin = Math.abs((second.teamAScore ?? 0) - (second.teamBScore ?? 0));

      if (firstMargin !== secondMargin) {
        return firstMargin - secondMargin;
      }

      const firstPair = [first.teamAOwnerId, first.teamBOwnerId].sort().join(':');
      const secondPair = [second.teamAOwnerId, second.teamBOwnerId].sort().join(':');
      return firstPair.localeCompare(secondPair);
    })[0];

  if (!closestMatchup?.teamAOwnerId || !closestMatchup.teamBOwnerId) {
    return null;
  }

  const closestMargin = roundActivityScore(
    Math.abs((closestMatchup.teamAScore ?? 0) - (closestMatchup.teamBScore ?? 0)),
  );
  const activity = baseActivity(
    'recap',
    'matchup-round-recap',
    highestScoreOwnerIds.length === 1 ? highestScoreOwnerIds[0] : null,
  );

  activity.recapCycleNumber = cycleNumber;
  activity.recapMatchupCount = completedMatchups.length;
  activity.recapTopScoreOwnerIds = highestScoreOwnerIds;
  activity.recapTopScore = highestScore;
  activity.recapClosestTeamAOwnerId = closestMatchup.teamAOwnerId;
  activity.recapClosestTeamBOwnerId = closestMatchup.teamBOwnerId;
  activity.recapClosestWinnerOwnerId = closestMatchup.winnerOwnerId ?? null;
  activity.recapClosestMargin = closestMargin;
  activity.recapNewLeagueHighScore = allowNewHighScoreClaim &&
    previousHighScore !== null &&
    highestScore > previousHighScore;
  activity.recapPreviousLeagueHighScore = previousHighScore;

  if (topPerformerResult) {
    activity.recapTopPerformers = topPerformerResult.performers;
    activity.recapTopPerformerTieCount = topPerformerResult.performerTieCount;
    activity.recapTopPerformerScore = topPerformerResult.performerScore;
  }

  if (topPickupResult) {
    activity.recapTopPickups = topPickupResult.pickups;
    activity.recapTopPickupTieCount = topPickupResult.pickupTieCount;
    activity.recapTopPickupScore = topPickupResult.pickupScore;
  }

  if (biggestUpset) {
    activity.recapUpsetWinnerOwnerId = biggestUpset.winnerOwnerId;
    activity.recapUpsetLoserOwnerId = biggestUpset.loserOwnerId;
    activity.recapUpsetProjectionGap = biggestUpset.projectionGap;
    activity.recapUpsetWinnerProjection = biggestUpset.winnerProjection;
    activity.recapUpsetLoserProjection = biggestUpset.loserProjection;
  }

  return {
    activity,
    highestScore,
    highestScoreOwnerIds,
    topPerformers: topPerformerResult?.performers ?? [],
    topPerformerTieCount: topPerformerResult?.performerTieCount ?? 0,
    topPerformerScore: topPerformerResult?.performerScore ?? null,
    topPickups: topPickupResult?.pickups ?? [],
    topPickupTieCount: topPickupResult?.pickupTieCount ?? 0,
    topPickupScore: topPickupResult?.pickupScore ?? null,
    upsetWinnerOwnerId: biggestUpset?.winnerOwnerId ?? null,
    upsetLoserOwnerId: biggestUpset?.loserOwnerId ?? null,
    upsetProjectionGap: biggestUpset?.projectionGap ?? null,
    upsetWinnerProjection: biggestUpset?.winnerProjection ?? null,
    upsetLoserProjection: biggestUpset?.loserProjection ?? null,
  };
}

export const TRANSACTION_PRIVACY_SCHEMA_VERSION = 1;

export type TransactionPrivacyAsset =
  | {
      assetType: 'skater';
      assetKey: string;
      position: 'LW' | 'C' | 'RW' | 'D';
      player: {
        id: number | string | null;
        fullName: string;
        firstName: string | null;
        lastName: string | null;
        nhlTeamAbbreviation: string | null;
        teamAbbrev: string | null;
        teamLogoUrl: string | null;
      };
      eligibleFromCycleNumber: number | null;
    }
  | {
      assetType: 'team-goalie-unit';
      assetKey: string;
      position: 'G';
      teamName: string;
      teamAbbreviation: string;
      teamLogoUrl: string | null;
      eligibleFromCycleNumber: number | null;
    };

export type PrivateTransactionType =
  | 'add-drop'
  | 'add-open-slot'
  | 'move-to-ir'
  | 'activate-from-ir'
  | 'drop-to-waivers'
  | 'waiver-claim'
  | 'waiver-award'
  | 'waiver-cleared'
  | 'queue-add-drop'
  | 'queue-add-open-slot'
  | 'queue-waiver-award'
  | 'slot-move-activated'
  | 'cancel-queued-move'
  | 'queue-active-bench-swap'
  | 'active-bench-swap-activated'
  | 'move-bench-to-ir'
  | 'activate-ir-to-bench';

export interface PrivateTransactionProjection {
  schemaVersion: typeof TRANSACTION_PRIVACY_SCHEMA_VERSION;
  type: PrivateTransactionType;
  ownerId: string;
  addedAsset: TransactionPrivacyAsset | null;
  droppedAsset: TransactionPrivacyAsset | null;
  movedAsset: TransactionPrivacyAsset | null;
  activatedAsset: TransactionPrivacyAsset | null;
  waiverAsset: TransactionPrivacyAsset | null;
  waiverId: string | null;
  winningOwnerId: string | null;
  dropSlotId: string | null;
  targetSlotId: string | null;
  activeSlotId: string | null;
  benchSlotId: string | null;
  irSlotId: string | null;
  sourceRosterArea: 'active' | 'bench' | 'ir' | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
  queuedMoveId: string | null;
  rosterSlotId: string | null;
}

export interface PublicTransactionResultProjection {
  schemaVersion: typeof TRANSACTION_PRIVACY_SCHEMA_VERSION;
  eventType: LeagueActivityEventType;
  ownerId: string | null;
  primaryAsset: TransactionPrivacyAsset;
  secondaryAsset: TransactionPrivacyAsset | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
}

export interface PublicWaiverProjection {
  schemaVersion: typeof TRANSACTION_PRIVACY_SCHEMA_VERSION;
  assetKey: string;
  asset: TransactionPrivacyAsset;
  droppedAsset: TransactionPrivacyAsset | null;
  droppedByOwnerId: string;
  status: 'active' | 'claimed' | 'cleared';
  awardedToOwnerId: string | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
}

export type PrivateWaiverClaimStatus =
  | 'pending'
  | 'awarded'
  | 'not-awarded'
  | 'cleared';

export interface PrivateWaiverClaimProjection {
  schemaVersion: typeof TRANSACTION_PRIVACY_SCHEMA_VERSION;
  waiverId: string;
  ownerId: string;
  waiverAsset: TransactionPrivacyAsset;
  moveType: 'drop' | 'open-slot';
  rosterArea: 'active' | 'bench';
  dropSlotId: string | null;
  targetSlotId: string | null;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
  status: PrivateWaiverClaimStatus;
  claimedAt: string | null;
}

const PRIVATE_TRANSACTION_TYPES = new Set<PrivateTransactionType>([
  'add-drop',
  'add-open-slot',
  'move-to-ir',
  'activate-from-ir',
  'drop-to-waivers',
  'waiver-claim',
  'waiver-award',
  'waiver-cleared',
  'queue-add-drop',
  'queue-add-open-slot',
  'queue-waiver-award',
  'slot-move-activated',
  'cancel-queued-move',
  'queue-active-bench-swap',
  'active-bench-swap-activated',
  'move-bench-to-ir',
  'activate-ir-to-bench',
]);

function asOptionalBoundedString(value: unknown, maximumLength: number): string | null {
  return asBoundedString(value, maximumLength) || null;
}

function asSafeAssetKey(value: unknown): string {
  const key = asBoundedString(value, 160);
  return key && !key.includes('/') ? key : '';
}

function asSafePosition(value: unknown): TransactionPrivacyAsset['position'] | null {
  return asPosition(value);
}

function asSafeTeamAbbreviation(value: unknown): string | null {
  const abbreviation = asBoundedString(value, 8).toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(abbreviation) ? abbreviation : null;
}

function asSafeLogoUrl(value: unknown): string | null {
  const url = asBoundedString(value, 1_024);

  if (!url) {
    return null;
  }

  return /^(?:https:\/\/|\/assets\/)/i.test(url) ? url : null;
}

function asSafePlayerId(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const stringValue = asBoundedString(value, 40);
  return stringValue || null;
}

export function sanitizeTransactionPrivacyAsset(
  value: unknown,
): TransactionPrivacyAsset | null {
  const source = asRecord(value);
  const assetType = asBoundedString(source['assetType'], 32);
  const assetKey = asSafeAssetKey(source['assetKey']);
  const position = asSafePosition(source['position']);
  const eligibleFromCycleNumber = asPositiveInteger(source['eligibleFromCycleNumber']);

  if (!assetKey || !position) {
    return null;
  }

  if (assetType === 'skater' && position !== 'G') {
    const player = asRecord(source['player']);
    const firstName = asOptionalBoundedString(player['firstName'], 50);
    const lastName = asOptionalBoundedString(player['lastName'], 50);
    const fullName = asBoundedString(player['fullName'], 100) ||
      [firstName, lastName].filter(Boolean).join(' ');

    if (!fullName) {
      return null;
    }

    return {
      assetType: 'skater',
      assetKey,
      position,
      player: {
        id: asSafePlayerId(player['id'] ?? player['playerId'] ?? player['nhlPlayerId']),
        fullName,
        firstName,
        lastName,
        nhlTeamAbbreviation: asSafeTeamAbbreviation(
          player['nhlTeamAbbreviation'] ?? player['teamAbbrev'],
        ),
        teamAbbrev: asSafeTeamAbbreviation(
          player['teamAbbrev'] ?? player['nhlTeamAbbreviation'],
        ),
        teamLogoUrl: asSafeLogoUrl(player['teamLogoUrl']),
      },
      eligibleFromCycleNumber,
    };
  }

  if (assetType === 'team-goalie-unit' && position === 'G') {
    const teamName = asBoundedString(source['teamName'], 100);
    const teamAbbreviation = asSafeTeamAbbreviation(source['teamAbbreviation']);

    if (!teamName || !teamAbbreviation) {
      return null;
    }

    return {
      assetType: 'team-goalie-unit',
      assetKey,
      position: 'G',
      teamName,
      teamAbbreviation,
      teamLogoUrl: asSafeLogoUrl(source['teamLogoUrl']),
      eligibleFromCycleNumber,
    };
  }

  return null;
}

function sanitizePrivateTransactionType(value: unknown): PrivateTransactionType | null {
  const transactionType = asBoundedString(value, 48) as PrivateTransactionType;
  return PRIVATE_TRANSACTION_TYPES.has(transactionType) ? transactionType : null;
}

function sanitizeRosterArea(value: unknown): PrivateTransactionProjection['sourceRosterArea'] {
  return value === 'active' || value === 'bench' || value === 'ir' ? value : null;
}

function sanitizePrivatePathValue(value: unknown, maximumLength = 160): string | null {
  const result = asBoundedString(value, maximumLength);
  return result && !result.includes('/') ? result : null;
}

function sanitizeIsoTimestamp(value: unknown): string | null {
  const timestamp = asBoundedString(value, 40);

  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function getTransactionPrivacyFingerprint(sourceDocumentId: string): string {
  return createHash('sha256')
    .update(`rinkrat-transaction-privacy:${sourceDocumentId}`)
    .digest('hex')
    .slice(0, 40);
}

export function getPrivateTransactionDocumentId(sourceDocumentId: string): string {
  return `transaction-${getTransactionPrivacyFingerprint(sourceDocumentId)}`;
}

export function getPublicTransactionResultDocumentId(sourceDocumentId: string): string {
  return `result-${getTransactionPrivacyFingerprint(sourceDocumentId)}`;
}

export function buildPrivateTransactionProjection(
  value: unknown,
): PrivateTransactionProjection | null {
  const source = asRecord(value);
  const type = sanitizePrivateTransactionType(source['type']);
  const ownerId = sanitizePrivatePathValue(source['ownerId'], 128);

  if (!type || !ownerId) {
    return null;
  }

  return {
    schemaVersion: TRANSACTION_PRIVACY_SCHEMA_VERSION,
    type,
    ownerId,
    addedAsset: sanitizeTransactionPrivacyAsset(source['addedAsset']),
    droppedAsset: sanitizeTransactionPrivacyAsset(source['droppedAsset']),
    movedAsset: sanitizeTransactionPrivacyAsset(source['movedAsset']),
    activatedAsset: sanitizeTransactionPrivacyAsset(source['activatedAsset']),
    waiverAsset: sanitizeTransactionPrivacyAsset(source['waiverAsset']),
    waiverId: sanitizePrivatePathValue(source['waiverId']),
    winningOwnerId: sanitizePrivatePathValue(source['winningOwnerId'], 128),
    dropSlotId: sanitizePrivatePathValue(source['dropSlotId'], 64),
    targetSlotId: sanitizePrivatePathValue(source['targetSlotId'], 64),
    activeSlotId: sanitizePrivatePathValue(source['activeSlotId'], 64),
    benchSlotId: sanitizePrivatePathValue(source['benchSlotId'], 64),
    irSlotId: sanitizePrivatePathValue(source['irSlotId'], 64),
    sourceRosterArea: sanitizeRosterArea(source['sourceRosterArea']),
    effectiveCycleNumber: asPositiveInteger(source['effectiveCycleNumber']),
    effectiveLabel: sanitizeEffectiveLabel(source['effectiveLabel']),
    queuedMoveId: sanitizePrivatePathValue(source['queuedMoveId'], 160),
    rosterSlotId: sanitizePrivatePathValue(source['rosterSlotId'], 64),
  };
}

export function buildPublicTransactionResultProjection(
  value: unknown,
): PublicTransactionResultProjection | null {
  const source = asRecord(value);
  const activity = buildTransactionLeagueActivity(source);

  if (!activity?.primaryAsset) {
    return null;
  }

  const eventType = activity.eventType;
  let primaryAsset: TransactionPrivacyAsset | null = null;
  let secondaryAsset: TransactionPrivacyAsset | null = null;

  switch (eventType) {
    case 'add-drop':
    case 'add-open-slot':
    case 'waiver-award':
    case 'slot-move-activated':
      primaryAsset = sanitizeTransactionPrivacyAsset(
        source['addedAsset'] ?? source['waiverAsset'],
      );
      secondaryAsset = sanitizeTransactionPrivacyAsset(source['droppedAsset']);
      break;

    case 'active-bench-swap-activated':
      primaryAsset = sanitizeTransactionPrivacyAsset(
        source['addedAsset'] ?? source['movedAsset'],
      );
      secondaryAsset = sanitizeTransactionPrivacyAsset(source['droppedAsset']);
      break;

    case 'move-to-ir':
    case 'move-bench-to-ir':
      primaryAsset = sanitizeTransactionPrivacyAsset(source['movedAsset']);
      break;

    case 'activate-from-ir':
    case 'activate-ir-to-bench':
      primaryAsset = sanitizeTransactionPrivacyAsset(source['activatedAsset']);
      secondaryAsset = sanitizeTransactionPrivacyAsset(source['droppedAsset']);
      break;

    case 'drop-to-waivers':
      primaryAsset = sanitizeTransactionPrivacyAsset(source['droppedAsset']);
      break;

    case 'waiver-cleared':
      primaryAsset = sanitizeTransactionPrivacyAsset(source['waiverAsset']);
      break;

    default:
      return null;
  }

  if (!primaryAsset) {
    return null;
  }

  return {
    schemaVersion: TRANSACTION_PRIVACY_SCHEMA_VERSION,
    eventType,
    ownerId: activity.ownerId,
    primaryAsset,
    secondaryAsset,
    effectiveCycleNumber: activity.effectiveCycleNumber,
    effectiveLabel: activity.effectiveLabel,
  };
}

function sanitizeWaiverStatus(
  value: unknown,
): PublicWaiverProjection['status'] | null {
  return value === 'active' || value === 'claimed' || value === 'cleared'
    ? value
    : null;
}

export function buildPublicWaiverProjection(
  waiverId: string,
  value: unknown,
): PublicWaiverProjection | null {
  const source = asRecord(value);
  const safeWaiverId = asSafeAssetKey(waiverId);
  const assetKey = asSafeAssetKey(source['assetKey']) || safeWaiverId;
  const asset = sanitizeTransactionPrivacyAsset(source['asset']);
  const droppedByOwnerId = sanitizePrivatePathValue(source['droppedByOwnerId'], 128);
  const status = sanitizeWaiverStatus(source['status']);

  if (
    !safeWaiverId ||
    !assetKey ||
    assetKey !== safeWaiverId ||
    !asset ||
    !droppedByOwnerId ||
    !status
  ) {
    return null;
  }

  return {
    schemaVersion: TRANSACTION_PRIVACY_SCHEMA_VERSION,
    assetKey,
    asset,
    droppedAsset: sanitizeTransactionPrivacyAsset(source['droppedAsset']),
    droppedByOwnerId,
    status,
    awardedToOwnerId: status === 'claimed'
      ? sanitizePrivatePathValue(source['awardedToOwnerId'], 128)
      : null,
    effectiveCycleNumber: asPositiveInteger(source['effectiveCycleNumber']),
    effectiveLabel: sanitizeEffectiveLabel(source['effectiveLabel']),
  };
}

function resolvePrivateClaimStatus(
  waiverStatus: PublicWaiverProjection['status'],
  ownerId: string,
  awardedToOwnerId: string | null,
): PrivateWaiverClaimStatus {
  if (waiverStatus === 'active') {
    return 'pending';
  }

  if (waiverStatus === 'cleared') {
    return 'cleared';
  }

  return awardedToOwnerId === ownerId ? 'awarded' : 'not-awarded';
}

export function buildPrivateWaiverClaimProjections(
  waiverId: string,
  value: unknown,
): PrivateWaiverClaimProjection[] {
  const source = asRecord(value);
  const safeWaiverId = asSafeAssetKey(waiverId);
  const waiverAsset = sanitizeTransactionPrivacyAsset(source['asset']);
  const waiverStatus = sanitizeWaiverStatus(source['status']);
  const awardedToOwnerId = waiverStatus === 'claimed'
    ? sanitizePrivatePathValue(source['awardedToOwnerId'], 128)
    : null;
  const claims = Array.isArray(source['claims']) ? source['claims'] : [];

  if (!safeWaiverId || !waiverAsset || !waiverStatus) {
    return [];
  }

  const projections = new Map<string, PrivateWaiverClaimProjection>();

  for (const rawClaim of claims) {
    const claim = asRecord(rawClaim);
    const ownerId = sanitizePrivatePathValue(claim['ownerId'], 128);
    const moveType = claim['moveType'] === 'open-slot' ? 'open-slot' :
      claim['moveType'] === 'drop' ? 'drop' : null;
    const rosterArea = claim['rosterArea'] === 'bench' ? 'bench' :
      claim['rosterArea'] === 'active' ? 'active' : null;

    if (!ownerId || !moveType || !rosterArea) {
      continue;
    }

    projections.set(ownerId, {
      schemaVersion: TRANSACTION_PRIVACY_SCHEMA_VERSION,
      waiverId: safeWaiverId,
      ownerId,
      waiverAsset,
      moveType,
      rosterArea,
      dropSlotId: sanitizePrivatePathValue(claim['dropSlotId'], 64),
      targetSlotId: sanitizePrivatePathValue(claim['targetSlotId'], 64),
      effectiveCycleNumber: asPositiveInteger(claim['effectiveCycleNumber']),
      effectiveLabel: sanitizeEffectiveLabel(claim['effectiveLabel']),
      status: resolvePrivateClaimStatus(waiverStatus, ownerId, awardedToOwnerId),
      claimedAt: sanitizeIsoTimestamp(claim['claimedAt']),
    });
  }

  return [...projections.values()];
}
