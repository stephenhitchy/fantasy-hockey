import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../firebase-functions';

export type FinalScoreReconciliationFindingStatus =
  | 'candidate'
  | 'unverifiable';

export interface FinalScoreReconciliationFinding {
  status: FinalScoreReconciliationFindingStatus;
  code: string;
  teamKey: string;
  rosterSlotId: string;
  assetKey: string;
  assetType: 'skater' | 'team-goalie-unit' | 'unknown';
  gameId: number | null;
  storedPoints: number | null;
  canonicalPoints: number | null;
  pointDelta: number | null;
  storedAppeared: boolean | null;
  canonicalAppeared: boolean | null;
  storedSourceVersion: string;
  canonicalSourceVersion: string;
  reason: string;
}

export interface FinalScoreReconciliationSummary {
  teamDocumentCount: number;
  windowCount: number;
  finalizedGameCount: number;
  verifiedGameCount: number;
  candidateGameCount: number;
  unverifiableGameCount: number;
  integrityIssueCount: number;
  findingCount: number;
}

export interface FinalScoreReconciliationPage {
  schemaVersion: 1;
  generatedAt: string;
  leagueId: string;
  cycleNumber: number;
  authority: 'detect-only';
  writesPerformed: 0;
  pageSize: number;
  nextCursor: string;
  scanComplete: boolean;
  canonicalGameReadLimitReached: boolean;
  teamWindowLimitReached: boolean;
  windowGameLimitReached: boolean;
  teamWindowStructureIncomplete: boolean;
  teamDocumentCoverageChecked: boolean;
  findingsTruncated: boolean;
  summary: FinalScoreReconciliationSummary;
  findings: FinalScoreReconciliationFinding[];
}

interface FinalScoreReconciliationPageRequest {
  leagueId: string;
  cycleNumber: number | null;
  afterTeamId: string;
}

@Injectable({ providedIn: 'root' })
export class FinalScoreReconciliationService {
  async loadPage(
    request: FinalScoreReconciliationPageRequest,
  ): Promise<FinalScoreReconciliationPage> {
    const callable = httpsCallable<
      FinalScoreReconciliationPageRequest,
      FinalScoreReconciliationPage
    >(
      functions,
      'getFinalScoreReconciliationPage',
      { timeout: 65_000 },
    );
    const response = await callable(request);
    return response.data;
  }
}
