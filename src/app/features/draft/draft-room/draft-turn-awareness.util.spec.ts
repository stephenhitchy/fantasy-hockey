import { describe, expect, it } from 'vitest';

import type { FantasyDraft } from '../../../core/draft/draft.models';
import {
  getCompactDraftTurnDistanceLabel,
  getDraftTurnDistanceLabel,
  getPicksUntilManagerTurn,
  normalizeDraftTurnSoundVolume,
  shouldAutoOpenAvailablePlayersForTurn,
  shouldPlayDraftTurnAlert,
} from './draft-turn-awareness.util';

function createDraft(
  status: FantasyDraft['status'],
  nextOverallPick: number,
): FantasyDraft {
  return {
    status,
    nextOverallPick,
    totalRounds: 3,
    roundOneOrder: ['manager-a', 'manager-b', 'manager-c', 'manager-d'],
  } as FantasyDraft;
}

describe('Draft turn awareness', () => {
  it('counts every selection before the manager in snake order', () => {
    expect(getPicksUntilManagerTurn(createDraft('live', 1), 'manager-a')).toBe(0);
    expect(getPicksUntilManagerTurn(createDraft('live', 1), 'manager-d')).toBe(3);
    expect(getPicksUntilManagerTurn(createDraft('live', 5), 'manager-a')).toBe(3);
    expect(getPicksUntilManagerTurn(createDraft('live', 8), 'manager-a')).toBe(0);
  });

  it('keeps a manager on the clock across a snake-turn double pick', () => {
    expect(getPicksUntilManagerTurn(createDraft('live', 4), 'manager-d')).toBe(0);
    expect(getPicksUntilManagerTurn(createDraft('live', 5), 'manager-d')).toBe(0);
  });

  it('fails closed outside an eligible Draft or for an unknown manager', () => {
    expect(getPicksUntilManagerTurn(createDraft('complete', 12), 'manager-a')).toBeNull();
    expect(getPicksUntilManagerTurn(createDraft('live', 1), 'manager-z')).toBeNull();
    expect(getPicksUntilManagerTurn(null, 'manager-a')).toBeNull();
  });

  it('uses phase-aware full and compact labels', () => {
    expect(getDraftTurnDistanceLabel(0, 'scheduled')).toBe('You have the first pick');
    expect(getDraftTurnDistanceLabel(2, 'scheduled')).toBe('2 picks before your first turn');
    expect(getDraftTurnDistanceLabel(0, 'live')).toBe('You are on the clock');
    expect(getDraftTurnDistanceLabel(1, 'live')).toBe('1 pick until your turn');
    expect(getCompactDraftTurnDistanceLabel(4)).toBe('· 4 picks away');
  });

  it('alerts only on a new transition onto the manager clock', () => {
    expect(shouldPlayDraftTurnAlert({
      hasPreviousObservation: false,
      previousDistance: null,
      previousStatus: null,
      currentDistance: 0,
      currentStatus: 'live',
    })).toBe(false);

    expect(shouldPlayDraftTurnAlert({
      hasPreviousObservation: true,
      previousDistance: 1,
      previousStatus: 'live',
      currentDistance: 0,
      currentStatus: 'live',
    })).toBe(true);

    expect(shouldPlayDraftTurnAlert({
      hasPreviousObservation: true,
      previousDistance: 0,
      previousStatus: 'live',
      currentDistance: 0,
      currentStatus: 'live',
    })).toBe(false);
  });

  it('returns to available players only for a new idle manager turn', () => {
    expect(shouldAutoOpenAvailablePlayersForTurn({
      enteredManagerTurn: true,
      pickSubmissionPhase: 'idle',
    })).toBe(true);
    expect(shouldAutoOpenAvailablePlayersForTurn({
      enteredManagerTurn: false,
      pickSubmissionPhase: 'idle',
    })).toBe(false);
    expect(shouldAutoOpenAvailablePlayersForTurn({
      enteredManagerTurn: true,
      pickSubmissionPhase: 'confirming',
    })).toBe(false);
  });

  it('keeps user-controlled volume inside the browser-safe range', () => {
    expect(normalizeDraftTurnSoundVolume(-20)).toBe(0);
    expect(normalizeDraftTurnSoundVolume('47.6')).toBe(48);
    expect(normalizeDraftTurnSoundVolume(140)).toBe(100);
    expect(normalizeDraftTurnSoundVolume('not-a-number')).toBe(60);
    expect(normalizeDraftTurnSoundVolume(null)).toBe(60);
  });
});
