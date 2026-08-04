import type { DraftPosition } from '../../../core/draft/draft.models';

export type RosterManagementArea = 'active' | 'bench' | 'ir';

export type RosterManagementActionId =
  | 'view'
  | 'find-player'
  | 'review-scheduled'
  | 'start'
  | 'move-to-ir'
  | 'activate'
  | 'move-to-bench'
  | 'drop';

export type RosterManagementActionTone = 'primary' | 'secondary' | 'warning' | 'danger';

export interface RosterManagementAction {
  id: RosterManagementActionId;
  label: string;
  detail: string;
  tone: RosterManagementActionTone;
  enabled: boolean;
  disabledReason: string | null;
}

export interface RosterManagementContext {
  area: RosterManagementArea;
  hasAsset: boolean;
  assetIsSkater: boolean;
  hasPendingMove: boolean;
  busy: boolean;
  showMoveToIr: boolean;
  canMoveToIr: boolean;
  moveToIrDisabledReason?: string | null;
  canStartFromBench: boolean;
  startDisabledReason?: string | null;
  canActivateFromIr: boolean;
  activateDisabledReason?: string | null;
  canMoveIrToBench: boolean;
  moveIrToBenchDisabledReason?: string | null;
}

function action(
  id: RosterManagementActionId,
  label: string,
  detail: string,
  tone: RosterManagementActionTone,
  enabled: boolean,
  disabledReason: string | null = null,
): RosterManagementAction {
  return {
    id,
    label,
    detail,
    tone,
    enabled,
    disabledReason: enabled ? null : disabledReason,
  };
}

export function buildRosterManagementActions(
  context: RosterManagementContext,
): RosterManagementAction[] {
  const locked = context.busy;

  if (!context.hasAsset) {
    if (context.area === 'ir') {
      return [];
    }

    return [
      action(
        'find-player',
        'Find a Player',
        context.area === 'bench'
          ? 'Open Available Players and preselect this open bench spot.'
          : 'Open Available Players already filtered to this position and roster slot.',
        'primary',
        !locked,
        'Wait for the current roster action to finish.',
      ),
    ];
  }

  const actions: RosterManagementAction[] = [
    action(
      'view',
      'View Scoring Detail',
      'Open the player page with current matchup scoring and projection information.',
      'secondary',
      !locked,
      'Wait for the current roster action to finish.',
    ),
  ];

  if (context.area === 'active') {
    if (context.hasPendingMove) {
      actions.push(
        action(
          'review-scheduled',
          'Review Scheduled Move',
          'This roster spot already has an incoming player reserved. Open Add / Drop to review or cancel it.',
          'warning',
          !locked,
          'Wait for the current roster action to finish.',
        ),
      );

      return actions;
    }

    actions.push(
      action(
        'find-player',
        'Find a Replacement',
        'Open Available Players already filtered to this position. This exact roster slot will be preselected.',
        'primary',
        !locked,
        'Wait for the current roster action to finish.',
      ),
    );

    if (context.assetIsSkater && context.showMoveToIr) {
      actions.push(
        action(
          'move-to-ir',
          'Move to Injured Reserve',
          'The player leaves the active roster. A six-game count that has already started remains protected until its fair boundary.',
          'warning',
          !locked && context.canMoveToIr,
          locked
            ? 'Wait for the current roster action to finish.'
            : context.moveToIrDisabledReason || 'This player is not currently eligible for Injured Reserve.',
        ),
      );
    }

    actions.push(
      action(
        'drop',
        'Drop to Waivers',
        'Release this player or goalie unit. If the six-game count has started, that scoring window stays intact until the next fair boundary.',
        'danger',
        !locked,
        'Wait for the current roster action to finish.',
      ),
    );

    return actions;
  }

  if (context.area === 'bench') {
    if (context.hasPendingMove) {
      actions.push(
        action(
          'review-scheduled',
          'Review Scheduled Move',
          'This bench player is reserved for a scheduled active-lineup swap. Review or cancel that move before changing this bench spot.',
          'warning',
          !locked,
          'Wait for the current roster action to finish.',
        ),
      );

      return actions;
    }

    actions.push(
      action(
        'start',
        'Move into Starting Lineup',
        'Choose a matching active slot. The swap happens now only when both six-game counts are untouched; otherwise it is scheduled safely.',
        'primary',
        !locked && context.canStartFromBench,
        locked
          ? 'Wait for the current roster action to finish.'
          : context.startDisabledReason || 'No matching active roster slot can change right now.',
      ),
      action(
        'find-player',
        'Replace Bench Player',
        'Open Available Players and preselect this bench spot. Replacing the player sends the outgoing player to waivers.',
        'secondary',
        !locked,
        'Wait for the current roster action to finish.',
      ),
    );

    if (context.assetIsSkater && context.showMoveToIr) {
      actions.push(
        action(
          'move-to-ir',
          'Move to Injured Reserve',
          'Ownership moves from the bench into an Injured Reserve slot. Bench players do not have an active scoring window to rewrite.',
          'warning',
          !locked && context.canMoveToIr,
          locked
            ? 'Wait for the current roster action to finish.'
            : context.moveToIrDisabledReason || 'This player is not currently eligible for Injured Reserve.',
        ),
      );
    }

    actions.push(
      action(
        'drop',
        'Drop to Waivers',
        'Release this bench player or goalie unit immediately and open the bench spot.',
        'danger',
        !locked,
        'Wait for the current roster action to finish.',
      ),
    );

    return actions;
  }

  actions.push(
    action(
      'activate',
      'Activate to Starting Lineup',
      'Choose a matching active slot. The move applies immediately only when that slot can change without rewriting counted games.',
      'primary',
      !locked && context.canActivateFromIr,
      locked
        ? 'Wait for the current roster action to finish.'
        : context.activateDisabledReason || 'This player cannot be activated yet.',
    ),
    action(
      'move-to-bench',
      'Move to Bench',
      'Choose a bench spot. Replacing an occupied bench spot sends that player or goalie unit to waivers.',
      'secondary',
      !locked && context.canMoveIrToBench,
      locked
        ? 'Wait for the current roster action to finish.'
        : context.moveIrToBenchDisabledReason || 'No bench slot can accept this player right now.',
    ),
    action(
      'drop',
      'Drop to Waivers',
      'Release this player from Injured Reserve and open the IR spot.',
      'danger',
      !locked,
      'Wait for the current roster action to finish.',
    ),
  );

  return actions;
}

export interface FreeAgentRosterTargetQuery {
  position: DraftPosition | 'ALL';
  targetSlot: string;
  rosterArea: 'active' | 'bench';
}

export function buildFreeAgentRosterTargetQuery(
  area: RosterManagementArea,
  position: DraftPosition | null,
  slotId: string,
): FreeAgentRosterTargetQuery | null {
  if (area === 'ir' || !slotId || (area === 'active' && !position)) {
    return null;
  }

  return {
    position: area === 'bench' ? 'ALL' : position!,
    targetSlot: slotId,
    rosterArea: area,
  };
}
