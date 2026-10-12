import {
  buildSourceNhlTargetGameIdsByTeam,
  getCycleGameEndIndex,
  getCycleGameStartIndex,
  resolveFrozenSeasonSourceGameIdsByTeam,
  resolveSourceNhlBlockNumber,
  selectGamesByStableIds,
} from '../cycle/cycle-window-selection.util';
import type {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyMatchup,
  FantasySeasonPhase,
} from '../cycle/cycle.models';
import type { CycleSchedulePreviewCycle } from '../cycle/cycle.service';
import type { DraftableAsset, FantasyDraft, DraftPosition } from '../draft/draft.models';
import type { NhlTeamSeasonGame } from '../nhl/nhl-api.service';
import type {
  ActiveRosterSlot,
  FantasyRoster,
  PendingRosterSlotMove,
  RosterAsset,
} from './roster.models';
import type { FantasyTeam } from './team.service';
import type {
  FutureMatchupLineupPlanView,
  FutureMatchupLineupSlotInput,
  FutureMatchupLineupSlotResolution,
} from './future-matchup-lineup.models';

export type FutureMatchupOptionTiming = 'current' | 'future';

export interface FutureMatchupLineupOption {
  cycleNumber: number;
  matchupId: string;
  opponentOwnerId: string | null;
  opponentTeamName: string | null;
  phase: FantasySeasonPhase;
  timing: FutureMatchupOptionTiming;
  materialized: boolean;
  isBye: boolean;
  sourceNhlBlockNumber: number;
  label: string;
}

export interface BuildFutureMatchupLineupOptionsInput {
  ownerId: string;
  teams: readonly FantasyTeam[];
  cycles: readonly FantasyCycle[];
  schedulePreview: readonly CycleSchedulePreviewCycle[];
  currentMatchup: FantasyMatchup | null;
  initialNhlBlockNumber: number | null | undefined;
}

export interface FutureMatchupLineupCandidate {
  assetKey: string;
  asset: RosterAsset;
  sourceRosterArea: 'active' | 'bench';
  sourceSlotId: string;
  eligible: boolean;
  disabledReason: string | null;
}

export type FutureMatchupProjectedSlotOrigin =
  | 'materialized-window'
  | 'saved-plan'
  | 'preceding-plan'
  | 'queued-move'
  | 'current-roster'
  | 'open-slot'
  | 'conflict';

export interface FutureMatchupProjectedSlot {
  rosterSlotId: string;
  position: DraftPosition;
  slotNumber: number;
  assetKey: string | null;
  asset: RosterAsset | DraftableAsset | null;
  origin: FutureMatchupProjectedSlotOrigin;
  editable: boolean;
  locked: boolean;
  lockReason: string | null;
  resolution: FutureMatchupLineupSlotResolution | null;
  reason: string | null;
}

export interface BuildFutureMatchupProjectedLineupInput {
  cycleNumber: number;
  roster: FantasyRoster;
  plan: FutureMatchupLineupPlanView | null;
  plans?: readonly FutureMatchupLineupPlanView[];
  baseCycleNumber?: number;
  windows: readonly FantasyAssetCycleWindow[];
}

export interface FutureMatchupLineupDraftValidation {
  valid: boolean;
  issues: string[];
}

export type FutureMatchupSlotDateSource = 'saved' | 'projected' | 'pending';

export interface FutureMatchupSlotDateState {
  source: FutureMatchupSlotDateSource;
  startDate: string | null;
  endDate: string | null;
  label: string;
}

export interface ResolveFutureMatchupSlotDateStateInput {
  assetKey: string | null;
  savedWindow: FantasyAssetCycleWindow | null | undefined;
  projectedGames: readonly NhlTeamSeasonGame[];
  now?: Date;
  locale?: string;
}

function getMatchupsForCycle(
  schedulePreview: readonly CycleSchedulePreviewCycle[],
  cycleNumber: number,
) {
  return schedulePreview.find((cycle) => cycle.cycleNumber === cycleNumber)?.matchups ?? [];
}

