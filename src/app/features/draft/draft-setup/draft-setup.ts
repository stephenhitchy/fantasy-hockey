import { Component, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../../../core/firebase';

import {
  buildSnakePickPreview,
  createDefaultFantasyDraft,
  DEFAULT_DRAFT_ROSTER_REQUIREMENTS,
  DEFAULT_DRAFT_TOTAL_ROUNDS,
  getFantasyDraft,
  saveFantasyDraft
} from '../../../core/draft/draft.service';

import {
  DraftPickPreview,
  FantasyDraft
} from '../../../core/draft/draft.models';

import {
  getLeagueById,
  League
} from '../../../core/league/league.service';

import {
  FantasyTeam,
  getLeagueTeams
} from '../../../core/team/team.service';

function waitForAuthUser(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

interface DraftRoundPreview {
  round: number;
  picks: DraftPickPreview[];
}

@Component({
  selector: 'app-draft-setup',
  imports: [RouterLink],
  templateUrl: './draft-setup.html',
  styleUrl: './draft-setup.css'
})
export class DraftSetup {
  leagueId = '';

  league = signal<League | null>(null);
  teams = signal<FantasyTeam[]>([]);
  draft = signal<FantasyDraft | null>(null);
  roundOneOrder = signal<string[]>([]);

  loading = signal(true);
  saving = signal(false);
  errorMessage = signal('');
  successMessage = signal('');

  readonly totalRounds = DEFAULT_DRAFT_TOTAL_ROUNDS;

  readonly previewRounds = computed<DraftRoundPreview[]>(() => {
    const order = this.roundOneOrder();

    if (order.length === 0) {
      return [];
    }

    const picks = buildSnakePickPreview(order, this.totalRounds);

    return Array.from({ length: this.totalRounds }, (_, index) => {
      const round = index + 1;

      return {
        round,
        picks: picks.filter((pick) => pick.round === round)
      };
    });
  });

  constructor(
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.loadDraftSetup();
  }

  async loadDraftSetup(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId');
    const user = await waitForAuthUser();

    if (!leagueId || !user) {
      await this.router.navigate(['/']);
      return;
    }

    this.leagueId = leagueId;

    try {
      const [league, teams, existingDraft] = await Promise.all([
        getLeagueById(leagueId),
        getLeagueTeams(leagueId),
        getFantasyDraft(leagueId)
      ]);

      if (!league) {
        await this.router.navigate(['/dashboard']);
        return;
      }

      if (league.commissionerId !== user.uid) {
        await this.router.navigate(['/leagues', leagueId]);
        return;
      }

      const teamIds = teams.map((team) => team.ownerId);

      const savedOrderIsValid =
        existingDraft &&
        existingDraft.roundOneOrder.length === teamIds.length &&
        existingDraft.roundOneOrder.every((ownerId) =>
          teamIds.includes(ownerId)
        ) &&
        teamIds.every((ownerId) =>
          existingDraft.roundOneOrder.includes(ownerId)
        );

      this.league.set(league);
      this.teams.set(teams);
      this.draft.set(existingDraft);
      this.roundOneOrder.set(
        savedOrderIsValid
          ? [...existingDraft.roundOneOrder]
          : teamIds
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to load draft setup.'
      );
    } finally {
      this.loading.set(false);
    }
  }

  getTeamName(ownerId: string): string {
    return this.teams().find(
      (team) => team.ownerId === ownerId
    )?.teamName ?? 'Unknown Team';
  }

  randomizeOrder(): void {
    if (this.isDraftLocked()) {
      return;
    }

    const shuffledOrder = [...this.roundOneOrder()];

    for (let index = shuffledOrder.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(
        Math.random() * (index + 1)
      );

      [shuffledOrder[index], shuffledOrder[randomIndex]] = [
        shuffledOrder[randomIndex],
        shuffledOrder[index]
      ];
    }

    this.roundOneOrder.set(shuffledOrder);
    this.successMessage.set('');
  }

  resetOrder(): void {
    if (this.isDraftLocked()) {
      return;
    }

    this.roundOneOrder.set(
      this.teams().map((team) => team.ownerId)
    );

    this.successMessage.set('');
  }

  moveTeam(index: number, direction: -1 | 1): void {
    if (this.isDraftLocked()) {
      return;
    }

    const newIndex = index + direction;
    const currentOrder = [...this.roundOneOrder()];

    if (
      newIndex < 0 ||
      newIndex >= currentOrder.length
    ) {
      return;
    }

    [currentOrder[index], currentOrder[newIndex]] = [
      currentOrder[newIndex],
      currentOrder[index]
    ];

    this.roundOneOrder.set(currentOrder);
    this.successMessage.set('');
  }

  isDraftLocked(): boolean {
    const status = this.draft()?.status;

    return status === 'live' || status === 'complete';
  }

  async saveDraftOrder(): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');

    if (this.isDraftLocked()) {
      this.errorMessage.set(
        'This draft has already started and its order can no longer be changed.'
      );
      return;
    }

    const order = this.roundOneOrder();

    if (order.length === 0) {
      this.errorMessage.set(
        'At least one team is required before saving a draft order.'
      );
      return;
    }

    this.saving.set(true);

    try {
      const existingDraft = this.draft();

      const draftToSave: FantasyDraft = {
        ...(existingDraft ?? createDefaultFantasyDraft(order)),
        schemaVersion: 1,
        status: 'setup',
        format: 'snake',
        totalRounds: this.totalRounds,
        rosterRequirements: {
          ...DEFAULT_DRAFT_ROSTER_REQUIREMENTS
        },
        roundOneOrder: [...order]
      };

      await saveFantasyDraft(this.leagueId, draftToSave);

      this.draft.set(draftToSave);
      this.successMessage.set(
        'Draft order saved. The draft has not started yet.'
      );
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to save the draft order.'
      );
    } finally {
      this.saving.set(false);
    }
  }
}