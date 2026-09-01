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
import { FormsModule } from '@angular/forms';

import {
  type LeagueActivity,
  type LeagueActivityCategory,
  type LeagueActivityEventType,
  type LeagueActivityReactionCounts,
  type LeagueActivityReactionRecord,
  type LeagueActivityReactionType,
  type PinnedLeagueAnnouncement,
} from '../../../core/league/league-activity.models';
import {
  createLeagueAnnouncementRequestId,
  LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH,
  LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES,
  LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH,
  normalizeLeagueAnnouncementBody,
  normalizeLeagueAnnouncementTitle,
  publishLeagueAnnouncement,
  unpinLeagueAnnouncement,
} from '../../../core/league/league-announcement.service';
import {
  listenToLeagueActivity,
  listenToPinnedLeagueAnnouncement,
} from '../../../core/league/league-activity.service';
import {
  leagueActivitySupportsReactions,
  loadLeagueEmojiCatalog,
  reactionOptionFromType,
  setLeagueActivityReaction,
  type LeagueActivityReactionOption,
  type SetLeagueActivityReactionResult,
} from '../../../core/league/league-activity-reaction.service';
import { type FantasyTeam } from '../../../core/team/team.service';
import {
  shareLeagueMatchupCard,
  type LeagueMatchupShareCardData,
} from '../../../core/league/league-matchup-share-card.service';
import { ManagerAvatar } from '../../../shared/manager-avatar/manager-avatar';

interface LeagueWireItem {
  id: string;
  category: LeagueActivityCategory;
  eventType: LeagueActivityEventType;
  categoryLabel: string;
  actorLabel: string;
  profileIconId: string | null;
  headline: string;
  detail: string | null;
  shareCard: LeagueMatchupShareCardData | null;
  reactionRecords: LeagueActivityReactionRecord[];
  reactionCounts: LeagueActivityReactionCounts;
  occurredAt: Date | null;
}

const COLLAPSED_ACTIVITY_COUNT = 5;
const REACTION_SUMMARY_LIMIT = 8;
const EMOJI_PICKER_PAGE_SIZE = 48;

