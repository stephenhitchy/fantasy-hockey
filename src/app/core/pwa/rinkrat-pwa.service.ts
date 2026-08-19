import { computed, Injectable, OnDestroy, signal } from '@angular/core';

import { APP_RUNTIME_CONFIG } from '../../../environments/app-runtime.config';
import {
  canRegisterRinkRatServiceWorker,
  isRinkRatStandaloneDisplay,
  resolveRinkRatPwaInstallState,
} from './rinkrat-pwa.util';

interface BeforeInstallPromptChoice {
  outcome: 'accepted' | 'dismissed';
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<BeforeInstallPromptChoice>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

const SERVICE_WORKER_PATH = '/rinkrat-sw.js';
const SERVICE_WORKER_SCOPE = '/';
const WORKER_ACTIVATION_TIMEOUT_MILLISECONDS = 2_500;
const STATUS_MESSAGE_DURATION_MILLISECONDS = 6_000;

@Injectable({ providedIn: 'root' })
export class RinkRatPwaService implements OnDestroy {
  readonly serviceWorkerSupported = signal(false);
  readonly workerReady = signal(false);
  readonly installed = signal(false);
  readonly installPromptAvailable = signal(false);
  readonly installing = signal(false);
  readonly updateWaiting = signal(false);
  readonly statusMessage = signal('');
  readonly errorMessage = signal('');

  readonly installState = computed(() => resolveRinkRatPwaInstallState({
    installed: this.installed(),
    installPromptAvailable: this.installPromptAvailable(),
    serviceWorkerSupported: this.serviceWorkerSupported(),
  }));

  readonly canInstall = computed(
    () => this.installState() === 'installable' && !this.installing(),
  );

  readonly showInstallCard = computed(() => {
    const state = this.installState();
    return state === 'installable' || state === 'manual';
  });

  private started = false;
  private destroyed = false;
  private deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
  private standaloneMediaQuery: MediaQueryList | null = null;
  private statusTimer: number | null = null;

  private readonly handleBeforeInstallPrompt = (event: Event): void => {
    event.preventDefault();
    this.deferredInstallPrompt = event as BeforeInstallPromptEvent;
    this.installPromptAvailable.set(true);
    this.errorMessage.set('');
  };

  private readonly handleAppInstalled = (): void => {
    this.deferredInstallPrompt = null;
    this.installPromptAvailable.set(false);
    this.installed.set(true);
    this.installing.set(false);
    this.showStatus('RinkRat was installed on this device.');
  };

  private readonly handleDisplayModeChange = (): void => {
    this.refreshInstalledState();
  };

  start(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') {
      return;
    }

    this.started = true;
    this.refreshInstalledState();
    window.addEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', this.handleAppInstalled);

    this.standaloneMediaQuery = window.matchMedia('(display-mode: standalone)');
    this.standaloneMediaQuery.addEventListener('change', this.handleDisplayModeChange);

    const serviceWorkerSupported = 'serviceWorker' in navigator;
    const secureContext = window.isSecureContext ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';

    const mayRegister = canRegisterRinkRatServiceWorker({
      developerToolsEnabled: APP_RUNTIME_CONFIG.developerToolsEnabled,
      secureContext,
      serviceWorkerSupported,
    });

    this.serviceWorkerSupported.set(mayRegister);

