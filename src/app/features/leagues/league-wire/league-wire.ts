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
    let actorLabel = team?.teamName || (activity.ownerId ? 'A manager' : 'League activity');
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
      case 'commissioner-availability-override-set': {
        const playerName = activity.availabilityPlayerName || 'a player';
        const statusLabel = this.availabilityStatusLabel(activity.availabilityStatus);
        headline = `${commissionerLabel} marked ${playerName} ${statusLabel}.`;
        detail = 'League availability override';
        break;
      }
      case 'commissioner-availability-override-cleared': {
        const playerName = activity.availabilityPlayerName || 'a player';
        headline = `${commissionerLabel} cleared ${playerName}'s availability override.`;
        detail = 'The shared NHL injury report applies again.';
        break;
      }
      case 'commissioner-draft-opened':
        headline = `${commissionerLabel} opened the Draft.`;
        detail = activity.overallPick
          ? `The clock is running at Pick ${activity.overallPick}.`
          : 'The Draft clock is running.';
        break;
      case 'commissioner-draft-clock-paused':
        headline = `${commissionerLabel} paused the Draft clock.`;
        detail = activity.overallPick ? `Paused at Pick ${activity.overallPick}.` : null;
        break;
      case 'commissioner-draft-clock-resumed':
        headline = `${commissionerLabel} resumed the Draft clock.`;
        detail = activity.overallPick ? `Resumed at Pick ${activity.overallPick}.` : null;
        break;
      case 'matchup-result': {
        const teamA = activity.teamAOwnerId
          ? this.teamByOwnerId().get(activity.teamAOwnerId) ?? null
          : null;
        const teamB = activity.teamBOwnerId
          ? this.teamByOwnerId().get(activity.teamBOwnerId) ?? null
          : null;
        const teamALabel = teamA?.teamName || 'Team A';
        const teamBLabel = teamB?.teamName || 'Team B';
        const teamAScore = this.formatScore(activity.teamAScore);
        const teamBScore = this.formatScore(activity.teamBScore);
        const matchupContext = activity.matchupPhase === 'playoffs'
          ? activity.playoffRoundNumber
            ? `Playoff Round ${activity.playoffRoundNumber}`
            : 'Playoffs'
          : activity.matchupCycleNumber
            ? `Matchup ${activity.matchupCycleNumber}`
            : 'Final';

        if (!activity.winnerOwnerId) {
          actorLabel = 'Matchup final';
          headline = `${teamALabel} and ${teamBLabel} finished tied.`;
          detail = [`${teamAScore}–${teamBScore}`, matchupContext].join(' · ');
          break;
        }

        const winnerIsTeamA = activity.winnerOwnerId === activity.teamAOwnerId;
        const winnerTeam = winnerIsTeamA ? teamA : teamB;
        const winnerLabel = winnerIsTeamA ? teamALabel : teamBLabel;
        const loserLabel = winnerIsTeamA ? teamBLabel : teamALabel;
        const winnerScore = winnerIsTeamA ? teamAScore : teamBScore;
        const loserScore = winnerIsTeamA ? teamBScore : teamAScore;
        actorLabel = winnerTeam?.teamName || winnerLabel;

        if (activity.winnerPlace === 1) {
          headline = `${winnerLabel} won the RinkRat Championship.`;
          detail = `Defeated ${loserLabel}, ${winnerScore}–${loserScore}`;
        } else if (activity.winnerPlace) {
          headline = `${winnerLabel} claimed ${this.ordinalPlace(activity.winnerPlace)} place.`;
          detail = `${winnerScore}–${loserScore} over ${loserLabel}`;
        } else if (activity.matchupPhase === 'playoffs') {
          headline = `${winnerLabel} advanced past ${loserLabel}.`;
          detail = `${winnerScore}–${loserScore}`;
        } else {
          headline = `${winnerLabel} beat ${loserLabel}.`;
          detail = `${winnerScore}–${loserScore}`;
        }

        detail = [
          detail,
          activity.tieBrokenByHigherSeed ? 'Higher seed advanced' : null,
          matchupContext,
        ].filter(Boolean).join(' · ');
        break;
      }
    }

    return {
      id: activity.id,
      category: activity.category,
      categoryLabel: activity.category === 'draft'
        ? 'Draft'
        : activity.category === 'roster'
          ? 'Roster'
          : activity.category === 'matchup'
            ? 'Game Final'
            : activity.category === 'commissioner'
              ? 'Commissioner'
              : 'League',
      actorLabel,
      profileIconId: team?.profileIconId ?? null,
      headline,
      detail,
      occurredAt: activity.occurredAt,
    };
  }

  private availabilityStatusLabel(
    status: LeagueActivity['availabilityStatus'],
  ): string {
    switch (status) {
      case 'active':
        return 'Active';
      case 'day-to-day':
        return 'Day-to-Day';
      case 'out':
        return 'Out';
      case 'injured-reserve':
        return 'Injured Reserve';
      case 'long-term-injured-reserve':
        return 'Long-Term Injured Reserve';
      case 'suspended':
        return 'Suspended';
      case 'personal-leave':
        return 'Personal Leave';
      default:
        return 'Unknown';
    }
  }

  private formatScore(value: number | null): string {
    return value === null
      ? '—'
      : new Intl.NumberFormat(undefined, {
          maximumFractionDigits: 2,
        }).format(value);
  }

  private ordinalPlace(value: number): string {
    const lastTwoDigits = value % 100;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
      return `${value}th`;
    }

    switch (value % 10) {
      case 1:
        return `${value}st`;
      case 2:
        return `${value}nd`;
      case 3:
        return `${value}rd`;
      default:
        return `${value}th`;
    }
  }
}