function getPreviewMatchupForOwner(
  schedulePreview: readonly CycleSchedulePreviewCycle[],
  cycleNumber: number,
  ownerId: string,
) {
  return getMatchupsForCycle(schedulePreview, cycleNumber).find(
    (matchup) => matchup.teamAOwnerId === ownerId || matchup.teamBOwnerId === ownerId,
  ) ?? null;
}

function getOpponentOwnerId(
  ownerId: string,
  matchup: Pick<FantasyMatchup, 'teamAOwnerId' | 'teamBOwnerId'> | {
    teamAOwnerId: string;
    teamBOwnerId: string | null;
  },
): string | null {
  return matchup.teamAOwnerId === ownerId ? matchup.teamBOwnerId : matchup.teamAOwnerId;
}

/**
 * Produces every selectable regular-season matchup from the deterministic
 * round-robin preview. Persisted cycle state is used only to omit completed
 * periods and retain the exact NHL source block; no per-cycle reads are needed.
 */
export function buildFutureMatchupLineupOptions(
  input: BuildFutureMatchupLineupOptionsInput,
): FutureMatchupLineupOption[] {
  const ownerId = input.ownerId.trim();

  if (!ownerId) {
    return [];
  }

  const teamNameByOwnerId = new Map(
    input.teams.map((team) => [team.ownerId, team.teamName] as const),
  );
  const cycleByNumber = new Map(
    input.cycles.map((cycle) => [cycle.cycleNumber, cycle] as const),
  );
  const latestCompletedCycleNumber = input.cycles
    .filter((cycle) => cycle.status === 'complete')
    .reduce((latest, cycle) => Math.max(latest, cycle.cycleNumber), 0);
  const currentCycleNumber = input.currentMatchup?.status === 'active' &&
      input.currentMatchup.phase === 'regular_season'
    ? input.currentMatchup.cycleNumber
    : null;
  const firstSelectableCycleNumber = currentCycleNumber ?? latestCompletedCycleNumber + 1;
  const initialSourceBlock = typeof input.initialNhlBlockNumber === 'number' &&
      Number.isSafeInteger(input.initialNhlBlockNumber) && input.initialNhlBlockNumber > 0
    ? input.initialNhlBlockNumber
    : 1;

  return [...input.schedulePreview]
    .sort((first, second) => first.cycleNumber - second.cycleNumber)
    .flatMap((previewCycle): FutureMatchupLineupOption[] => {
      const cycle = cycleByNumber.get(previewCycle.cycleNumber) ?? null;

      if (
        previewCycle.cycleNumber < firstSelectableCycleNumber ||
        cycle?.status === 'complete' ||
        cycle?.phase === 'playoffs'
      ) {
        return [];
      }

      const previewMatchup = getPreviewMatchupForOwner(
        input.schedulePreview,
        previewCycle.cycleNumber,
        ownerId,
      );

      if (!previewMatchup) {
        return [];
      }

      const isCurrent = currentCycleNumber === previewCycle.cycleNumber;
      const exactCurrentMatchup = isCurrent ? input.currentMatchup : null;
      const matchup = exactCurrentMatchup ?? previewMatchup;
      const opponentOwnerId = getOpponentOwnerId(ownerId, matchup);
      const opponentTeamName = opponentOwnerId
        ? teamNameByOwnerId.get(opponentOwnerId) ?? 'Opponent pending'
        : null;
      const timing: FutureMatchupOptionTiming = isCurrent ? 'current' : 'future';
      const opponentLabel = opponentTeamName ? `vs ${opponentTeamName}` : 'Bye';
      const sourceNhlBlockNumber = resolveSourceNhlBlockNumber(
        cycle?.sourceNhlBlockNumber,
        initialSourceBlock + previewCycle.cycleNumber - 1,
      );

      return [{
        cycleNumber: previewCycle.cycleNumber,
        matchupId: matchup.id,
        opponentOwnerId,
        opponentTeamName,
        phase: cycle?.phase ?? 'regular_season',
        timing,
        materialized: Boolean(cycle),
        isBye: opponentOwnerId === null,
        sourceNhlBlockNumber,
        label: `Matchup ${previewCycle.cycleNumber} · ${opponentLabel} · ${
          timing === 'current' ? 'Current' : 'Future'
        }`,
      }];
    });
}

