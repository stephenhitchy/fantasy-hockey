import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import {
  type LeagueActivity,
  type LeagueActivityCategory,
} from '../../../core/league/league-activity.models';
import { listenToLeagueActivity } from '../../../core/league/league-activity.service';
import { type FantasyTeam } from '../../../core/team/team.service';
import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';

interface LeagueWireItem {
  id: string;
  category: LeagueActivityCategory;
  categoryLabel: string;
  actorLabel: string;
  profileIconId: string | null;
  headline: string;
  detail: string | null;
  occurredAt: Date | null;
}

const COLLAPSED_ACTIVITY_COUNT = 5;

@Component({
  selector: 'app-league-wire',
  standalone: true,
  imports: [ManagerAvatar],
  templateUrl: './league-wire.html',
  styleUrl: './league-wire.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeagueWire {
  private readonly destroyRef = inject(DestroyRef);

  readonly leagueId = input.required<string>();
  readonly teams = input<readonly FantasyTeam[]>([]);

  readonly activity = signal<LeagueActivity[]>([]);
  readonly loading = signal(true);
  readonly errorMessage = signal('');
  readonly expanded = signal(false);
  readonly now = signal(Date.now());

  private readonly teamByOwnerId = computed(() =>
    new Map(this.teams().map((team) => [team.ownerId, team] as const)),
  );

  readonly allItems = computed<LeagueWireItem[]>(() =>
    this.activity().map((activity) => this.toWireItem(activity)),
  );

  readonly visibleItems = computed(() => {
    const items = this.allItems();
    return this.expanded() ? items : items.slice(0, COLLAPSED_ACTIVITY_COUNT);
  });

  readonly hiddenActivityCount = computed(() =>
    Math.max(0, this.allItems().length - COLLAPSED_ACTIVITY_COUNT),
  );

  constructor() {
    effect((onCleanup) => {
      const leagueId = this.leagueId().trim();

      this.activity.set([]);
      this.errorMessage.set('');
      this.expanded.set(false);

      if (!leagueId) {
        this.loading.set(false);
        return;
      }

      this.loading.set(true);

      const stop = listenToLeagueActivity(
        leagueId,
        (activity) => {
          this.activity.set(activity);
          this.loading.set(false);
          this.errorMessage.set('');
        },
        () => {
          this.loading.set(false);
          this.errorMessage.set(
            'League Wire is temporarily unavailable. Your league actions are still safe.',
          );
        },
      );

      onCleanup(stop);
    });

    const clock = setInterval(() => this.now.set(Date.now()), 60_000);
    this.destroyRef.onDestroy(() => clearInterval(clock));
  }

  toggleExpanded(): void {
    this.expanded.update((expanded) => !expanded);
  }

  formatTime(value: Date | null): string {
    if (!value) {
      return 'Recent';
    }

    const elapsedMilliseconds = Math.max(0, this.now() - value.getTime());
    const elapsedMinutes = Math.floor(elapsedMilliseconds / 60_000);

    if (elapsedMinutes < 1) {
      return 'Now';
    }

    if (elapsedMinutes < 60) {
      return `${elapsedMinutes}m`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);

    if (elapsedHours < 24) {
      return `${elapsedHours}h`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);

    if (elapsedDays < 7) {
      return `${elapsedDays}d`;
    }

    return value.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  fullTimeLabel(value: Date | null): string {
    return value
      ? value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'Recent league activity';
  }

  private toWireItem(activity: LeagueActivity): LeagueWireItem {
    const team = activity.ownerId
      ? this.teamByOwnerId().get(activity.ownerId) ?? null
      : null;
    const managerLabel = team?.teamName || 'A manager';
    const commissionerLabel = team?.teamName || 'The commissioner';
    const actorLabel = team?.teamName || (activity.ownerId ? 'A manager' : 'League activity');
    const primaryName = activity.primaryAsset?.name || 'a roster asset';
    const secondaryName = activity.secondaryAsset?.name || '';
    const position = activity.primaryAsset?.position;
    const timingDetail = activity.effectiveLabel === 'After current slot window'
      ? 'After the current slot window'
      : activity.effectiveLabel
        ? `Effective ${activity.effectiveLabel.replace(/^Cycle\s+/i, 'Matchup ')}`
        : activity.effectiveCycleNumber
          ? `Effective Matchup ${activity.effectiveCycleNumber}`
          : null;

    let headline = 'League activity was recorded.';
    let detail: string | null = null;

    switch (activity.eventType) {
      case 'league-created':
        headline = `${commissionerLabel} opened the league.`;
        detail = 'The rink is ready for managers.';
        break;
      case 'member-joined':
        headline = `${managerLabel} joined the league.`;
        break;
      case 'league-presentation-updated':
        headline = `${commissionerLabel} updated the league look.`;
        detail = 'Name, emblem, or colors changed.';
        break;
      case 'draft-settings-saved':
        headline = `${commissionerLabel} saved the Draft setup.`;
        detail = 'Order, start time, and pick clock are set; league membership is locked.';
        break;
      case 'draft-pick': {
        headline = `${managerLabel} drafted ${primaryName}.`;
        const pickDetail = activity.overallPick
          ? `Pick ${activity.overallPick}${activity.round ? ` · Round ${activity.round}` : ''}`
          : null;
        const selectionDetail = activity.selectionType === 'automatic'
          ? 'Auto Pick'
          : activity.selectionType === 'queue'
            ? 'From Queue'
            : null;
        detail = [pickDetail, position, selectionDetail].filter(Boolean).join(' · ') || null;
        break;
      }
      case 'add-drop':
        headline = secondaryName
          ? `${managerLabel} added ${primaryName} and dropped ${secondaryName}.`
          : `${managerLabel} added ${primaryName}.`;
        detail = timingDetail;
        break;
      case 'add-open-slot':
        headline = `${managerLabel} added ${primaryName}.`;
        detail = timingDetail;
        break;
      case 'move-to-ir':
        headline = `${managerLabel} moved ${primaryName} to IR.`;
        detail = timingDetail;
        break;
      case 'move-bench-to-ir':
        headline = `${managerLabel} moved ${primaryName} from the bench to IR.`;
        detail = timingDetail;
        break;
      case 'activate-from-ir':
        headline = `${managerLabel} activated ${primaryName} from IR.`;
        detail = secondaryName
          ? `${secondaryName} moved to waivers${timingDetail ? ` · ${timingDetail}` : ''}.`
          : timingDetail;
        break;
      case 'activate-ir-to-bench':
        headline = `${managerLabel} activated ${primaryName} to the bench.`;
        detail = secondaryName
          ? `${secondaryName} moved to waivers${timingDetail ? ` · ${timingDetail}` : ''}.`
          : timingDetail;
        break;
      case 'drop-to-waivers':
        headline = `${managerLabel} dropped ${primaryName} to waivers.`;
        detail = timingDetail;
        break;
      case 'waiver-award':
        headline = `${managerLabel} won ${primaryName} on waivers.`;
        detail = secondaryName
          ? `${secondaryName} was dropped${timingDetail ? ` · ${timingDetail}` : ''}.`
          : timingDetail;
        break;
      case 'waiver-cleared':
        headline = `${primaryName} cleared waivers.`;
        detail = 'No eligible claim was awarded.';
        break;
      case 'slot-move-activated':
        headline = secondaryName
          ? `${managerLabel} activated ${primaryName} and dropped ${secondaryName}.`
          : `${managerLabel} activated ${primaryName}.`;
        detail = timingDetail;
        break;
      case 'active-bench-swap-activated':
        headline = `${managerLabel} moved ${primaryName} into the active lineup.`;
        detail = secondaryName
          ? `${secondaryName} moved to the bench${timingDetail ? ` · ${timingDetail}` : ''}.`
          : timingDetail;
        break;
    }

    return {
      id: activity.id,
      category: activity.category,
      categoryLabel: activity.category === 'draft'
        ? 'Draft'
        : activity.category === 'roster'
          ? 'Roster'
          : 'League',
      actorLabel,
      profileIconId: team?.profileIconId ?? null,
      headline,
      detail,
      occurredAt: activity.occurredAt,
    };
  }
}