    if (mayRegister) {
      this.registrationPromise = this.registerServiceWorker();
    }
  }

  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.clearStatusTimer();

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', this.handleAppInstalled);
    }

    this.standaloneMediaQuery?.removeEventListener('change', this.handleDisplayModeChange);
    this.standaloneMediaQuery = null;
  }

  async install(): Promise<boolean> {
    const prompt = this.deferredInstallPrompt;

    if (!prompt || this.installed() || this.installing()) {
      return false;
    }

    this.installing.set(true);
    this.errorMessage.set('');
    this.statusMessage.set('');

    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      this.deferredInstallPrompt = null;
      this.installPromptAvailable.set(false);

      if (choice.outcome === 'accepted') {
        this.showStatus('Finishing the RinkRat installation…');
        return true;
      }

      this.showStatus('Installation canceled. You can install RinkRat later.');
      return false;
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not open the installation prompt.',
      );
      return false;
    } finally {
      this.installing.set(false);
    }
  }

  async checkForWorkerUpdate(): Promise<void> {
    const registration = await this.getRegistration();

    if (!registration || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      return;
    }

    try {
      await registration.update();
      this.updateWaiting.set(Boolean(registration.waiting));
    } catch {
      // The release-manifest checker remains the visible update authority.
    }
  }

  reloadWithLatestWorker(): void {
    void this.reloadWithLatestWorkerInternal();
  }

  private async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    try {
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
        scope: SERVICE_WORKER_SCOPE,
        updateViaCache: 'none',
      });

      this.registration = registration;
      this.workerReady.set(Boolean(registration.active || navigator.serviceWorker.controller));
      this.updateWaiting.set(Boolean(registration.waiting));
      this.observeRegistration(registration);

      void navigator.serviceWorker.ready.then((readyRegistration) => {
        if (this.destroyed) {
          return;
        }

        this.registration = readyRegistration;
        this.workerReady.set(true);
        this.updateWaiting.set(Boolean(readyRegistration.waiting));
      });

      return registration;
    } catch (error: unknown) {
      this.errorMessage.set(
        error instanceof Error
          ? error.message
          : 'RinkRat could not prepare app installation on this browser.',
      );
      return null;
    }
  }

  private observeRegistration(registration: ServiceWorkerRegistration): void {
    registration.addEventListener('updatefound', () => {
      const installingWorker = registration.installing;

      if (!installingWorker) {
        return;
      }

      installingWorker.addEventListener('statechange', () => {
        if (installingWorker.state !== 'installed') {
          return;
        }

        this.updateWaiting.set(Boolean(registration.waiting));
      });
    });
  }

  private async getRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (this.registration) {
      return this.registration;
    }

    if (this.registrationPromise) {
      return this.registrationPromise;
    }

    return null;
  }

  private async reloadWithLatestWorkerInternal(): Promise<void> {
    if (typeof window === 'undefined') {
      return;
    }

    const registration = await this.getRegistration();

    if (!registration) {
      window.location.reload();
      return;
    }

    try {
      await registration.update();
    } catch {
      window.location.reload();
      return;
    }

    const waitingWorker = registration.waiting ??
      await this.waitForWaitingWorker(registration, 1_800);

    if (!waitingWorker) {
      window.location.reload();
      return;
    }

    let reloadStarted = false;
    let fallbackTimer: number | null = null;

    const reload = (): void => {
      if (reloadStarted) {
        return;
      }

      reloadStarted = true;

      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }

      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    fallbackTimer = window.setTimeout(reload, WORKER_ACTIVATION_TIMEOUT_MILLISECONDS);
  }

  private waitForWaitingWorker(
    registration: ServiceWorkerRegistration,
    timeoutMilliseconds: number,
  ): Promise<ServiceWorker | null> {
    if (registration.waiting) {
      return Promise.resolve(registration.waiting);
    }

    const installingWorker = registration.installing;

    if (!installingWorker || typeof window === 'undefined') {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (worker: ServiceWorker | null): void => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timer);
        installingWorker.removeEventListener('statechange', handleStateChange);
        resolve(worker);
      };

      const handleStateChange = (): void => {
        if (installingWorker.state === 'installed') {
          finish(registration.waiting);
          return;
        }

        if (installingWorker.state === 'redundant') {
          finish(null);
        }
      };

      const timer = window.setTimeout(() => finish(registration.waiting), timeoutMilliseconds);
      installingWorker.addEventListener('statechange', handleStateChange);
    });
  }

  private refreshInstalledState(): void {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      this.installed.set(false);
      return;
    }

    this.installed.set(isRinkRatStandaloneDisplay({
      displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
      navigatorStandalone: Boolean((navigator as NavigatorWithStandalone).standalone),
    }));
  }

  private showStatus(message: string): void {
    this.clearStatusTimer();
    this.statusMessage.set(message);

    if (typeof window === 'undefined') {
      return;
    }

    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = null;
      this.statusMessage.set('');
    }, STATUS_MESSAGE_DURATION_MILLISECONDS);
  }

  private clearStatusTimer(): void {
    if (this.statusTimer === null || typeof window === 'undefined') {
      return;
    }

    window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }
}
