# Mobile Performance Findings and Fixes

## Why the mobile app felt slow

The largest issue was not one isolated image or CSS rule. Several expensive
systems were being pulled into the first JavaScript bundle before the user
needed them:

- The login component and full signed-in layout were both eagerly imported.
- The app root eagerly imported live scoring and player availability services.
- Those services pulled cycle, draft, playoff, NHL, and Firestore code into the
  initial bundle.
- Importing authentication also initialized the full Firestore SDK.
- The dashboard waited for the profile and every league/team request before it
  displayed the real page.
- Team collections were requested one league at a time.
- The two animated logo ribbons created 96 image elements per page.

These costs are much more noticeable on a phone because JavaScript parsing,
network latency, and CPU/GPU work are slower than on a desktop computer.

## What changed

### Smaller startup bundle

- Login and the signed-in layout are now lazy-loaded routes.
- Firebase app, authentication, and Firestore initialization are split so the
  database SDK does not load merely because authentication is needed.
- Live scoring is dynamically imported only after entering a league and is
  delayed until after the requested page has had time to render.
- Player-availability cleanup no longer downloads its service on the initial
  non-league route.

### Faster dashboard perception and data loading

- The dashboard shell displays as soon as authentication is known.
- Profile and league data refresh independently.
- Session-cached dashboard data is displayed immediately when revisiting the
  dashboard, then refreshed in the background.
- Skeleton league cards replace the full-screen wait.
- Team collections for multiple leagues are fetched in parallel instead of
  sequentially.
- Commissioner invite-document repair was removed from the dashboard's
  critical read path. League detail still repairs a missing legacy invite.

### Less mobile rendering and network work

- Marquee data now uses 16 teams duplicated for a seamless loop, reducing each
  page from 96 ribbon elements to 64.
- Ribbon logos use explicit dimensions, lazy loading, asynchronous decoding,
  and low fetch priority.
- The NHL asset host is preconnected.
- Hashed JavaScript and CSS receive immutable one-year cache headers when
  deployed through Firebase Hosting.
- Frequently used page authentication helpers return the already-resolved
  Firebase user immediately instead of always opening a new auth listener.

## Measured production bundle result

| Measurement | Before | After | Reduction |
|---|---:|---:|---:|
| Initial raw bundle | 1.12 MB | 404.43 kB | about 64% |
| Estimated initial transfer | 268.30 kB | 105.89 kB | about 61% |

The full Firestore SDK remains a lazy shared chunk because league pages require
real-time listeners. It is no longer part of the initial app shell.

## Expected behavior

- Login screen appears substantially sooner on a cold mobile load.
- Dashboard structure appears before all Firestore reads finish.
- Returning to the dashboard in the same browser tab feels nearly immediate.
- Multiple-league accounts avoid the former one-league-at-a-time team-query
  delay.
- Opening a league prioritizes rendering the page before initializing the
  background live-scoring worker.
