import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { BUNDLED_RELEASE_MANIFEST } from '../../../../environments/generated-release-manifest';

import type {
  PrivateSeasonControlCenterSnapshot,
  PrivateSeasonDevice,
  PrivateSeasonExperience,
  PrivateSeasonGateOutcome,
  PrivateSeasonLeagueSlot,
  PrivateSeasonLiveLeagueEvidence,
  PrivateSeasonPlan,
  PrivateSeasonTester,
} from '../../../core/operations/private-season.models';
import { PrivateSeasonService } from '../../../core/operations/private-season.service';
import { createPrivateSeasonFreezeEvidenceReport } from '../../../core/release/private-season-freeze-evidence.util';
import { AdminSessionStepUp } from '../../../shared/admin-session-step-up/admin-session-step-up';

function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 18)
    ?? `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function emptyPlan(): PrivateSeasonPlan {
  return {
    schemaVersion: 1,
    seasonLabel: '2026-27',
    revision: 0,
    status: 'planning',
    leagueSlots: [],
    testers: [],
    support: {
      primaryOwner: 'Stephen',
      deputyAlias: '',
      supportChannelReady: false,
      knownIssuesReady: false,
      rollbackRehearsed: false,
      deputyConfirmed: false,
      coverageConfirmed: false,
    },
    freeze: {
      featureFreezeConfirmed: false,
      approvedReleaseLabel: '',
      approvedBuildId: '',
      nonGoals: [],
    },
    latestDecision: null,
    updatedAt: null,
    updatedBy: '',
  };
}

function clonePlan(plan: PrivateSeasonPlan): PrivateSeasonPlan {
  return structuredClone(plan);
}

@Component({
  selector: 'app-private-season-center',
  standalone: true,
  imports: [FormsModule, RouterLink, AdminSessionStepUp],
  templateUrl: './private-season-center.html',
  styleUrl: './private-season-center.css',
})
export class PrivateSeasonCenter {
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly saving = signal(false);
  readonly deciding = signal(false);
  readonly copyingFreezeEvidence = signal(false);
  readonly errorMessage = signal('');
  readonly successMessage = signal('');
  readonly snapshot = signal<PrivateSeasonControlCenterSnapshot | null>(null);
  readonly readiness = computed(() => this.snapshot()?.readiness ?? null);

  readonly experienceOptions: Array<{ value: PrivateSeasonExperience; label: string }> = [
    { value: 'hockey-expert', label: 'Hockey expert' },
    { value: 'casual-fan', label: 'Casual fan' },
    { value: 'fantasy-beginner', label: 'Fantasy beginner' },
  ];
  readonly deviceOptions: Array<{ value: PrivateSeasonDevice; label: string }> = [
    { value: 'iphone', label: 'iPhone' },
    { value: 'android', label: 'Android' },
    { value: 'desktop', label: 'Desktop' },
  ];

  draftPlan: PrivateSeasonPlan = emptyPlan();
  saveReason = '';
  decisionReason = '';
  decisionOutcome: PrivateSeasonGateOutcome = 'approved';

  constructor(private readonly privateSeason: PrivateSeasonService) {
    void this.load();
  }

  async load(refresh = false): Promise<void> {
    if (this.refreshing()) return;
    this.errorMessage.set('');
    this.successMessage.set('');
    refresh ? this.refreshing.set(true) : this.loading.set(true);

    try {
      const snapshot = await this.privateSeason.load();
      this.applySnapshot(snapshot);
      if (refresh) this.successMessage.set('Private-season evidence refreshed.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to load the private-season control center.'));
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  addLeague(): void {
    const maximum = this.snapshot()?.policy.maximumLeagues ?? 4;
    if (this.draftPlan.leagueSlots.length >= maximum) return;
    const number = this.draftPlan.leagueSlots.length + 1;
    this.draftPlan.leagueSlots.push({
      slotId: newId('league-slot'),
      leagueId: '',
      label: `Tester League ${number}`,
      expectedManagerCount: 6,
      draftRehearsalComplete: false,
      active: true,
    });
  }

  removeLeague(slot: PrivateSeasonLeagueSlot): void {
    this.draftPlan.leagueSlots = this.draftPlan.leagueSlots.filter((entry) => entry.slotId !== slot.slotId);
    for (const tester of this.draftPlan.testers) {
      tester.leagueSlotIds = tester.leagueSlotIds.filter((slotId) => slotId !== slot.slotId);
    }
  }

  addTester(): void {
    const maximum = this.snapshot()?.policy.maximumTesters ?? 30;
    if (this.draftPlan.testers.length >= maximum) return;
    const number = this.draftPlan.testers.length + 1;
    const firstActiveLeagueId = this.draftPlan.leagueSlots.find((entry) => entry.active)?.slotId;
    this.draftPlan.testers.push({
      testerId: newId('tester'),
      alias: `Tester ${number}`,
      leagueSlotIds: firstActiveLeagueId ? [firstActiveLeagueId] : [],
      role: 'manager',
      experience: 'casual-fan',
      devices: [],
      isFounder: false,
      contactConfirmed: false,
      consentConfirmed: false,
      accountReady: false,
      draftRehearsalComplete: false,
    });
  }

  removeTester(tester: PrivateSeasonTester): void {
    this.draftPlan.testers = this.draftPlan.testers.filter((entry) => entry.testerId !== tester.testerId);
  }

  setLeagueAssignment(tester: PrivateSeasonTester, slotId: string, checked: boolean): void {
    const assignments = new Set(tester.leagueSlotIds);
    checked ? assignments.add(slotId) : assignments.delete(slotId);
    tester.leagueSlotIds = [...assignments];
  }

  leagueAssigned(tester: PrivateSeasonTester, slotId: string): boolean {
    return tester.leagueSlotIds.includes(slotId);
  }

  setDevice(tester: PrivateSeasonTester, device: PrivateSeasonDevice, checked: boolean): void {
    const devices = new Set(tester.devices);
    checked ? devices.add(device) : devices.delete(device);
    tester.devices = [...devices];
  }

  deviceChecked(tester: PrivateSeasonTester, device: PrivateSeasonDevice): boolean {
    return tester.devices.includes(device);
  }

  updateNonGoals(value: string): void {
    this.draftPlan.freeze.nonGoals = [...new Set(value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean))]
      .slice(0, 12);
  }

  nonGoalsText(): string {
    return this.draftPlan.freeze.nonGoals.join('\n');
  }

  useCurrentBuild(): void {
    const build = this.snapshot()?.build;
    if (!build) return;
    this.draftPlan.freeze.approvedReleaseLabel = build.releaseLabel;
    this.draftPlan.freeze.approvedBuildId = build.buildId;
    this.draftPlan.freeze.featureFreezeConfirmed = true;
  }

  liveEvidence(slotId: string): PrivateSeasonLiveLeagueEvidence | null {
    return this.readiness()?.liveLeagueEvidence.find((entry) => entry.slotId === slotId) ?? null;
  }

  async savePlan(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.privateSeason.save({
        expectedRevision: this.snapshot()?.plan.revision ?? this.draftPlan.revision,
        plan: this.draftPlan,
        reason: this.saveReason,
      });
      this.applySnapshot(snapshot);
      this.saveReason = '';
      this.successMessage.set('Private-season plan saved and audited.');
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to save the private-season plan.'));
    } finally {
      this.saving.set(false);
    }
  }

  async recordDecision(): Promise<void> {
    if (this.deciding()) return;
    this.deciding.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');

    try {
      const snapshot = await this.privateSeason.recordDecision({
        expectedRevision: this.snapshot()?.plan.revision ?? this.draftPlan.revision,
        outcome: this.decisionOutcome,
        reason: this.decisionReason,
      });
      this.applySnapshot(snapshot);
      this.decisionReason = '';
      this.successMessage.set(
        this.decisionOutcome === 'approved'
          ? 'The exact private-season release was approved and recorded.'
          : 'The private season was delayed and the reason was recorded.',
      );
    } catch (error: unknown) {
      this.errorMessage.set(this.friendlyError(error, 'Unable to record the go/no-go decision.'));
    } finally {
      this.deciding.set(false);
    }
  }

  async copyFreezeEvidence(): Promise<void> {
    const snapshot = this.snapshot();

    if (!snapshot || this.copyingFreezeEvidence()) {
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard?.writeText
    ) {
      this.errorMessage.set('Clipboard access is unavailable in this browser.');
      return;
    }

    this.copyingFreezeEvidence.set(true);
    this.errorMessage.set('');

    const report = createPrivateSeasonFreezeEvidenceReport({
      snapshot,
      build: BUNDLED_RELEASE_MANIFEST,
    });

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      this.successMessage.set(
        report.gate.readyForFreeze
          ? 'Private-season freeze evidence copied for the exact approved build.'
          : `Private-season freeze evidence copied with ${report.gate.blockers.length} blocker(s).`,
      );
    } catch {
      this.errorMessage.set('The private-season freeze evidence could not be copied automatically.');
    } finally {
      this.copyingFreezeEvidence.set(false);
    }
  }

  async copySummary(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    const summary = [
      `RinkRat Private Season ${snapshot.plan.seasonLabel}`,
      `${snapshot.build.releaseLabel} · Scoring V${snapshot.build.scoringRulesVersion} · Projection V${snapshot.build.projectionVersion}`,
      `Status: ${this.label(snapshot.plan.status)}`,
      `Leagues: ${snapshot.readiness.leagueCount}`,
      `Tester aliases: ${snapshot.readiness.testerCount}`,
      `Non-founder commissioners: ${snapshot.readiness.nonFounderCommissionerCount}`,
      `Gate: ${snapshot.readiness.headline}`,
      ...snapshot.readiness.blockers.map((item) => `BLOCKER: ${item}`),
      ...snapshot.readiness.advisories.map((item) => `ADVISORY: ${item}`),
    ].join('\n');

    try {
      await navigator.clipboard.writeText(summary);
      this.successMessage.set('Copied the privacy-limited private-season summary.');
    } catch {
      this.errorMessage.set('The summary could not be copied automatically.');
    }
  }

  print(): void {
    window.print();
  }

  label(value: string): string {
    return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  formatDate(value: string | null): string {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(date)
      : 'Not recorded';
  }

  private applySnapshot(snapshot: PrivateSeasonControlCenterSnapshot): void {
    this.snapshot.set(snapshot);
    this.draftPlan = clonePlan(snapshot.plan);
  }

  private friendlyError(error: unknown, fallback: string): string {
    const value = error as { message?: unknown; details?: unknown } | null;
    if (typeof value?.message === 'string' && value.message.trim()) {
      return value.message.replace(/^Firebase:\s*/i, '').trim();
    }
    return fallback;
  }
}
