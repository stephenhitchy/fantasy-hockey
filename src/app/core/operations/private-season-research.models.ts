import type { PrivateSeasonBuildIdentity } from './private-season.models';

export type PrivateSeasonResearchMilestone =
  | 'after-join'
  | 'after-draft'
  | 'after-first-matchup'
  | 'after-first-transaction'
  | 'week-4'
  | 'midseason'
  | 'season-end';
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

export interface PrivateSeasonResearchManagerSnapshot {
  generatedAt: string;
  build: PrivateSeasonBuildIdentity;
  planStatus: string;
  tracked: boolean;
  privacyNote: string;
  leagues: PrivateSeasonResearchLeagueState[];
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

export interface PrivateSeasonResearchDashboardSnapshot {
  generatedAt: string;
  build: PrivateSeasonBuildIdentity;
  planStatus: string;
  responseLimitReached: boolean;
  summary: PrivateSeasonResearchSummary;
  milestones: PrivateSeasonResearchMilestoneSummary[];
  leagues: PrivateSeasonResearchLeagueSummary[];
  responses: PrivateSeasonResearchResponse[];
}

export const PRIVATE_SEASON_RESEARCH_MILESTONES: PrivateSeasonResearchMilestone[] = [
  'after-join',
  'after-draft',
  'after-first-matchup',
  'after-first-transaction',
  'week-4',
  'midseason',
  'season-end',
];

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
