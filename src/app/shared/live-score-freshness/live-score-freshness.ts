import {
  Component,
  OnDestroy,
  computed,
  input,
  signal,
} from '@angular/core';

import {
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
} from '../../core/live-scoring/live-scoring.models';
import {
  buildLiveScoringFreshnessViewModel,
  liveScoringTimestampMilliseconds,
} from '../../core/live-scoring/live-scoring-freshness.util';

@Component({
  selector: 'app-live-score-freshness',
  imports: [],
  templateUrl: './live-score-freshness.html',
  styleUrl: './live-score-freshness.css',
})
export class LiveScoreFreshness implements OnDestroy {
  readonly control = input<SharedLiveScoringControl | null>(null);
  readonly snapshot = input<SharedCycleScoringSnapshot | null>(null);
  readonly cycleStatus = input<string | null>(null);
  readonly embedded = input(false);

  readonly now = signal(Date.now());
  readonly model = computed(() =>
    buildLiveScoringFreshnessViewModel({
      control: this.control(),
      snapshot: this.snapshot(),
      cycleStatus: this.cycleStatus(),
      nowMilliseconds: this.now(),
    }),
  );

  private timer: number | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.timer = window.setInterval(() => this.now.set(Date.now()), 30_000);
    }
  }

  ngOnDestroy(): void {
    if (this.timer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  exactTimestamp(value: number | null): string {
    const milliseconds = liveScoringTimestampMilliseconds(value);

    if (milliseconds === null) {
      return 'Not recorded yet';
    }

    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(milliseconds);
  }
}
