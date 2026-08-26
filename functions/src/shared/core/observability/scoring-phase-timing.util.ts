export const SCORING_PHASE_NAMES = [
  'lease-and-prerequisites',
  'league-and-team-load',
  'cycle-bootstrap',
  'historical-replay-data',
  'cycle-discovery',
  'roster-move-reconciliation',
  'roster-pick-load',
  'previous-snapshot-load',
  'nhl-schedule-load',
  'nhl-game-data-load',
  'nhl-player-log-load',
  'score-calculation',
  'snapshot-publication',
  'window-and-competition-persistence',
  'post-transition-cycle-refresh',
  'control-publication',
  'queue-and-observability',
] as const;

export type ScoringPhaseName = (typeof SCORING_PHASE_NAMES)[number];

export interface ScoringPhaseTimingSnapshot {
  schemaVersion: 1;
  phases: Record<ScoringPhaseName, number>;
  measuredDurationMilliseconds: number;
  totalDurationMilliseconds: number;
  unmeasuredDurationMilliseconds: number;
  longestPhase: ScoringPhaseName | '';
  longestPhaseDurationMilliseconds: number;
}

const MAX_RECORDED_DURATION_MILLISECONDS = 10 * 60 * 1000;

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.min(MAX_RECORDED_DURATION_MILLISECONDS, Math.round(value));
}

function emptyPhases(): Record<ScoringPhaseName, number> {
  return Object.fromEntries(
    SCORING_PHASE_NAMES.map((phase) => [phase, 0]),
  ) as Record<ScoringPhaseName, number>;
}

export class ScoringPhaseTimer {
  private readonly durations = emptyPhases();

  add(phase: ScoringPhaseName, durationMilliseconds: number): void {
    this.durations[phase] = boundedDuration(
      this.durations[phase] + durationMilliseconds,
    );
  }

  async measure<T>(
    phase: ScoringPhaseName,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();

    try {
      return await operation();
    } finally {
      this.add(phase, Date.now() - startedAt);
    }
  }

  snapshot(totalDurationMilliseconds: number): ScoringPhaseTimingSnapshot {
    const phases = { ...this.durations };
    const measuredDurationMilliseconds = Object.values(phases)
      .reduce((sum, duration) => sum + duration, 0);
    const totalDuration = boundedDuration(totalDurationMilliseconds);
    let longestPhase: ScoringPhaseName | '' = '';
    let longestPhaseDurationMilliseconds = 0;

    for (const phase of SCORING_PHASE_NAMES) {
      const duration = phases[phase];

      if (duration > longestPhaseDurationMilliseconds) {
        longestPhase = phase;
        longestPhaseDurationMilliseconds = duration;
      }
    }

    return {
      schemaVersion: 1,
      phases,
      measuredDurationMilliseconds,
      totalDurationMilliseconds: totalDuration,
      unmeasuredDurationMilliseconds: Math.max(
        0,
        totalDuration - measuredDurationMilliseconds,
      ),
      longestPhase,
      longestPhaseDurationMilliseconds,
    };
  }
}

export function scoringPhaseTimingForFirestore(
  snapshot: ScoringPhaseTimingSnapshot | undefined,
): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }

  return {
    schemaVersion: 1,
    phases: Object.fromEntries(
      SCORING_PHASE_NAMES.map((phase) => [
        phase,
        boundedDuration(snapshot.phases[phase]),
      ]),
    ),
    measuredDurationMilliseconds: boundedDuration(
      snapshot.measuredDurationMilliseconds,
    ),
    totalDurationMilliseconds: boundedDuration(
      snapshot.totalDurationMilliseconds,
    ),
    unmeasuredDurationMilliseconds: boundedDuration(
      snapshot.unmeasuredDurationMilliseconds,
    ),
    longestPhase: snapshot.longestPhase,
    longestPhaseDurationMilliseconds: boundedDuration(
      snapshot.longestPhaseDurationMilliseconds,
    ),
  };
}