function getRosterAssetKey(asset: RosterAsset | DraftableAsset | null | undefined): string {
  if (!asset) {
    return '';
  }

  if (asset.assetKey) {
    return asset.assetKey;
  }

  return asset.assetType === 'skater'
    ? `skater-${asset.player.id}`
    : `goalie-unit-${asset.teamAbbreviation}`;
}

function toPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function getPendingMoveTargetCycle(
  pendingMove: PendingRosterSlotMove | null | undefined,
): number | null {
  const values = [
    toPositiveInteger(pendingMove?.requestedEffectiveCycleNumber),
    toPositiveInteger(pendingMove?.incomingAsset.eligibleFromCycleNumber),
  ].filter((value): value is number => value !== null);

  return values.length > 0 ? Math.max(...values) : null;
}

function isAssetEligibleForCycle(
  asset: RosterAsset | null | undefined,
  cycleNumber: number,
): boolean {
  const eligibleFrom = toPositiveInteger(asset?.eligibleFromCycleNumber);
  return Boolean(asset) && (eligibleFrom === null || eligibleFrom <= cycleNumber);
}

function getDefaultSlotAsset(
  slot: ActiveRosterSlot,
  cycleNumber: number,
): { asset: RosterAsset | null; origin: FutureMatchupProjectedSlotOrigin } {
  const pendingTarget = getPendingMoveTargetCycle(slot.pendingMove);

  if (slot.pendingMove && pendingTarget !== null && cycleNumber >= pendingTarget) {
    return { asset: slot.pendingMove.incomingAsset, origin: 'queued-move' };
  }

  return isAssetEligibleForCycle(slot.asset, cycleNumber)
    ? { asset: slot.asset, origin: 'current-roster' }
    : { asset: null, origin: 'open-slot' };
}

export function hasFutureMatchupLineupPendingMoveBlock(roster: FantasyRoster): boolean {
  return roster.activeSlots.some((slot) => Boolean(slot.pendingMove));
}

/** Current active and bench assets are the only server-supported candidates. */
export function buildFutureMatchupLineupCandidates(
  roster: FantasyRoster,
  cycleNumber: number,
): FutureMatchupLineupCandidate[] {
  const candidates: FutureMatchupLineupCandidate[] = [];
  const seenAssetKeys = new Set<string>();

  const addCandidate = (
    sourceRosterArea: 'active' | 'bench',
    sourceSlotId: string,
    asset: RosterAsset | null,
  ): void => {
    const assetKey = getRosterAssetKey(asset);

    if (!asset || !assetKey || seenAssetKeys.has(assetKey)) {
      return;
    }

    seenAssetKeys.add(assetKey);
    const eligible = isAssetEligibleForCycle(asset, cycleNumber);
    candidates.push({
      assetKey,
      asset,
      sourceRosterArea,
      sourceSlotId,
      eligible,
      disabledReason: eligible
        ? null
        : `Not eligible until Matchup ${asset.eligibleFromCycleNumber}.`,
    });
  };

  for (const slot of roster.activeSlots) {
    addCandidate('active', slot.slotId, slot.asset);
  }

  for (const slot of roster.benchSlots) {
    addCandidate('bench', slot.slotId, slot.asset);
  }

  return candidates;
}