@Component({
  selector: 'app-league-wire',
  standalone: true,
  imports: [FormsModule, ManagerAvatar],
  templateUrl: './league-wire.html',
  styleUrl: './league-wire.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeagueWire {
  private readonly destroyRef = inject(DestroyRef);

  readonly leagueId = input.required<string>();
  readonly leagueName = input('RinkRat League');
  readonly userId = input.required<string>();
  readonly teams = input<readonly FantasyTeam[]>([]);
  readonly isCommissioner = input(false);

  readonly activity = signal<LeagueActivity[]>([]);
  readonly loading = signal(true);
  readonly errorMessage = signal('');
  readonly expanded = signal(false);
  readonly now = signal(Date.now());
  readonly pinnedAnnouncement = signal<PinnedLeagueAnnouncement | null>(null);
  readonly pinnedAnnouncementError = signal('');
  readonly announcementComposerOpen = signal(false);
  readonly announcementTitleDraft = signal('');
  readonly announcementBodyDraft = signal('');
  readonly announcementPinDraft = signal(false);
  readonly announcementSaving = signal(false);
  readonly announcementUnpinning = signal(false);
  readonly announcementStatusMessage = signal('');
  readonly announcementErrorMessage = signal('');
  readonly openReactionActivityId = signal('');
  readonly reactionSavingActivityId = signal('');
  readonly reactionStatusMessage = signal('');
  readonly reactionErrors = signal<Record<string, string>>({});
  readonly shareSavingActivityId = signal('');
  readonly shareStatusMessages = signal<Record<string, string>>({});
  readonly shareErrors = signal<Record<string, string>>({});
  readonly emojiCatalog = signal<readonly LeagueActivityReactionOption[]>([]);
  readonly emojiCatalogGroups = signal<readonly string[]>([]);
  readonly emojiCatalogVersion = signal('');
  readonly emojiCatalogLoading = signal(false);
  readonly emojiCatalogError = signal('');
  readonly emojiSearch = signal('');
  readonly emojiGroupIndex = signal(0);
  readonly emojiVisibleLimit = signal(EMOJI_PICKER_PAGE_SIZE);
  readonly emojiLabelByValue = signal<ReadonlyMap<string, string>>(new Map());

  private readonly announcementRequestId = signal('');

  private readonly teamByOwnerId = computed(() =>
    new Map(this.teams().map((team) => [team.ownerId, team] as const)),
  );


  private readonly pinnedAnnouncementTeam = computed(() => {
    const ownerId = this.pinnedAnnouncement()?.ownerId;
    return ownerId ? this.teamByOwnerId().get(ownerId) ?? null : null;
  });

  readonly pinnedAnnouncementActorLabel = computed(() =>
    this.pinnedAnnouncementTeam()?.teamName || 'The commissioner',
  );

  readonly pinnedAnnouncementProfileIconId = computed(() =>
    this.pinnedAnnouncementTeam()?.profileIconId ?? null,
  );

  readonly announcementTitleRemaining = computed(() =>
    Math.max(
      0,
      LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH - this.announcementTitleDraft().length,
    ),
  );

  readonly announcementBodyRemaining = computed(() =>
    Math.max(
      0,
      LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH - this.announcementBodyDraft().length,
    ),
  );

  readonly announcementBodyLineCount = computed(() => {
    const body = normalizeLeagueAnnouncementBody(this.announcementBodyDraft());
    return body ? body.split('\n').length : 0;
  });

  readonly canPostAnnouncement = computed(() => {
    const title = normalizeLeagueAnnouncementTitle(this.announcementTitleDraft());
    const body = normalizeLeagueAnnouncementBody(this.announcementBodyDraft());
    const lineCount = body ? body.split('\n').length : 0;

    return this.isCommissioner() &&
      !this.announcementSaving() &&
      title.length > 0 &&
      title.length <= LEAGUE_ANNOUNCEMENT_TITLE_MAX_LENGTH &&
      body.length > 0 &&
      body.length <= LEAGUE_ANNOUNCEMENT_BODY_MAX_LENGTH &&
      lineCount <= LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES;
  });

  readonly filteredEmojiOptions = computed<readonly LeagueActivityReactionOption[]>(() => {
    const search = this.emojiSearch().trim().toLocaleLowerCase();

    if (search) {
      return this.emojiCatalog().filter((option) =>
        (option.emoji?.includes(search) ?? false) || option.label.toLocaleLowerCase().includes(search),
      );
    }

    const groupIndex = this.emojiGroupIndex();
    return this.emojiCatalog().filter((option) => option.groupIndex === groupIndex);
  });

  readonly visibleEmojiOptions = computed(() =>
    this.filteredEmojiOptions().slice(0, this.emojiVisibleLimit()),
  );

  readonly hiddenEmojiOptionCount = computed(() =>
    Math.max(0, this.filteredEmojiOptions().length - this.visibleEmojiOptions().length),
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
      this.openReactionActivityId.set('');
      this.reactionSavingActivityId.set('');
      this.reactionStatusMessage.set('');
      this.reactionErrors.set({});
      this.shareSavingActivityId.set('');
      this.shareStatusMessages.set({});
      this.shareErrors.set({});
      this.emojiSearch.set('');
      this.emojiGroupIndex.set(0);
      this.emojiVisibleLimit.set(EMOJI_PICKER_PAGE_SIZE);
      this.emojiCatalogError.set('');

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

    effect((onCleanup) => {
      const leagueId = this.leagueId().trim();

      this.pinnedAnnouncement.set(null);
      this.pinnedAnnouncementError.set('');
      this.resetAnnouncementComposer();
      this.announcementStatusMessage.set('');

      if (!leagueId) {
        return;
      }

      const stop = listenToPinnedLeagueAnnouncement(
        leagueId,
        (announcement) => {
          this.pinnedAnnouncement.set(announcement);
          this.pinnedAnnouncementError.set('');
        },
        () => {
          this.pinnedAnnouncementError.set(
            'The pinned announcement could not be loaded. The rest of League Wire is still available.',
          );
        },
      );

      onCleanup(stop);
    });

    const clock = setInterval(() => this.now.set(Date.now()), 60_000);
    this.destroyRef.onDestroy(() => clearInterval(clock));
  }


  supportsReactions(item: LeagueWireItem): boolean {
    return Boolean(this.userId().trim()) && leagueActivitySupportsReactions(item.eventType);
  }

  currentReactionType(item: LeagueWireItem): LeagueActivityReactionType | null {
    const userId = this.userId().trim();

    return userId
      ? item.reactionRecords.find((record) => record.ownerId === userId)?.reactionType ?? null
      : null;
  }

  reactionCount(
    item: LeagueWireItem,
    reactionType: LeagueActivityReactionType,
  ): number {
    return item.reactionCounts[reactionType] ?? 0;
  }

  reactionSummaryOptions(item: LeagueWireItem): readonly LeagueActivityReactionOption[] {
    const selected = this.currentReactionType(item);
    const labels = this.emojiLabelByValue();

    return Object.entries(item.reactionCounts)
      .filter(([, count]) => Number.isInteger(count) && count > 0)
      .sort(([leftType, leftCount], [rightType, rightCount]) => {
        if (leftType === selected && rightType !== selected) {
          return -1;
        }
        if (rightType === selected && leftType !== selected) {
          return 1;
        }
        return rightCount - leftCount || leftType.localeCompare(rightType);
      })
      .slice(0, REACTION_SUMMARY_LIMIT)
      .map(([reactionType]) => reactionOptionFromType(
        reactionType,
        labels.get(reactionType),
      ));
  }

  hiddenReactionSummaryCount(item: LeagueWireItem): number {
    const usedReactionCount = Object.values(item.reactionCounts)
      .filter((count) => Number.isInteger(count) && count > 0)
      .length;
    return Math.max(0, usedReactionCount - REACTION_SUMMARY_LIMIT);
  }

  reactionError(item: LeagueWireItem): string {
    return this.reactionErrors()[item.id] ?? '';
  }

  isReactionPickerOpen(item: LeagueWireItem): boolean {
    return this.openReactionActivityId() === item.id;
  }

  isReactionSaving(item: LeagueWireItem): boolean {
    return this.reactionSavingActivityId() === item.id;
  }

  toggleReactionPicker(item: LeagueWireItem): void {
    if (!this.supportsReactions(item) || this.isReactionSaving(item)) {
      return;
    }

    const opening = this.openReactionActivityId() !== item.id;
    this.openReactionActivityId.set(opening ? item.id : '');
    this.clearReactionError(item.id);

    if (opening) {
      this.emojiSearch.set('');
      this.emojiGroupIndex.set(0);
      this.emojiVisibleLimit.set(EMOJI_PICKER_PAGE_SIZE);
      void this.ensureEmojiCatalogLoaded();
    }
  }

  updateEmojiSearch(value: string): void {
    this.emojiSearch.set(value);
    this.emojiVisibleLimit.set(EMOJI_PICKER_PAGE_SIZE);
  }

  selectEmojiGroup(groupIndex: number): void {
    this.emojiGroupIndex.set(groupIndex);
    this.emojiSearch.set('');
    this.emojiVisibleLimit.set(EMOJI_PICKER_PAGE_SIZE);
  }

  selectEmojiGroupFromInput(value: number | string): void {
    const groupIndex = typeof value === 'number' ? value : Number.parseInt(value, 10);

    if (
      Number.isInteger(groupIndex) &&
      groupIndex >= 0 &&
      groupIndex < this.emojiCatalogGroups().length
    ) {
      this.selectEmojiGroup(groupIndex);
    }
  }

  isEmojiGroupSelected(groupIndex: number): boolean {
    return !this.emojiSearch().trim() && this.emojiGroupIndex() === groupIndex;
  }

  showMoreEmojis(): void {
    this.emojiVisibleLimit.update((limit) => limit + EMOJI_PICKER_PAGE_SIZE);
  }

  async chooseReaction(
    item: LeagueWireItem,
    option: LeagueActivityReactionOption,
  ): Promise<void> {
    if (!this.supportsReactions(item) || this.reactionSavingActivityId()) {
      return;
    }

    const currentReactionType = this.currentReactionType(item);
    const desiredReactionType = currentReactionType === option.reactionType
      ? null
      : option.reactionType;

    this.reactionSavingActivityId.set(item.id);
    this.reactionStatusMessage.set('');
    this.clearReactionError(item.id);

    try {
      const result = await setLeagueActivityReaction({
        leagueId: this.leagueId(),
        activityId: item.id,
        reactionType: desiredReactionType,
      });

      this.applyReactionResult(result);
      this.openReactionActivityId.set('');
      this.reactionStatusMessage.set(
        result.reactionType
          ? `${option.label} reaction saved.`
          : 'Reaction removed.',
      );
    } catch (error) {
      this.reactionErrors.update((errors) => ({
        ...errors,
        [item.id]: error instanceof Error
          ? error.message
          : 'Unable to update that reaction right now.',
      }));
    } finally {
      this.reactionSavingActivityId.set('');
    }
  }

  reactionAriaLabel(
    item: LeagueWireItem,
    option: LeagueActivityReactionOption,
  ): string {
    const count = this.reactionCount(item, option.reactionType);
    const selected = this.currentReactionType(item) === option.reactionType;
    const countLabel = `${count} ${count === 1 ? 'reaction' : 'reactions'}`;

    return selected
      ? `${option.label}, selected, ${countLabel}. Press to remove.`
      : `${option.label}, ${countLabel}. Press to react.`;
  }

  private async ensureEmojiCatalogLoaded(): Promise<void> {
    if (this.emojiCatalog().length || this.emojiCatalogLoading()) {
      return;
    }

    this.emojiCatalogLoading.set(true);
    this.emojiCatalogError.set('');

    try {
      const catalog = await loadLeagueEmojiCatalog();
      this.emojiCatalog.set(catalog.options);
      this.emojiCatalogGroups.set(catalog.groups);
      this.emojiCatalogVersion.set(catalog.version);
      this.emojiLabelByValue.set(new Map(
        catalog.options.map((option) => [option.reactionType, option.label] as const),
      ));
    } catch {
      this.emojiCatalogError.set(
        'The emoji list could not load. Close the picker and try again.',
      );
    } finally {
      this.emojiCatalogLoading.set(false);
    }
  }

  private applyReactionResult(result: SetLeagueActivityReactionResult): void {
    const userId = this.userId().trim();
    const changedAt = new Date();

    this.activity.update((activityItems) => activityItems.map((activity) => {
      if (activity.id !== result.activityId || !userId) {
        return activity;
      }

      const existing = activity.reactionRecords.find((record) => record.ownerId === userId);
      const reactionRecords = activity.reactionRecords.filter(
        (record) => record.ownerId !== userId,
      );

      if (result.reactionType) {
        reactionRecords.push({
          ownerId: userId,
          reactionType: result.reactionType,
          firstChangedAt: existing?.firstChangedAt ?? changedAt,
          updatedAt: changedAt,
        });
        reactionRecords.sort((left, right) => left.ownerId.localeCompare(right.ownerId));
      }

      return {
        ...activity,
        reactionRecords,
        reactionCounts: result.reactionCounts,
      };
    }));
  }

  private clearReactionError(activityId: string): void {
    this.reactionErrors.update((errors) => {
      if (!errors[activityId]) {
        return errors;
      }

      const nextErrors = { ...errors };
      delete nextErrors[activityId];
      return nextErrors;
    });
  }


  canShareMatchupCard(item: LeagueWireItem): boolean {
    return item.shareCard !== null;
  }

  isShareCardSaving(item: LeagueWireItem): boolean {
    return this.shareSavingActivityId() === item.id;
  }

  shareCardStatus(item: LeagueWireItem): string {
    return this.shareStatusMessages()[item.id] ?? '';
  }

  shareCardError(item: LeagueWireItem): string {
    return this.shareErrors()[item.id] ?? '';
  }

  shareCardButtonLabel(item: LeagueWireItem): string {
    if (this.isShareCardSaving(item)) {
      return 'Preparing card...';
    }

    return item.shareCard?.championship
      ? 'Share championship'
      : 'Share result';
  }

  async shareMatchupResult(item: LeagueWireItem): Promise<void> {
    if (!item.shareCard || this.shareSavingActivityId()) {
      return;
    }

    this.shareSavingActivityId.set(item.id);
    this.clearShareFeedback(item.id);

    try {
      const result = await shareLeagueMatchupCard(item.shareCard);

      if (result.outcome !== 'cancelled' && result.message) {
        this.shareStatusMessages.update((messages) => ({
          ...messages,
          [item.id]: result.message,
        }));
      }
    } catch (error) {
      this.shareErrors.update((errors) => ({
        ...errors,
        [item.id]: error instanceof Error
          ? error.message
          : 'Unable to prepare that share card right now.',
      }));
    } finally {
      this.shareSavingActivityId.set('');
    }
  }

  private clearShareFeedback(activityId: string): void {
    this.shareStatusMessages.update((messages) => {
      if (!messages[activityId]) {
        return messages;
      }

      const nextMessages = { ...messages };
      delete nextMessages[activityId];
      return nextMessages;
    });

    this.shareErrors.update((errors) => {
      if (!errors[activityId]) {
        return errors;
      }

      const nextErrors = { ...errors };
      delete nextErrors[activityId];
      return nextErrors;
    });
  }


  toggleAnnouncementComposer(): void {
    if (!this.isCommissioner()) {
      return;
    }

    if (this.announcementComposerOpen()) {
      this.resetAnnouncementComposer();
      return;
    }

    this.announcementComposerOpen.set(true);
    this.announcementErrorMessage.set('');
    this.announcementStatusMessage.set('');
  }

  cancelAnnouncementComposer(): void {
    this.resetAnnouncementComposer();
  }

  updateAnnouncementTitle(value: string): void {
    this.announcementTitleDraft.set(value);
    this.resetAnnouncementSubmissionIdentity();
  }

  updateAnnouncementBody(value: string): void {
    this.announcementBodyDraft.set(value);
    this.resetAnnouncementSubmissionIdentity();
  }

  updateAnnouncementPin(value: boolean): void {
    this.announcementPinDraft.set(value);
    this.resetAnnouncementSubmissionIdentity();
  }

  async submitAnnouncement(): Promise<void> {
    if (!this.canPostAnnouncement()) {
      this.announcementErrorMessage.set(
        `Add a title and a message no longer than ${LEAGUE_ANNOUNCEMENT_BODY_MAX_LINES} lines.`,
      );
      return;
    }

    const requestId = this.announcementRequestId() || createLeagueAnnouncementRequestId();
    this.announcementRequestId.set(requestId);
    this.announcementSaving.set(true);
    this.announcementErrorMessage.set('');
    this.announcementStatusMessage.set('');

    try {
      const result = await publishLeagueAnnouncement({
        leagueId: this.leagueId(),
        title: this.announcementTitleDraft(),
        body: this.announcementBodyDraft(),
        pin: this.announcementPinDraft(),
        requestId,
      });

      this.resetAnnouncementComposer();
      this.announcementStatusMessage.set(
        result.pinned
          ? 'Announcement posted and pinned for the league.'
          : 'Announcement posted to League Wire.',
      );
    } catch (error) {
      this.announcementErrorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to post the announcement right now.',
      );
    } finally {
      this.announcementSaving.set(false);
    }
  }

  async unpinCurrentAnnouncement(): Promise<void> {
    if (!this.isCommissioner() || this.announcementUnpinning()) {
      return;
    }

    this.announcementUnpinning.set(true);
    this.announcementErrorMessage.set('');
    this.announcementStatusMessage.set('');

    try {
      const result = await unpinLeagueAnnouncement(this.leagueId());
      this.announcementStatusMessage.set(
        result.unpinned
          ? 'Announcement unpinned. It remains in League Wire history.'
          : 'There was no pinned announcement to remove.',
      );
    } catch (error) {
      this.announcementErrorMessage.set(
        error instanceof Error
          ? error.message
          : 'Unable to unpin the announcement right now.',
      );
    } finally {
      this.announcementUnpinning.set(false);
    }
  }

  private resetAnnouncementSubmissionIdentity(): void {
    this.announcementRequestId.set('');
    this.announcementErrorMessage.set('');
    this.announcementStatusMessage.set('');
  }

  private resetAnnouncementComposer(): void {
    this.announcementComposerOpen.set(false);
    this.announcementTitleDraft.set('');
    this.announcementBodyDraft.set('');
    this.announcementPinDraft.set(false);
    this.announcementRequestId.set('');
    this.announcementErrorMessage.set('');
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
    let shareCard: LeagueMatchupShareCardData | null = null;

    switch (activity.eventType) {
      case 'league-created':
        headline = `${commissionerLabel} opened the league.`;
        detail = 'The rink is ready for managers.';
        break;
      case 'member-joined':
        headline = `${managerLabel} joined the league.`;
        break;
      case 'member-removed':
        headline = `${commissionerLabel} removed a manager before the Draft.`;
        detail = 'The open league spot is available again.';
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
      case 'commissioner-announcement':
        actorLabel = commissionerLabel;
        headline = activity.announcementTitle || 'Commissioner announcement';
        detail = activity.announcementBody;
        break;
      case 'matchup-round-recap': {
        const cycleNumber = activity.recapCycleNumber;
        const topScoreOwnerIds = activity.recapTopScoreOwnerIds;
        const topScoreLabels = topScoreOwnerIds.map((ownerId) =>
          this.teamByOwnerId().get(ownerId)?.teamName || 'A team',
        );
        const topScoreLabel = this.joinLabels(topScoreLabels);
        const closestTeamA = activity.recapClosestTeamAOwnerId
          ? this.teamByOwnerId().get(activity.recapClosestTeamAOwnerId) ?? null
          : null;
        const closestTeamB = activity.recapClosestTeamBOwnerId
          ? this.teamByOwnerId().get(activity.recapClosestTeamBOwnerId) ?? null
          : null;
        const closestTeamALabel = closestTeamA?.teamName || 'Team A';
        const closestTeamBLabel = closestTeamB?.teamName || 'Team B';
        const closestWinnerLabel = activity.recapClosestWinnerOwnerId === activity.recapClosestTeamAOwnerId
          ? closestTeamALabel
          : activity.recapClosestWinnerOwnerId === activity.recapClosestTeamBOwnerId
            ? closestTeamBLabel
            : null;
        const closestFinish = closestWinnerLabel
          ? `${closestWinnerLabel} by ${this.formatScore(activity.recapClosestMargin)}`
          : `${closestTeamALabel} and ${closestTeamBLabel} tied`;

        actorLabel = topScoreOwnerIds.length === 1
          ? topScoreLabel
          : 'Round recap';

        if (activity.recapNewLeagueHighScore) {
          headline = topScoreOwnerIds.length === 1
            ? `${topScoreLabel} set a new League Wire scoring high.`
            : `${topScoreLabel} shared a new League Wire scoring high.`;
        } else {
          headline = cycleNumber
            ? `Matchup ${cycleNumber} is in the books.`
            : 'The matchup round is complete.';
        }

        const performerLabels = activity.recapTopPerformers.map((performer) => {
          const teamName = this.teamByOwnerId().get(performer.ownerId)?.teamName;
          return teamName
            ? `${performer.asset.name} (${teamName})`
            : performer.asset.name;
        });
        const omittedPerformerCount = Math.max(
          0,
          activity.recapTopPerformerTieCount - performerLabels.length,
        );
        const performerLabel = performerLabels.length > 0
          ? `${this.joinLabels(performerLabels)}${
            omittedPerformerCount > 0 ? ` +${omittedPerformerCount} tied` : ''
          }`
          : '';
        const performerDetail = performerLabel && activity.recapTopPerformerScore !== null
          ? `${activity.recapTopPerformerTieCount > 1 ? 'Players of the Round' : 'Player of the Round'}: ` +
            `${performerLabel} · ${this.formatScore(activity.recapTopPerformerScore)}`
          : null;
        const pickupLabels = activity.recapTopPickups.map((pickup) => {
          const teamName = this.teamByOwnerId().get(pickup.ownerId)?.teamName;
          return teamName
            ? `${pickup.asset.name} (${teamName})`
            : pickup.asset.name;
        });
        const omittedPickupCount = Math.max(
          0,
          activity.recapTopPickupTieCount - pickupLabels.length,
        );
        const pickupLabel = pickupLabels.length > 0
          ? `${this.joinLabels(pickupLabels)}${
            omittedPickupCount > 0 ? ` +${omittedPickupCount} tied` : ''
          }`
          : '';
        const pickupDetail = pickupLabel && activity.recapTopPickupScore !== null
          ? `${activity.recapTopPickupTieCount > 1 ? 'Pickups of the Round' : 'Pickup of the Round'}: ` +
            `${pickupLabel} · ${this.formatScore(activity.recapTopPickupScore)}`
          : null;
        const upsetWinnerLabel = activity.recapUpsetWinnerOwnerId
          ? this.teamByOwnerId().get(activity.recapUpsetWinnerOwnerId)?.teamName || 'The underdog'
          : null;
        const upsetLoserLabel = activity.recapUpsetLoserOwnerId
          ? this.teamByOwnerId().get(activity.recapUpsetLoserOwnerId)?.teamName || 'the favorite'
          : null;
        const upsetDetail = upsetWinnerLabel &&
            upsetLoserLabel &&
            activity.recapUpsetProjectionGap !== null
          ? `Biggest upset: ${upsetWinnerLabel} over ${upsetLoserLabel} · ` +
            `${this.formatScore(activity.recapUpsetProjectionGap)}-point projected underdog`
          : null;
        const recapDetails = [
          `Top team: ${topScoreLabel} · ${this.formatScore(activity.recapTopScore)}`,
        ];

        if (performerDetail) {
          recapDetails.push(performerDetail);
        }

        if (pickupDetail) {
          recapDetails.push(pickupDetail);
        }

        if (upsetDetail) {
          recapDetails.push(upsetDetail);
        }

        recapDetails.push(`Closest: ${closestFinish}`);
        detail = recapDetails.join('\n');
        break;
      }
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
        const hasShareableScores = Number.isFinite(activity.teamAScore) &&
          Number.isFinite(activity.teamBScore);
        const winnerIsTeamA = Boolean(activity.winnerOwnerId) &&
          activity.winnerOwnerId === activity.teamAOwnerId;
        const winnerIsTeamB = Boolean(activity.winnerOwnerId) &&
          activity.winnerOwnerId === activity.teamBOwnerId;
        const shareWinnerLabel = winnerIsTeamA
          ? teamALabel
          : winnerIsTeamB
            ? teamBLabel
            : null;

        if (hasShareableScores) {
          shareCard = {
            leagueName: this.leagueName(),
            teamAName: teamALabel,
            teamBName: teamBLabel,
            teamAScore: activity.teamAScore ?? 0,
            teamBScore: activity.teamBScore ?? 0,
            winnerTeamName: shareWinnerLabel,
            contextLabel: activity.winnerPlace === 1
              ? 'RinkRat Championship'
              : activity.winnerPlace
                ? `${this.ordinalPlace(activity.winnerPlace)} Place Final`
                : matchupContext,
            championship: activity.winnerPlace === 1,
            tieBrokenByHigherSeed: activity.tieBrokenByHigherSeed,
          };
        }

        if (!activity.winnerOwnerId) {
          actorLabel = 'Matchup final';
          headline = `${teamALabel} and ${teamBLabel} finished tied.`;
          detail = [`${teamAScore}–${teamBScore}`, matchupContext].join(' · ');
          break;
        }

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
      eventType: activity.eventType,
      categoryLabel: activity.category === 'draft'
        ? 'Draft'
        : activity.category === 'roster'
          ? 'Roster'
          : activity.category === 'matchup'
            ? 'Game Final'
            : activity.category === 'commissioner'
              ? 'Commissioner'
              : activity.category === 'announcement'
                ? 'Announcement'
                : activity.category === 'recap'
                  ? 'Round Recap'
                  : 'League',
      actorLabel,
      profileIconId: team?.profileIconId ?? null,
      headline,
      detail,
      shareCard,
      reactionRecords: activity.reactionRecords,
      reactionCounts: activity.reactionCounts,
      occurredAt: activity.occurredAt,
    };
  }

  private joinLabels(labels: readonly string[]): string {
    if (labels.length === 0) {
      return 'A team';
    }

    if (labels.length === 1) {
      return labels[0];
    }

    if (labels.length === 2) {
      return `${labels[0]} and ${labels[1]}`;
    }

    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
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
