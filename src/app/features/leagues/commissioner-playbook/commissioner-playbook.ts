import { Component, computed, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, type User } from 'firebase/auth';

import { auth } from '../../../core/firebase';
import {
  buildCommissionerReadiness,
  type CommissionerReadinessInput,
} from '../../../core/league/commissioner-readiness.util';
import {
  buildCommissionerDraftNightMessage,
  buildCommissionerInviteMessage,
  COMMISSIONER_DRAFT_NIGHT_CHECKLIST,
  COMMISSIONER_RECOVERY_STEPS,
  getCommissionerChecklistProgress,
  normalizeCommissionerChecklistState,
  type CommissionerChecklistState,
} from '../../../core/league/commissioner-playbook.util';
import { getLeagueById, type League } from '../../../core/league/league.service';
import {
  getScheduledStartDate,
  listenToFantasyDraft,
} from '../../../core/draft/draft.service';
import type { FantasyDraft } from '../../../core/draft/draft.models';
import {
  isSharedProjectionSnapshotFreshForDraft,
  loadSharedProjectionSnapshotMetadata,
  SHARED_PROJECTION_VERSION,
  type SharedProjectionSnapshotMetadata,
} from '../../../core/projection/projection-snapshot.service';
import {
  SCORING_RULES_V3_VERSION,
} from '../../../core/scoring/scoring-rules';
import {
  listenToLeagueTeams,
  type FantasyTeam,
} from '../../../core/team/team.service';

const CHECKLIST_STORAGE_PREFIX = 'rinkrat:commissioner-playbook:v1:';

function waitForAuthUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

function exactOwnerOrderMatches(draft: FantasyDraft | null, teams: readonly FantasyTeam[]): boolean {
  if (!draft || !draft.lastSettingsSubmissionId || draft.roundOneOrder.length !== teams.length) {
    return false;
  }

  const expected = teams.map((team) => team.ownerId).sort();
  const actual = [...draft.roundOneOrder].sort();
  return expected.every((ownerId, index) => ownerId === actual[index]);
}

@Component({
  selector: 'app-commissioner-playbook',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './commissioner-playbook.html',
  styleUrl: './commissioner-playbook.css',
})
export class CommissionerPlaybook implements OnDestroy {
  readonly league = signal<League | null>(null);
  readonly teams = signal<FantasyTeam[]>([]);
  readonly draft = signal<FantasyDraft | null>(null);
  readonly projectionMetadata = signal<SharedProjectionSnapshotMetadata | null>(null);
  readonly checklistState = signal<CommissionerChecklistState>({});
  readonly loading = signal(true);
  readonly refreshingProjection = signal(false);
  readonly errorMessage = signal('');
  readonly copyMessage = signal('');
  readonly projectionLoadFailed = signal(false);

  readonly checklistItems = COMMISSIONER_DRAFT_NIGHT_CHECKLIST;
  readonly recoverySteps = COMMISSIONER_RECOVERY_STEPS;

  leagueId = '';
  userId = '';

  private stopDraftListener: (() => void) | null = null;
  private stopTeamListener: (() => void) | null = null;
  private projectionRequestId = 0;

  readonly leagueScoringRulesVersion = computed(() =>
    this.league()?.scoringRulesVersion ?? SCORING_RULES_V3_VERSION,
  );

  readonly scheduledStart = computed(() => getScheduledStartDate(this.draft()));

  readonly draftTimeLabel = computed(() => {
    const value = this.scheduledStart();
    return value
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(value)
      : '';
  });

  readonly draftSettingsSaved = computed(() =>
    this.draft()?.status === 'live' ||
    this.draft()?.status === 'complete' ||
    exactOwnerOrderMatches(this.draft(), this.teams()),
  );

  readonly projectionFresh = computed(() =>
    isSharedProjectionSnapshotFreshForDraft(this.projectionMetadata(), {
      teamCount: this.teams().length,
      requiredGamesPerCycle: this.league()?.scoringRules.requiredGamesPerCycle ?? 6,
      scoringRulesVersion: this.leagueScoringRulesVersion(),
    }),
  );

  readonly projectionStatus = computed<'missing' | 'building' | 'ready' | 'error'>(() => {
    const draft = this.draft();

    if (
      (draft?.status === 'live' || draft?.status === 'complete') &&
      draft.serverDraftProjectionSnapshotId &&
      draft.serverDraftProjectionSnapshotHash
    ) {
      return 'ready';
    }

    if (this.projectionFresh()) {
      return 'ready';
    }

    if (draft?.projectionPreparationStatus === 'queued' || draft?.projectionPreparationStatus === 'processing') {
      return 'building';
    }

    if (draft?.projectionPreparationStatus === 'error' || this.projectionLoadFailed()) {
      return 'error';
    }

    return this.projectionMetadata() ? 'error' : 'missing';
  });