export function isFutureMatchupCandidateCompatible(
  candidate: FutureMatchupLineupCandidate,
  position: DraftPosition,
  targetRosterSlotId: string,
): boolean {
  return candidate.eligible &&
    candidate.asset.position === position &&
    (
      candidate.sourceRosterArea === 'bench' ||
      candidate.sourceSlotId === targetRosterSlotId
    );
}

/**
 * A saved target-cycle window means the persistent slot assignment boundary
 * has already materialized. The NHL games themselves may still be scheduled,
 * but the player identity is immutable from that point forward.
 */
export function isFutureMatchupWindowLocked(
  window: FantasyAssetCycleWindow | null | undefined,
): boolean {
  return Boolean(window);
}

function getWindowLockReason(window: FantasyAssetCycleWindow): string {
  return window.status === 'complete' || window.completedAt != null
    ? 'This roster-slot window is complete and immutable.'
    : 'This roster-slot lineup boundary has materialized and is immutable, even before its NHL games begin.';
}

export function getFutureMatchupLineupPlanForCycle(
  plans: readonly FutureMatchupLineupPlanView[],
  cycleNumber: number,
): FutureMatchupLineupPlanView | null {
  return plans.find((plan) => plan.cycleNumber === cycleNumber) ?? null;
}

function getFutureMatchupPlanSlotEffectiveAssetKey(
  slot: FutureMatchupLineupPlanView['slots'][number],
): string | null {
  return slot.resolution !== 'planned' && slot.resolvedAssetKey !== undefined
    ? slot.resolvedAssetKey
    : slot.assetKey;
}

