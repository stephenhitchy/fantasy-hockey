# Fantasy Hockey Beta Hosting and Team Name Fix V1

This package addresses the three issues found during the first hosted beta test.

## 1. Team renaming is now visible from League Home

The League Home header now displays:

- `Your Team`
- the current team name
- a clearly labeled `Rename Team` button
- an inline save/cancel form

The form uses the saved favorite-team accent colors and becomes a stacked, phone-friendly layout on mobile.

The original Team Name editor on the My Team page remains available.

## 2. New teams default to the account name

When someone creates or joins a league, the initial fantasy team name now uses the account username already passed into the league setup flow.

Examples:

- Account name `Stephen` creates team `Stephen`
- Account name `Hockey Dad` joins with team `Hockey Dad`

This applies to newly created teams and repaired legacy memberships that are missing their team document. Existing team names are not overwritten.

## 3. Hosted NHL API requests are repaired

Local Angular development uses `src/proxy.conf.json` for these paths:

- `/v1/**`
- `/stats/**`

Firebase Hosting does not use Angular's development proxy. The previous SPA fallback therefore handled those URLs instead of the NHL API, causing the hosted roster request to parse the Angular page as data.

This package adds:

- `nhlApiProxy`, an allow-listed HTTPS Cloud Function
- Firebase Hosting rewrites for `/v1/**` and `/stats/**`
- the SPA fallback after the API rewrites
- short cache windows appropriate for rosters, schedules, gamecenter data, and stats
- request timeout and safe error responses

The browser continues using the same relative API paths, so localhost development is unchanged.

## Installation

1. Stop the Angular dev server.
2. Extract this package into the project root and replace the included files.
3. From the project root, install function dependencies if needed:

```bash
cd functions
npm install
cd ..
```

4. Confirm the Cycle Puck Hosting target exists:

```bash
firebase target:apply hosting app cycle-puck
```

You only need to run that command once. If the `app` target already exists, Firebase will keep using it.

5. Build the Angular app:

```bash
npm run build
```

6. Deploy the new proxy function and website together:

```bash
firebase deploy --only functions:nhlApiProxy,hosting:app
```

The Cloud Function deployment requires the Firebase project to use the Blaze plan. This project already has a deployed daily injury callable function, so it may already be configured correctly.

## Important deployment detail

Deploying only Hosting will not create the API proxy. Until `nhlApiProxy` is deployed, the hosted draft/player loading requests will continue to fail.

## No Firestore rules update

This package does not change `firestore.rules`. Existing team-owner update permissions already allow a manager to change their own team name.

## Validation completed

- Root TypeScript compilation passed.
- Angular template compilation with `ngc` passed.
- Cloud Functions TypeScript build passed.
- `firebase.json` and `functions/package.json` JSON validation passed.
- The full Angular CLI bundle could not be run in the packaging container because its Node version is `22.16.0`; the project now requires Node `22.22.3+`. Run `npm run build` locally with your working Node `22.23.1` before deployment.
