import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { RinkRatErrorHandler } from './core/observability/rinkrat-error-handler';

/**
 * Application-wide browser policy. Keep product/domain providers closer to
 * their features; this root config is reserved for routing, global error
 * capture, and behavior that must apply to every navigation.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),
    {
      provide: ErrorHandler,
      useClass: RinkRatErrorHandler,
    },
  ],
};