  readonly readiness = computed(() => {
    const league = this.league();
    const draft = this.draft();
    const input: CommissionerReadinessInput = {
      leagueId: this.leagueId,
      emailVerified: auth.currentUser?.emailVerified === true,
      teamCount: this.teams().length,
      maximumTeams: league?.maxTeams ?? 2,
      draftStatus: draft?.status ?? 'missing',
      draftSettingsSaved: this.draftSettingsSaved(),
      draftScheduled: Boolean(this.scheduledStart()),
      projectionStatus: this.projectionStatus(),
      projectionVersion: this.projectionMetadata()?.projectionVersion ??
        (draft?.serverDraftProjectionSnapshotId ? SHARED_PROJECTION_VERSION : null),
      scoringRulesVersion: this.projectionMetadata()?.scoringRulesVersion ??
        (draft?.serverDraftProjectionSnapshotId ? this.leagueScoringRulesVersion() : null),
      expectedProjectionVersion: SHARED_PROJECTION_VERSION,
      expectedScoringRulesVersion: this.leagueScoringRulesVersion(),
    };

    return buildCommissionerReadiness(input);
  });

  readonly checklistProgress = computed(() =>
    getCommissionerChecklistProgress(this.checklistState()),
  );

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {
    void this.load();
  }

  ngOnDestroy(): void {
    this.stopDraftListener?.();
    this.stopTeamListener?.();
  }

  async load(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;
    this.userId = user.uid;
    this.loadChecklist();

    try {
      const league = await getLeagueById(leagueId);
      if (!league) {
        throw new Error('League not found.');
      }
      if (league.commissionerId !== user.uid) {
        throw new Error('Only the league commissioner can open this playbook.');
      }

      this.league.set(league);
      this.stopDraftListener = listenToFantasyDraft(leagueId, (draft) => {
        this.draft.set(draft);
        void this.refreshProjection(false);
      });
      this.stopTeamListener = listenToLeagueTeams(leagueId, (teams) => {
        this.teams.set(teams);
        void this.refreshProjection(false);
      });
      await this.refreshProjection(false);
    } catch (error: unknown) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Unable to open the commissioner playbook.');
    } finally {
      this.loading.set(false);
    }
  }

  async refreshProjection(showStatus = true): Promise<void> {
    if (!this.leagueId) {
      return;
    }

    const requestId = ++this.projectionRequestId;
    if (showStatus) {
      this.refreshingProjection.set(true);
      this.copyMessage.set('');
    }

    try {
      const metadata = await loadSharedProjectionSnapshotMetadata(this.leagueId);
      if (requestId !== this.projectionRequestId) {
        return;
      }
      this.projectionMetadata.set(metadata);
      this.projectionLoadFailed.set(false);
      if (showStatus) {
        this.copyMessage.set('Draft-board readiness refreshed.');
      }
    } catch {
      if (requestId !== this.projectionRequestId) {
        return;
      }
      this.projectionLoadFailed.set(true);
      if (showStatus) {
        this.copyMessage.set('The projection status could not be refreshed. Competition data was not changed.');
      }
    } finally {
      if (requestId === this.projectionRequestId) {
        this.refreshingProjection.set(false);
      }
    }
  }

  isChecklistItemComplete(itemId: string): boolean {
    return this.checklistState()[itemId] === true;
  }

  setChecklistItem(itemId: string, checked: boolean): void {
    this.checklistState.update((current) => ({
      ...current,
      [itemId]: checked,
    }));
    this.saveChecklist();
  }

  resetChecklist(): void {
    this.checklistState.set({});
    this.saveChecklist();
    this.copyMessage.set('Draft-night checklist reset on this device.');
  }

  async copyInviteMessage(): Promise<void> {
    const league = this.league();
    if (!league) {
      return;
    }

    await this.copyText(
      buildCommissionerInviteMessage({
        leagueName: league.name,
        inviteCode: league.inviteCode,
        draftTimeLabel: this.draftTimeLabel(),
        managerCount: this.teams().length,
        maximumTeams: league.maxTeams,
      }),
      'Invite message copied.',
    );
  }

  async copyDraftNightMessage(): Promise<void> {
    const league = this.league();
    if (!league) {
      return;
    }

    await this.copyText(
      buildCommissionerDraftNightMessage({
        leagueName: league.name,
        inviteCode: league.inviteCode,
        draftTimeLabel: this.draftTimeLabel(),
        managerCount: this.teams().length,
        maximumTeams: league.maxTeams,
      }),
      'Draft-night reminder copied.',
    );
  }

  printPlaybook(): void {
    if (typeof window !== 'undefined') {
      window.print();
    }
  }

  private loadChecklist(): void {
    if (typeof localStorage === 'undefined' || !this.leagueId) {
      return;
    }

    try {
      const raw = localStorage.getItem(`${CHECKLIST_STORAGE_PREFIX}${this.leagueId}`);
      this.checklistState.set(normalizeCommissionerChecklistState(raw ? JSON.parse(raw) : null));
    } catch {
      this.checklistState.set({});
    }
  }

  private saveChecklist(): void {
    if (typeof localStorage === 'undefined' || !this.leagueId) {
      return;
    }

    try {
      localStorage.setItem(
        `${CHECKLIST_STORAGE_PREFIX}${this.leagueId}`,
        JSON.stringify(this.checklistState()),
      );
    } catch {
      // The checklist is convenience-only and must never block league operation.
    }
  }

  private async copyText(value: string, successMessage: string): Promise<void> {
    this.copyMessage.set('');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = value;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        textArea.remove();
      }
      this.copyMessage.set(successMessage);
    } catch {
      this.copyMessage.set('Copy failed. Select the text manually from the commissioner guide.');
    }
  }
}