export function buildFutureMatchupProjectedLineup(
  input: BuildFutureMatchupProjectedLineupInput,
): FutureMatchupProjectedSlot[] {
  const candidates = buildFutureMatchupLineupCandidates(input.roster, input.cycleNumber);
  const candidateByAssetKey = new Map(
    candidates.map((candidate) => [candidate.assetKey, candidate] as const),
  );
  const planSlotById = input.plan?.cycleNumber === input.cycleNumber
    ? new Map(input.plan.slots.map((slot) => [slot.rosterSlotId, slot] as const))
    : new Map<string, FutureMatchupLineupPlanView['slots'][number]>();
  const windowBySlotId = new Map(
    input.windows.map((window) => [window.rosterSlotId, window] as const),
  );
  const activeSlotById = new Map(
    input.roster.activeSlots.map((slot) => [slot.slotId, slot] as const),
  );
  const precedingAssignmentBySlotId = new Map(
    input.roster.activeSlots.map((slot) => {
      const fallback = getDefaultSlotAsset(slot, input.cycleNumber);
      return [slot.slotId, fallback] as const;
    }),
  );
  const baseCycleNumber = Number.isSafeInteger(input.baseCycleNumber) &&
      (input.baseCycleNumber ?? 0) > 0
    ? input.baseCycleNumber!
    : 0;

  for (const precedingPlan of [...(input.plans ?? [])].sort(
    (first, second) => first.cycleNumber - second.cycleNumber,
  )) {
    if (
      precedingPlan.cycleNumber <= baseCycleNumber ||
      precedingPlan.cycleNumber >= input.cycleNumber
    ) {
      continue;
    }

    for (const plannedSlot of precedingPlan.slots) {
      const targetSlot = activeSlotById.get(plannedSlot.rosterSlotId) ?? null;

      // A prior conflict is evidence that the requested assignment did not
      // become authoritative. Carry the last valid preview forward instead.
      if (!targetSlot || plannedSlot.resolution === 'conflict') {
        continue;
      }

      const plannedAssetKey = getFutureMatchupPlanSlotEffectiveAssetKey(plannedSlot);

      if (plannedAssetKey === null) {
        if (!targetSlot.asset) {
          precedingAssignmentBySlotId.set(targetSlot.slotId, {
            asset: null,
            origin: 'preceding-plan',
          });
        }
        continue;
      }

      const candidate = candidateByAssetKey.get(plannedAssetKey) ?? null;
      if (
        !candidate ||
        !isFutureMatchupCandidateCompatible(candidate, targetSlot.position, targetSlot.slotId)
      ) {
        continue;
      }

      precedingAssignmentBySlotId.set(targetSlot.slotId, {
        asset: candidate.asset,
        origin: 'preceding-plan',
      });
    }
  }

  return [...input.roster.activeSlots]
    .sort((first, second) => first.slotNumber - second.slotNumber)
    .map((slot): FutureMatchupProjectedSlot => {
      const window = windowBySlotId.get(slot.slotId) ?? null;
      const planSlot = planSlotById.get(slot.slotId) ?? null;

      if (window) {
        return {
          rosterSlotId: slot.slotId,
          position: slot.position,
          slotNumber: slot.slotNumber,
          assetKey: getRosterAssetKey(window.asset) || window.assetKey || null,
          asset: window.asset,
          origin: planSlot?.resolution === 'conflict' ? 'conflict' : 'materialized-window',
          editable: false,
          locked: true,
          lockReason: planSlot?.reason ?? getWindowLockReason(window),
          resolution: planSlot?.resolution ?? null,
          reason: planSlot?.reason ?? null,
        };
      }

      if (planSlot && planSlot.resolution !== 'planned') {
        const resolvedAssetKey = getFutureMatchupPlanSlotEffectiveAssetKey(planSlot);
        const candidate = resolvedAssetKey
          ? candidateByAssetKey.get(resolvedAssetKey) ?? null
          : null;

        return {
          rosterSlotId: slot.slotId,
          position: slot.position,
          slotNumber: slot.slotNumber,
          assetKey: resolvedAssetKey,
          asset: candidate?.asset ?? null,
          origin: planSlot.resolution === 'conflict' ? 'conflict' : 'materialized-window',
          editable: false,
          locked: true,
          lockReason: planSlot.reason ?? (
            planSlot.resolution === 'conflict'
              ? 'This assignment conflicted during materialization and is immutable.'
              : 'This assignment has materialized and is immutable.'
          ),
          resolution: planSlot.resolution,
          reason: planSlot.reason ?? null,
        };
      }

      if (planSlot) {
        if (planSlot.assetKey === null) {
          if (slot.asset) {
            return {
              rosterSlotId: slot.slotId,
              position: slot.position,
              slotNumber: slot.slotNumber,
              assetKey: null,
              asset: null,
              origin: 'conflict',
              editable: true,
              locked: false,
              lockReason: null,
              resolution: planSlot.resolution,
              reason: 'An occupied active slot cannot be saved as empty.',
            };
          }

          return {
            rosterSlotId: slot.slotId,
            position: slot.position,
            slotNumber: slot.slotNumber,
            assetKey: null,
            asset: null,
            origin: 'saved-plan',
            editable: true,
            locked: false,
            lockReason: null,
            resolution: planSlot.resolution,
            reason: null,
          };
        }

        const candidate = candidateByAssetKey.get(planSlot.assetKey) ?? null;

        if (
          !candidate ||
          !isFutureMatchupCandidateCompatible(candidate, slot.position, slot.slotId)
        ) {
          return {
            rosterSlotId: slot.slotId,
            position: slot.position,
            slotNumber: slot.slotNumber,
            assetKey: planSlot.assetKey,
            asset: candidate?.asset ?? null,
            origin: 'conflict',
            editable: true,
            locked: false,
            lockReason: null,
            resolution: planSlot.resolution,
            reason: candidate?.disabledReason ?? 'This saved assignment is no longer available.',
          };
        }

        return {
          rosterSlotId: slot.slotId,
          position: slot.position,
          slotNumber: slot.slotNumber,
          assetKey: candidate.assetKey,
          asset: candidate.asset,
          origin: 'saved-plan',
          editable: true,
          locked: false,
          lockReason: null,
          resolution: planSlot.resolution,
          reason: null,
        };
      }

      const fallback = precedingAssignmentBySlotId.get(slot.slotId) ??
        getDefaultSlotAsset(slot, input.cycleNumber);

      return {
        rosterSlotId: slot.slotId,
        position: slot.position,
        slotNumber: slot.slotNumber,
        assetKey: getRosterAssetKey(fallback.asset) || null,
        asset: fallback.asset,
        origin: fallback.origin,
        editable: true,
        locked: false,
        lockReason: null,
        resolution: null,
        reason: null,
      };
    });
}

