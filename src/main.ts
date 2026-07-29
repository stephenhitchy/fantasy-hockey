import { bootstrapApplication } from '@angular/platform-browser';

import { initializeRinkRatAppCheck } from './app/core/firebase-app-check';

// App Check must be initialized before Auth, Firestore, Functions, or Analytics
// are imported and begin making requests. The Angular app is loaded
// dynamically after this initialization point to preserve that order.
initializeRinkRatAppCheck();

Promise.all([
  import('./app/app.config'),
  import('./app/app'),
])
  .then(([{ appConfig }, { App }]) => bootstrapApplication(App, appConfig))
  .catch((error: unknown) => console.error(error));
