import { createHash } from 'node:crypto';


export const PRIVATE_SEASON_RESEARCH_MINIMUM_RELEASE_CANDIDATE = 56;
export const PRIVATE_SEASON_RESEARCH_SCORING_VERSION = 4;
export const PRIVATE_SEASON_RESEARCH_PROJECTION_VERSION = 11;
export const PRIVATE_SEASON_RESEARCH_RESPONSE_LIMIT = 1_000;
export const PRIVATE_SEASON_RESEARCH_TEXT_MAXIMUM = 1_200;
export const PRIVATE_SEASON_RESEARCH_SHORT_TEXT_MAXIMUM = 240;
export const PRIVATE_SEASON_RESEARCH_REASON_MINIMUM_LENGTH = 12;
export const PRIVATE_SEASON_RESEARCH_MIDSEASON_DATE = '2027-01-04';
export const PRIVATE_SEASON_RESEARCH_SEASON_END_DATE = '2027-04-11';

export const PRIVATE_SEASON_RESEARCH_MILESTONES = [
  'after-join',
  'after-draft',
  'after-first-matchup',
  'after-first-transaction',
  'week-4',
  'midseason',
  'season-end',
] as const;

export type PrivateSeasonResearchMilestone = typeof PRIVATE_SEASON_RESEARCH_MILESTONES[number];
export type PrivateSeasonResearchRole = 'commissioner' | 'manager';
export type PrivateSeasonInformationAmount = 'not-answered' | 'too-little' | 'about-right' | 'too-much';
export type PrivateSeasonFounderIndependence = 'yes' | 'mostly' | 'no' | 'not-applicable';
export type PrivateSeasonSupportNeed = 'not-answered' | 'none' | 'once' | 'monthly' | 'weekly' | 'more';
export type PrivateSeasonReturnIntent = 'not-asked' | 'definitely' | 'probably' | 'unsure' | 'probably-not' | 'no';
export type PrivateSeasonResearchAvailability = 'available' | 'locked' | 'submitted';

export interface PrivateSeasonResearchAnswers {
  clarityRating: number | null;
  trustRating: number | null;
  informationAmount: PrivateSeasonInformationAmount;
  founderIndependence: PrivateSeasonFounderIndependence;
  supportNeeded: PrivateSeasonSupportNeed;
  nextSeasonIntent: PrivateSeasonReturnIntent;
  recommendationScore: number | null;
  promptResponse: string;
  biggestFriction: string;
  mostUsefulFeature: string;
  followUpAllowed: boolean;
}

export interface PrivateSeasonResearchResponse {
  schemaVersion: 1;
  responseId: string;
  leagueId: string;
  leagueLabel: string;
  managerHash: string;
  role: PrivateSeasonResearchRole;
  milestone: PrivateSeasonResearchMilestone;
  revision: number;
  answers: PrivateSeasonResearchAnswers;
  releaseLabel: string;
  buildId: string;
  submittedAt: string | null;
  updatedAt: string | null;
}

export interface PrivateSeasonResearchMilestoneState {
  milestone: PrivateSeasonResearchMilestone;
  label: string;
  prompt: string;
  availability: PrivateSeasonResearchAvailability;
  lockedReason: string;
  response: PrivateSeasonResearchResponse | null;
}

export interface PrivateSeasonResearchLeagueState {
  leagueId: string;
  leagueLabel: string;
  role: PrivateSeasonResearchRole;
  teamCount: number;
  milestones: PrivateSeasonResearchMilestoneState[];
}

export interface PrivateSeasonResearchSummary {
  responseCount: number;
  uniqueRespondentCount: number;
  averageClarity: number | null;
  averageTrust: number | null;
  averageRecommendation: number | null;
  informationAboutRightPercent: number | null;
  informationTooMuchPercent: number | null;
  founderIndependentPercent: number | null;
  recurringSupportPercent: number | null;
  positiveReturnIntentPercent: number | null;
  followUpAllowedCount: number;
}

