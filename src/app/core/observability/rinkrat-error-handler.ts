import { ErrorHandler, Injectable } from '@angular/core';

import { ClientErrorReporterService } from './client-error-reporter.service';

@Injectable()
export class RinkRatErrorHandler implements ErrorHandler {
  constructor(private readonly reporter: ClientErrorReporterService) {}

  handleError(error: unknown): void {
    this.reporter.report(error, 'angular-error-handler');
  }
}
