import type { DraftPosition } from '../../core/draft/draft.models';

export type FreeAgentPoolTab = 'available' | 'waivers';
export type PersistedFreeAgentFlowStep = 'player-pool' | 'roster-slot';

export interface FreeAgentMobileViewState {
  version: 1;
  savedAt: number;
  searchTerm: string;
  positionFilter: 'ALL' | DraftPosition;
  sortMode:
    | 'NEXT_CYCLE'
    | 'SEASON_POINTS'
    | 'REST_OF_SEASON'
    | 'FINAL_OUTLOOK'
    | 'PERFORMANCE'
    | 'RELIABILITY';
  poolTab: FreeAgentPoolTab;
  flowStep: PersistedFreeAgentFlowStep;
  selectedAddAssetKey: string;
  selectedWaiverId: string;
  selectedDropSlotId: string;
  preferredSlotId: string;
  preferredRosterArea: 'active' | 'bench' | '';
  playerPoolScrollY: number;
}

const VALID_POSITIONS = new Set(['ALL', 'LW', 'C', 'RW', 'D', 'G']);
const VALID_SORT_MODES = new Set([
  'NEXT_CYCLE',
  'SEASON_POINTS',
  'REST_OF_SEASON',
  'FINAL_OUTLOOK',
  'PERFORMANCE',
  'RELIABILITY',
]);
const VALID_POOL_TABS = new Set(['available', 'waivers']);
const VALID_FLOW_STEPS = new Set(['player-pool', 'roster-slot']);
const MAX_STATE_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function parseFreeAgentMobileViewState(
  rawValue: string | null,
  now = Date.now(),
): FreeAgentMobileViewState | null {
  if (!rawValue) {
    return null;
  }

  try {
    const value = JSON.parse(rawValue) as Partial<FreeAgentMobileViewState>;

    if (
      value.version !== 1 ||
      typeof value.savedAt !== 'number' ||
      !Number.isFinite(value.savedAt) ||
      value.savedAt > now + MAX_FUTURE_CLOCK_SKEW_MS ||
      now - value.savedAt > MAX_STATE_AGE_MS ||
      typeof value.searchTerm !== 'string' ||
      typeof value.positionFilter !== 'string' ||
      !VALID_POSITIONS.has(value.positionFilter) ||
      typeof value.sortMode !== 'string' ||
      !VALID_SORT_MODES.has(value.sortMode) ||
      typeof value.poolTab !== 'string' ||
      !VALID_POOL_TABS.has(value.poolTab) ||
      typeof value.flowStep !== 'string' ||
      !VALID_FLOW_STEPS.has(value.flowStep) ||
      typeof value.selectedAddAssetKey !== 'string' ||
      typeof value.selectedWaiverId !== 'string' ||
      typeof value.selectedDropSlotId !== 'string' ||
      typeof value.preferredSlotId !== 'string' ||
      (value.preferredRosterArea !== '' &&
        value.preferredRosterArea !== 'active' &&
        value.preferredRosterArea !== 'bench') ||
      typeof value.playerPoolScrollY !== 'number' ||
      !Number.isFinite(value.playerPoolScrollY) ||
      value.playerPoolScrollY < 0
    ) {
      return null;
    }

    return value as FreeAgentMobileViewState;
  } catch {
    return null;
  }
}

export interface PreferredSlotCandidate {
  slotId: string;
  rosterArea: 'active' | 'bench';
}

export function resolvePreferredRosterCandidate<T extends PreferredSlotCandidate>(
  candidates: readonly T[],
  preferredSlotId: string,
  preferredRosterArea: 'active' | 'bench' | '',
): T | null {
  if (!preferredSlotId) {
    return null;
  }

  return (
    candidates.find(
      (candidate) =>
        candidate.slotId === preferredSlotId &&
        (!preferredRosterArea || candidate.rosterArea === preferredRosterArea),
    ) ?? null
  );
}

export interface FreeAgentRoutePreferences {
  position: 'ALL' | DraftPosition | null;
  targetSlot: string;
  rosterArea: 'active' | 'bench' | '';
  poolTab: FreeAgentPoolTab | null;
  focusPendingMoves: boolean;
}

export function resolveFreeAgentRoutePreferences(params: {
  position?: string | null;
  targetSlot?: string | null;
  rosterArea?: string | null;
  tab?: string | null;
  focus?: string | null;
}): FreeAgentRoutePreferences {
  const position = params.position && VALID_POSITIONS.has(params.position)
    ? (params.position as 'ALL' | DraftPosition)
    : null;
  const rosterArea = params.rosterArea === 'active' || params.rosterArea === 'bench'
    ? params.rosterArea
    : '';
  const poolTab = params.tab && VALID_POOL_TABS.has(params.tab)
    ? (params.tab as FreeAgentPoolTab)
    : null;

  return {
    position,
    targetSlot: rosterArea ? params.targetSlot?.trim() ?? '' : '',
    rosterArea,
    poolTab,
    focusPendingMoves: params.focus === 'pending-moves',
  };
}