export interface PrivateSeasonResearchMilestoneSummary {
  milestone: PrivateSeasonResearchMilestone;
  label: string;
  responseCount: number;
  eligibleCount: number;
  completionPercent: number | null;
  averageClarity: number | null;
  averageTrust: number | null;
}

export interface PrivateSeasonResearchLeagueSummary {
  leagueId: string;
  leagueLabel: string;
  teamCount: number;
  responseCount: number;
  uniqueRespondentCount: number;
  milestones: PrivateSeasonResearchMilestoneSummary[];
}

const MILESTONE_LABELS: Record<PrivateSeasonResearchMilestone, string> = {
  'after-join': 'After joining',
  'after-draft': 'After the Draft',
  'after-first-matchup': 'After the first matchup',
  'after-first-transaction': 'After the first transaction',
  'week-4': 'Week 4',
  midseason: 'Midseason',
  'season-end': 'End of season',
};

const MILESTONE_PROMPTS: Record<PrivateSeasonResearchMilestone, string> = {
  'after-join': 'What did you expect to happen next?',
  'after-draft': 'Could your league run this without Stephen?',
  'after-first-matchup': 'Explain the six-game system in your own words.',
  'after-first-transaction': 'What made you confident the move worked?',
  'week-4': 'What brings you back? What do you still use elsewhere?',
  midseason: 'What would make you quit?',
  'season-end': 'Would you choose RinkRat next year? Why or why not?',
};

const INFORMATION_AMOUNTS = new Set<PrivateSeasonInformationAmount>([
  'not-answered',
  'too-little',
  'about-right',
  'too-much',
]);
const FOUNDER_INDEPENDENCE = new Set<PrivateSeasonFounderIndependence>([
  'yes',
  'mostly',
  'no',
  'not-applicable',
]);
const SUPPORT_NEEDS = new Set<PrivateSeasonSupportNeed>([
  'not-answered',
  'none',
  'once',
  'monthly',
  'weekly',
  'more',
]);
const RETURN_INTENTS = new Set<PrivateSeasonReturnIntent>([
  'not-asked',
  'definitely',
  'probably',
  'unsure',
  'probably-not',
  'no',
]);
const MILESTONES = new Set<PrivateSeasonResearchMilestone>(PRIVATE_SEASON_RESEARCH_MILESTONES);
const CONTACT_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\s().-]*){7,})/i;
const RESPONSE_ID_PATTERN = /^[a-f0-9]{64}$/;
const MANAGER_HASH_PATTERN = /^[a-f0-9]{32}$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : null;
}

function decimal(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Number(value.toFixed(2))))
    : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function average(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => typeof value === 'number');
  if (usable.length === 0) return null;
  return Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(2));
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function privateSeasonResearchMilestoneLabel(
  milestone: PrivateSeasonResearchMilestone,
): string {
  return MILESTONE_LABELS[milestone];
}

export function privateSeasonResearchMilestonePrompt(
  milestone: PrivateSeasonResearchMilestone,
): string {
  return MILESTONE_PROMPTS[milestone];
}

export function normalizePrivateSeasonResearchMilestone(
  value: unknown,
): PrivateSeasonResearchMilestone | null {
  const candidate = text(value, 40) as PrivateSeasonResearchMilestone;
  return MILESTONES.has(candidate) ? candidate : null;
}

export function privateSeasonResearchResponseId(
  userId: string,
  leagueId: string,
  milestone: PrivateSeasonResearchMilestone,
): string {
  return createHash('sha256')
    .update(`rinkrat-private-season-research-v1:${userId}:${leagueId}:${milestone}`)
    .digest('hex');
}

export function containsPrivateSeasonContactDetails(value: string): boolean {
  return CONTACT_PATTERN.test(value);
}

export function emptyPrivateSeasonResearchAnswers(): PrivateSeasonResearchAnswers {
  return {
    clarityRating: null,
    trustRating: null,
    informationAmount: 'not-answered',
    founderIndependence: 'not-applicable',
    supportNeeded: 'not-answered',
    nextSeasonIntent: 'not-asked',
    recommendationScore: null,
    promptResponse: '',
    biggestFriction: '',
    mostUsefulFeature: '',
    followUpAllowed: false,
  };
}