export function buildFutureMatchupLineupSlotInputs(
  slots: readonly Pick<FutureMatchupProjectedSlot, 'rosterSlotId' | 'assetKey'>[],
): FutureMatchupLineupSlotInput[] {
  return slots.map((slot) => ({
    rosterSlotId: slot.rosterSlotId,
    assetKey: slot.assetKey,
  }));
}

export function areFutureMatchupLineupSlotsEqual(
  first: readonly FutureMatchupLineupSlotInput[],
  second: readonly FutureMatchupLineupSlotInput[],
): boolean {
  const serialize = (slots: readonly FutureMatchupLineupSlotInput[]) => JSON.stringify(
    [...slots]
      .map((slot) => ({ rosterSlotId: slot.rosterSlotId, assetKey: slot.assetKey }))
      .sort((left, right) => left.rosterSlotId.localeCompare(right.rosterSlotId)),
  );

  return serialize(first) === serialize(second);
}

export function validateFutureMatchupLineupDraft(input: {
  roster: FantasyRoster;
  cycleNumber: number;
  slots: readonly FutureMatchupLineupSlotInput[];
  plan?: FutureMatchupLineupPlanView | null;
  windows?: readonly FantasyAssetCycleWindow[];
}): FutureMatchupLineupDraftValidation {
  const issues: string[] = [];
  const expectedSlots = new Map(
    input.roster.activeSlots.map((slot) => [slot.slotId, slot] as const),
  );
  const candidates = buildFutureMatchupLineupCandidates(input.roster, input.cycleNumber);
  const candidateByAssetKey = new Map(
    candidates.map((candidate) => [candidate.assetKey, candidate] as const),
  );
  const seenSlotIds = new Set<string>();
  const seenAssetKeys = new Set<string>();
  const lockedPlanSlotById = input.plan?.cycleNumber === input.cycleNumber
    ? new Map(
        input.plan.slots
          .filter((slot) => slot.resolution !== 'planned')
          .map((slot) => [slot.rosterSlotId, slot] as const),
      )
    : new Map<string, FutureMatchupLineupPlanView['slots'][number]>();
  const materializedWindowBySlotId = new Map(
    (input.windows ?? []).map((window) => [window.rosterSlotId, window] as const),
  );

  if (hasFutureMatchupLineupPendingMoveBlock(input.roster)) {
    issues.push('Resolve the queued roster move before saving a future lineup.');
  }

  for (const assignment of input.slots) {
    const slot = expectedSlots.get(assignment.rosterSlotId);

    if (!slot || seenSlotIds.has(assignment.rosterSlotId)) {
      issues.push(`Roster slot ${assignment.rosterSlotId} is missing or duplicated.`);
      continue;
    }

    seenSlotIds.add(assignment.rosterSlotId);
    const materializedWindow = materializedWindowBySlotId.get(
      assignment.rosterSlotId,
    ) ?? null;
    const lockedPlanSlot = lockedPlanSlotById.get(assignment.rosterSlotId) ?? null;

    if (materializedWindow) {
      const materializedAssetKey = getRosterAssetKey(materializedWindow.asset) ||
        materializedWindow.assetKey || null;
      if (assignment.assetKey !== materializedAssetKey) {
        issues.push(`Materialized roster slot ${slot.slotId} cannot be changed.`);
      } else if (assignment.assetKey !== null) {
        if (seenAssetKeys.has(assignment.assetKey)) {
          issues.push(`Asset ${assignment.assetKey} is assigned more than once.`);
        }
        seenAssetKeys.add(assignment.assetKey);
      }
      continue;
    }

    if (lockedPlanSlot) {
      const lockedAssetKey = getFutureMatchupPlanSlotEffectiveAssetKey(lockedPlanSlot);
      if (assignment.assetKey !== lockedAssetKey) {
        issues.push(`Materialized roster slot ${slot.slotId} cannot be changed.`);
      } else if (lockedAssetKey !== null) {
        if (seenAssetKeys.has(lockedAssetKey)) {
          issues.push(`Asset ${lockedAssetKey} is assigned more than once.`);
        }
        seenAssetKeys.add(lockedAssetKey);
      }
      continue;
    }

    if (assignment.assetKey === null) {
      if (slot.asset) {
        issues.push(`Occupied roster slot ${slot.slotId} cannot be saved as empty.`);
      }
      continue;
    }

    if (seenAssetKeys.has(assignment.assetKey)) {
      issues.push(`Asset ${assignment.assetKey} is assigned more than once.`);
      continue;
    }

    seenAssetKeys.add(assignment.assetKey);
    const candidate = candidateByAssetKey.get(assignment.assetKey);

    if (!candidate) {
      issues.push(`Asset ${assignment.assetKey} is no longer on the active roster or bench.`);
    } else if (!isFutureMatchupCandidateCompatible(candidate, slot.position, slot.slotId)) {
      issues.push(
        candidate.disabledReason ?? (
          candidate.sourceRosterArea === 'active'
            ? `Active asset ${assignment.assetKey} must remain in ${candidate.sourceSlotId}.`
            : `Asset ${assignment.assetKey} cannot fill ${slot.position}.`
        ),
      );
    }
  }

  for (const slotId of expectedSlots.keys()) {
    if (!seenSlotIds.has(slotId)) {
      issues.push(`Roster slot ${slotId} is missing from the plan.`);
    }
  }

  return { valid: issues.length === 0, issues };
}

