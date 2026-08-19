export type RinkRatPwaInstallState =
  | 'installed'
  | 'installable'
  | 'manual'
  | 'unsupported';

export interface RinkRatPwaRegistrationContext {
  developerToolsEnabled: boolean;
  secureContext: boolean;
  serviceWorkerSupported: boolean;
}

export interface RinkRatPwaInstallContext {
  installed: boolean;
  installPromptAvailable: boolean;
  serviceWorkerSupported: boolean;
}

export function canRegisterRinkRatServiceWorker(
  context: RinkRatPwaRegistrationContext,
): boolean {
  return !context.developerToolsEnabled &&
    context.secureContext &&
    context.serviceWorkerSupported;
}

export function isRinkRatStandaloneDisplay(options: {
  displayModeStandalone: boolean;
  navigatorStandalone: boolean;
}): boolean {
  return options.displayModeStandalone || options.navigatorStandalone;
}

export function resolveRinkRatPwaInstallState(
  context: RinkRatPwaInstallContext,
): RinkRatPwaInstallState {
  if (context.installed) {
    return 'installed';
  }

  if (context.installPromptAvailable) {
    return 'installable';
  }

  return context.serviceWorkerSupported ? 'manual' : 'unsupported';
}
