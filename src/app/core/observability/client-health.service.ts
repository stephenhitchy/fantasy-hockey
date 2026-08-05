import { computed, Injectable, OnDestroy, signal } from '@angular/core';

import { TelemetryService } from './telemetry.service';

export type ClientConnectionNoticeState = 'offline' | 'restored';

export interface ClientConnectionNotice {
  state: ClientConnectionNoticeState;
  title: string;
  detail: string;
}

export interface ClientConnectionSnapshot {
  online: boolean;
  visible: boolean;
  effectiveConnectionType: string;
  saveData: boolean;
  downlinkMbps: number | null;
  roundTripMilliseconds: number | null;
}

interface NavigatorConnectionLike extends EventTarget {
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
}

function getNavigatorConnection(): NavigatorConnectionLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return (
    navigator as Navigator & {
      connection?: NavigatorConnectionLike;
      mozConnection?: NavigatorConnectionLike;
      webkitConnection?: NavigatorConnectionLike;
    }
  ).connection ??
    (
      navigator as Navigator & {
        mozConnection?: NavigatorConnectionLike;
      }
    ).mozConnection ??
    (
      navigator as Navigator & {
        webkitConnection?: NavigatorConnectionLike;
      }
    ).webkitConnection ??
    null;
}

@Injectable({ providedIn: 'root' })
export class ClientHealthService implements OnDestroy {
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly visible = signal(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  readonly effectiveConnectionType = signal('unknown');
  readonly saveData = signal(false);
  readonly downlinkMbps = signal<number | null>(null);
  readonly roundTripMilliseconds = signal<number | null>(null);
  readonly restoredNoticeVisible = signal(false);

  readonly connectionNotice = computed<ClientConnectionNotice | null>(() => {
    if (!this.online()) {
      return {
        state: 'offline',
        title: 'You are offline',
        detail:
          'Scores may be stale. Draft, roster, waiver, and commissioner actions will not submit until the connection returns.',
      };
    }

    if (this.restoredNoticeVisible()) {
      return {
        state: 'restored',
        title: 'Connection restored',
        detail: 'RinkRat is reconnecting live league data before you continue.',
      };
    }

    return null;
  });

  readonly shouldPauseDecorations = computed(
    () => !this.online() || !this.visible() || this.saveData(),
  );

  private readonly connection = getNavigatorConnection();
  private restoreTimer: number | null = null;
  private destroyed = false;

  private readonly handleOnline = (): void => {
    const wasOffline = !this.online();
    this.online.set(true);

    if (!wasOffline) {
      return;
    }

    this.restoredNoticeVisible.set(true);
    this.telemetry.track('client_connection_restored', {
      page_path: this.telemetry.sanitizedCurrentRoute(),
      connection_type: this.effectiveConnectionType(),
    });

    this.clearRestoreTimer();

    if (typeof window !== 'undefined') {
      this.restoreTimer = window.setTimeout(() => {
        this.restoreTimer = null;
        this.restoredNoticeVisible.set(false);
      }, 5_000);
    }
  };

  private readonly handleOffline = (): void => {
    if (!this.online()) {
      return;
    }

    this.online.set(false);
    this.restoredNoticeVisible.set(false);
    this.clearRestoreTimer();
    this.telemetry.track('client_connection_lost', {
      page_path: this.telemetry.sanitizedCurrentRoute(),
      connection_type: this.effectiveConnectionType(),
    });
  };

  private readonly handleVisibilityChange = (): void => {
    this.visible.set(document.visibilityState !== 'hidden');
  };

  private readonly handleConnectionChange = (): void => {
    this.readConnectionInformation();
  };

  constructor(private readonly telemetry: TelemetryService) {
    this.readConnectionInformation();

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.connection?.addEventListener('change', this.handleConnectionChange);
  }

  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.clearRestoreTimer();

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.connection?.removeEventListener('change', this.handleConnectionChange);
  }

  getSnapshot(): ClientConnectionSnapshot {
    return {
      online: this.online(),
      visible: this.visible(),
      effectiveConnectionType: this.effectiveConnectionType(),
      saveData: this.saveData(),
      downlinkMbps: this.downlinkMbps(),
      roundTripMilliseconds: this.roundTripMilliseconds(),
    };
  }

  private readConnectionInformation(): void {
    const effectiveType = this.connection?.effectiveType?.trim();
    const downlink = this.connection?.downlink;
    const rtt = this.connection?.rtt;

    this.effectiveConnectionType.set(effectiveType || 'unknown');
    this.saveData.set(Boolean(this.connection?.saveData));
    this.downlinkMbps.set(
      typeof downlink === 'number' && Number.isFinite(downlink) ? downlink : null,
    );
    this.roundTripMilliseconds.set(
      typeof rtt === 'number' && Number.isFinite(rtt) ? rtt : null,
    );
  }

  private clearRestoreTimer(): void {
    if (this.restoreTimer === null || typeof window === 'undefined') {
      return;
    }

    window.clearTimeout(this.restoreTimer);
    this.restoreTimer = null;
  }
}