export function resolveFutureMatchupSourceEvidence(input: {
  cycleNumber: number;
  cycle: FantasyCycle | null | undefined;
  draft: Pick<
    FantasyDraft,
    'initialNhlBlockNumber' | 'seasonWindowSourceGameIdsByTeam' | 'seasonWindowAnchorTeams'
  >;
  requiredGamesPerCycle: number;
}): {
  sourceNhlBlockNumber: number;
  targetGameIdsByTeam: Readonly<Record<string, number[]>>;
} {
  const sourceNhlBlockNumber = resolveSourceNhlBlockNumber(
    input.cycle?.sourceNhlBlockNumber,
    (input.draft.initialNhlBlockNumber ?? 1) + input.cycleNumber - 1,
  );
  const savedTargets = input.cycle?.sourceNhlTargetGameIdsByTeam;

  if (savedTargets && Object.keys(savedTargets).length > 0) {
    return { sourceNhlBlockNumber, targetGameIdsByTeam: savedTargets };
  }

  const frozenSeasonPlan = resolveFrozenSeasonSourceGameIdsByTeam(input.draft);
  const targetGameIdsByTeam = buildSourceNhlTargetGameIdsByTeam(
    frozenSeasonPlan,
    sourceNhlBlockNumber,
    input.requiredGamesPerCycle,
  );

  return { sourceNhlBlockNumber, targetGameIdsByTeam };
}

