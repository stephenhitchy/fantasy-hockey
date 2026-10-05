export interface NhlUpstreamThrottleGateOptions {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  requestSpacingMilliseconds?: number;
}

const DEFAULT_REQUEST_SPACING_MILLISECONDS = 750;

function waitForThrottle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Coordinates only the retry period after this process observes an NHL 429.
 * Healthy traffic keeps its existing concurrency; throttled traffic queues so
 * simultaneous callers do not wake up and repeat the same rejected burst.
 */
export class NhlUpstreamThrottleGate {
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly requestSpacingMilliseconds: number;
  private notBeforeMilliseconds = 0;
  private lastPermitAtMilliseconds = 0;
  private queuedPermitCount = 0;
  private permitTail: Promise<void> = Promise.resolve();

  constructor(options: NhlUpstreamThrottleGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitForThrottle;
    this.requestSpacingMilliseconds = Math.max(
      1,
      Math.floor(
        options.requestSpacingMilliseconds ??
        DEFAULT_REQUEST_SPACING_MILLISECONDS,
      ),
    );
  }

  observeRateLimit(retryDelayMilliseconds: number): void {
    const safeDelayMilliseconds = Number.isFinite(retryDelayMilliseconds)
      ? Math.max(0, Math.floor(retryDelayMilliseconds))
      : 0;

    this.notBeforeMilliseconds = Math.max(
      this.notBeforeMilliseconds,
      this.now() + safeDelayMilliseconds,
    );
  }

  async waitForPermit(): Promise<void> {
    if (
      this.queuedPermitCount === 0 &&
      this.now() >= this.notBeforeMilliseconds
    ) {
      return;
    }

    this.queuedPermitCount += 1;
    const precedingPermit = this.permitTail;
    let releasePermit = (): void => undefined;
    const currentPermit = new Promise<void>((resolve) => {
      releasePermit = resolve;
    });
    this.permitTail = precedingPermit.then(() => currentPermit);

    await precedingPermit;

    try {
      const nowMilliseconds = this.now();
      const waitMilliseconds = Math.max(
        0,
        this.notBeforeMilliseconds - nowMilliseconds,
        this.lastPermitAtMilliseconds > 0
          ? this.lastPermitAtMilliseconds +
            this.requestSpacingMilliseconds -
            nowMilliseconds
          : 0,
      );

      if (waitMilliseconds > 0) {
        await this.wait(waitMilliseconds);
      }

      const permitAtMilliseconds = this.now();
      this.lastPermitAtMilliseconds = permitAtMilliseconds;
      this.notBeforeMilliseconds = Math.max(
        this.notBeforeMilliseconds,
        permitAtMilliseconds + this.requestSpacingMilliseconds,
      );
    } finally {
      this.queuedPermitCount -= 1;
      releasePermit();
    }
  }
}