export function normalizePrivateSeasonResearchAnswers(
  value: unknown,
): PrivateSeasonResearchAnswers | null {
  const source = record(value);
  const promptResponse = text(source['promptResponse'], PRIVATE_SEASON_RESEARCH_TEXT_MAXIMUM);
  const biggestFriction = text(source['biggestFriction'], 600);
  const mostUsefulFeature = text(source['mostUsefulFeature'], PRIVATE_SEASON_RESEARCH_SHORT_TEXT_MAXIMUM);
  const informationAmount = text(source['informationAmount'], 30) as PrivateSeasonInformationAmount;
  const founderIndependence = text(source['founderIndependence'], 30) as PrivateSeasonFounderIndependence;
  const supportNeeded = text(source['supportNeeded'], 30) as PrivateSeasonSupportNeed;
  const nextSeasonIntent = text(source['nextSeasonIntent'], 30) as PrivateSeasonReturnIntent;
  const freeText = [promptResponse, biggestFriction, mostUsefulFeature].join(' ');

  if (
    promptResponse.length < 10 ||
    !INFORMATION_AMOUNTS.has(informationAmount) ||
    !FOUNDER_INDEPENDENCE.has(founderIndependence) ||
    !SUPPORT_NEEDS.has(supportNeeded) ||
    !RETURN_INTENTS.has(nextSeasonIntent) ||
    containsPrivateSeasonContactDetails(freeText)
  ) {
    return null;
  }

  return {
    clarityRating: integer(source['clarityRating'], 1, 5),
    trustRating: integer(source['trustRating'], 1, 5),
    informationAmount,
    founderIndependence,
    supportNeeded,
    nextSeasonIntent,
    recommendationScore: integer(source['recommendationScore'], 0, 10),
    promptResponse,
    biggestFriction,
    mostUsefulFeature,
    followUpAllowed: source['followUpAllowed'] === true,
  };
}

export function normalizePrivateSeasonResearchResponse(
  value: unknown,
): PrivateSeasonResearchResponse | null {
  const source = record(value);
  const responseId = text(source['responseId'], 64).toLowerCase();
  const managerHash = text(source['managerHash'], 64).toLowerCase();
  const milestone = normalizePrivateSeasonResearchMilestone(source['milestone']);
  const role = text(source['role'], 20) as PrivateSeasonResearchRole;
  const answers = normalizePrivateSeasonResearchAnswers(source['answers']);

  if (
    !RESPONSE_ID_PATTERN.test(responseId) ||
    !MANAGER_HASH_PATTERN.test(managerHash) ||
    !milestone ||
    !answers ||
    !['commissioner', 'manager'].includes(role)
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    responseId,
    leagueId: text(source['leagueId'], 128),
    leagueLabel: text(source['leagueLabel'], 80),
    managerHash,
    role,
    milestone,
    revision: integer(source['revision'], 0, 1_000_000) ?? 0,
    answers,
    releaseLabel: text(source['releaseLabel'], 80),
    buildId: text(source['buildId'], 180),
    submittedAt: isoOrNull(source['submittedAt']),
    updatedAt: isoOrNull(source['updatedAt']),
  };
}