export function selectFutureMatchupProjectedGames(input: {
  schedule: readonly NhlTeamSeasonGame[];
  targetGameIds?: readonly number[];
  sourceNhlBlockNumber: number;
  requiredGamesPerCycle: number;
}): NhlTeamSeasonGame[] {
  const schedule = [...input.schedule].sort(
    (first, second) => first.gameDate.localeCompare(second.gameDate) || first.id - second.id,
  );
  const selected = input.targetGameIds && input.targetGameIds.length > 0
    ? selectGamesByStableIds(schedule, input.targetGameIds)
    : schedule.slice(
        getCycleGameStartIndex(input.sourceNhlBlockNumber, input.requiredGamesPerCycle),
        getCycleGameEndIndex(input.sourceNhlBlockNumber, input.requiredGamesPerCycle),
      );

  if (selected.length !== input.requiredGamesPerCycle) {
    throw new Error(
      `The projected NHL schedule is incomplete for source block ${input.sourceNhlBlockNumber}.`,
    );
  }

  return selected;
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));

  return date.getUTCFullYear() === Number(match[1]) &&
      date.getUTCMonth() === Number(match[2]) - 1 &&
      date.getUTCDate() === Number(match[3])
    ? value
    : null;
}

function formatIsoDate(value: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00.000Z`));
}

function hasNhlGameStartEvidence(window: FantasyAssetCycleWindow): boolean {
  return (
    window.status === 'complete' ||
    window.gamesPlayed > 0 ||
    window.actualGamesPlayed > 0 ||
    window.fantasyPoints !== 0 ||
    window.completedGameIds.length > 0 ||
    window.liveGameIds.length > 0 ||
    window.appearanceGameIds.length > 0 ||
    Object.keys(window.gameScores).length > 0 ||
    Object.values(window.gameStates).some((state) => state !== 'scheduled') ||
    window.completedAt != null
  );
}

function getUtcDateForComparison(value: Date): string | null {
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
}

/**
 * Saved, identity-matching window dates always win. A locked window with
 * incomplete date evidence stays visibly pending instead of borrowing a later
 * mutable NHL schedule. Untouched previews may use projected schedule dates.
 */
export function resolveFutureMatchupSlotDateState(
  input: ResolveFutureMatchupSlotDateStateInput,
): FutureMatchupSlotDateState {
  const savedWindow = input.savedWindow ?? null;
  const savedIdentityMatches = Boolean(
    savedWindow && input.assetKey && savedWindow.assetKey === input.assetKey,
  );
  const savedDates = savedIdentityMatches
    ? savedWindow!.scheduledGameDates.map(normalizeIsoDate).filter(
        (value): value is string => value !== null,
      )
    : [];
  const savedStart = savedIdentityMatches
    ? normalizeIsoDate(savedWindow!.firstScheduledGameDate) ?? savedDates[0] ?? null
    : null;
  const savedEnd = savedIdentityMatches
    ? normalizeIsoDate(savedWindow!.lastScheduledGameDate) ?? savedDates.at(-1) ?? null
    : null;

  if (savedStart) {
    const comparisonDate = getUtcDateForComparison(input.now ?? new Date());
    const started = hasNhlGameStartEvidence(savedWindow!) ||
      (comparisonDate !== null && savedStart < comparisonDate);
    return {
      source: 'saved',
      startDate: savedStart,
      endDate: savedEnd,
      label: `${started ? 'Started' : 'Starts'} ${formatIsoDate(savedStart, input.locale)}`,
    };
  }

  if (savedWindow && isFutureMatchupWindowLocked(savedWindow)) {
    return {
      source: 'pending',
      startDate: null,
      endDate: null,
      label: 'Pending',
    };
  }

  const projectedDates = input.projectedGames
    .map((game) => normalizeIsoDate(game.gameDate))
    .filter((value): value is string => value !== null)
    .sort();
  const projectedStart = projectedDates[0] ?? null;

  if (projectedStart) {
    return {
      source: 'projected',
      startDate: projectedStart,
      endDate: projectedDates.at(-1) ?? projectedStart,
      label: `Begins ${formatIsoDate(projectedStart, input.locale)}`,
    };
  }

  return {
    source: 'pending',
    startDate: null,
    endDate: null,
    label: 'Pending',
  };
}