export function privateSeasonResearchMilestoneAvailable(input: {
  milestone: PrivateSeasonResearchMilestone;
  draftComplete: boolean;
  firstMatchupViewedAt: string | null;
  firstRosterActionAt: string | null;
  activatedAt: string | null;
  planStatus: string;
  nowMilliseconds: number;
}): { available: boolean; reason: string } {
  const dateKey = new Date(input.nowMilliseconds).toISOString().slice(0, 10);

  switch (input.milestone) {
    case 'after-join':
      return { available: true, reason: '' };
    case 'after-draft':
      return input.draftComplete
        ? { available: true, reason: '' }
        : { available: false, reason: 'Available after this league completes its Draft.' };
    case 'after-first-matchup':
      return input.firstMatchupViewedAt
        ? { available: true, reason: '' }
        : { available: false, reason: 'Available after the first live matchup is viewed.' };
    case 'after-first-transaction':
      return input.firstRosterActionAt
        ? { available: true, reason: '' }
        : { available: false, reason: 'Available after the league records its first roster or waiver action.' };
    case 'week-4': {
      if (!input.activatedAt) {
        return { available: false, reason: 'Available four weeks after the league activates.' };
      }
      const due = Date.parse(input.activatedAt) + 28 * 24 * 60 * 60 * 1_000;
      return input.nowMilliseconds >= due
        ? { available: true, reason: '' }
        : { available: false, reason: 'Available four weeks after the league activates.' };
    }
    case 'midseason':
      return dateKey >= PRIVATE_SEASON_RESEARCH_MIDSEASON_DATE
        ? { available: true, reason: '' }
        : { available: false, reason: 'Available during the January midseason review.' };
    case 'season-end':
      return dateKey >= PRIVATE_SEASON_RESEARCH_SEASON_END_DATE || input.planStatus === 'complete'
        ? { available: true, reason: '' }
        : { available: false, reason: 'Available after the tester season ends.' };
  }
}

export function buildPrivateSeasonResearchSummary(
  responses: readonly PrivateSeasonResearchResponse[],
): PrivateSeasonResearchSummary {
  const managerHashes = new Set(responses.map((response) => response.managerHash));
  const informationResponses = responses.filter((response) =>
    response.answers.informationAmount !== 'not-answered');
  const independenceResponses = responses.filter((response) =>
    response.answers.founderIndependence !== 'not-applicable');
  const supportResponses = responses.filter((response) =>
    response.answers.supportNeeded !== 'not-answered');
  const returnResponses = responses.filter((response) =>
    response.answers.nextSeasonIntent !== 'not-asked');

  return {
    responseCount: responses.length,
    uniqueRespondentCount: managerHashes.size,
    averageClarity: average(responses.map((response) => response.answers.clarityRating)),
    averageTrust: average(responses.map((response) => response.answers.trustRating)),
    averageRecommendation: average(responses.map((response) => response.answers.recommendationScore)),
    informationAboutRightPercent: percent(
      informationResponses.filter((response) => response.answers.informationAmount === 'about-right').length,
      informationResponses.length,
    ),
    informationTooMuchPercent: percent(
      informationResponses.filter((response) => response.answers.informationAmount === 'too-much').length,
      informationResponses.length,
    ),
    founderIndependentPercent: percent(
      independenceResponses.filter((response) =>
        ['yes', 'mostly'].includes(response.answers.founderIndependence)).length,
      independenceResponses.length,
    ),
    recurringSupportPercent: percent(
      supportResponses.filter((response) =>
        ['monthly', 'weekly', 'more'].includes(response.answers.supportNeeded)).length,
      supportResponses.length,
    ),
    positiveReturnIntentPercent: percent(
      returnResponses.filter((response) =>
        ['definitely', 'probably'].includes(response.answers.nextSeasonIntent)).length,
      returnResponses.length,
    ),
    followUpAllowedCount: responses.filter((response) => response.answers.followUpAllowed).length,
  };
}

export function buildPrivateSeasonMilestoneSummary(input: {
  milestone: PrivateSeasonResearchMilestone;
  responses: readonly PrivateSeasonResearchResponse[];
  eligibleCount: number;
}): PrivateSeasonResearchMilestoneSummary {
  const responses = input.responses.filter((response) => response.milestone === input.milestone);
  return {
    milestone: input.milestone,
    label: privateSeasonResearchMilestoneLabel(input.milestone),
    responseCount: responses.length,
    eligibleCount: Math.max(0, input.eligibleCount),
    completionPercent: percent(responses.length, input.eligibleCount),
    averageClarity: average(responses.map((response) => response.answers.clarityRating)),
    averageTrust: average(responses.map((response) => response.answers.trustRating)),
  };
}

export function normalizeResearchMetric(value: unknown, minimum: number, maximum: number): number | null {
  return decimal(value, minimum, maximum);
}
