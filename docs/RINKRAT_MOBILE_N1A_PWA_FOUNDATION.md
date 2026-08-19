# Mobile Batch N1A — Installable PWA Foundation

**Runtime release:** Release Candidate 48

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surfaces:** Account Settings, mobile More menu, application shell, release-update flow

## Purpose

N1A builds on the A1I Coach's Briefing release and makes the existing RinkRat web application installable on supported phones and desktop browsers without creating a native-app fork. It adds a small Progressive Web App shell while preserving the website as the source of truth.

This is an installability and safe-shell release. It is not an offline competitive mode and it does not claim that every league screen is fully usable without a connection.

## Install experience

The source-controlled manifest defines:

```text
App name: RinkRat Fantasy
Short name: RinkRat
Display mode: standalone
Scope: /
Theme/background: RinkRat dark ice
Icons: 192×192 and 512×512
Shortcuts: Dashboard and Account Settings
```

Account Settings contains one concise **Install RinkRat** card only while installation is actionable or the browser requires manual **Add to Home Screen** guidance. When a browser exposes its native install prompt, the card offers an **Install** button. Once installed—or when the browser offers no supported installation path—the card disappears instead of becoming permanent account-page clutter.

The mobile More menu displays **Install RinkRat** only while a native prompt is available. Installed and unsupported states do not add another navigation item.

## Service-worker registration

The browser registers:

```text
/rinkrat-sw.js
scope: /
updateViaCache: none
```

Registration occurs only in the production runtime, on a secure origin, and when the browser supports service workers. Local developer builds keep service-worker caching disabled so an old shell cannot hide current source changes.

## Safe cache policy

N1A uses two versioned, RinkRat-owned caches:

```text
App shell
Stable same-origin assets
```

The application shell includes the root document, offline fallback, icons, and core branding. During installation, the worker reads the deployed index and prefetches its current same-origin hashed JavaScript and CSS so the first installed launch has a complete shell. The web manifest itself remains network-only so install metadata cannot be pinned to an old cached release. Later same-origin fonts and images are cached only after they are requested.

Navigation uses a network-first policy:

1. Try the current deployed page.
2. Fall back to the previously loaded application shell.
3. Fall back to the static RinkRat offline page.

The worker does not intercept cross-origin Firebase, Google, NHL, ESPN, or analytics requests.

The following same-origin routes remain network-only:

```text
/release-manifest.json
/rinkrat-sw.js
/site.webmanifest
/v1/**
/stats/**
/espn/**
/security/**
```

This prevents the worker from turning release identity, NHL data, proxy responses, or security reports into a stale cache authority.

## Competitive-action boundary

The service worker handles only `GET` requests. N1A adds no Background Sync listener, offline mutation queue, replay queue, local transaction store, or automatic retry of a Draft/roster/waiver/commissioner action.

The existing connection guard remains authoritative in the browser. While offline it says that scores may be stale and blocks competitive submission with the explicit statement that no roster, waiver, Draft, or testing request was sent.

The static offline page repeats that no competitive action was queued.

N1A therefore completes the policy requirement that RinkRat must never silently queue a competitive action while offline. It does not complete the separate roadmap item for clearly labeled stale read-only matchup data.

## Release-update safety

RinkRat already compares the bundled release manifest with the current deployed manifest before competitive actions continue.

N1A integrates service-worker activation with that same visible release banner:

1. A newly installed worker waits instead of taking over an active session automatically.
2. The manager chooses the existing release reload action.
3. RinkRat asks the waiting worker to activate.
4. The page reloads after `controllerchange`, with a bounded fallback reload.

This reduces the risk of a new HTML shell running against an old set of lazy-loaded chunks during an active Draft or roster action.

## Offline expectations

After at least one successful online visit, an installed app can reopen the RinkRat shell or the static offline fallback when navigation fails.

The following remain connection-dependent:

```text
Authentication refresh
Live scores
Current Firestore league data
NHL and ESPN data
Draft, roster, waiver, commissioner, and testing writes
```

N1.3 remains open for a future release that intentionally saves, labels, and timestamps stale read-only matchup information. N1A does not silently present an old matchup as current.

## Data, privacy, and architecture

N1A adds no:

```text
Cloud Function
Firestore document
Firestore listener
Firestore Rule
Firestore index
TTL policy
Push subscription
Analytics event requirement
Competitive write
```

The worker stores only public application-shell and stable asset responses in the browser cache. It does not cache authenticated Firestore responses or private manager records.

## Preserved RC47 product behavior

The A1I Coach's Briefing remains intact: it still shows at most three timely items, one per league, and disappears when nothing needs attention. Exact-position default Roster Fit, Power Rankings, Player Intel, Add / Drop, League Wire, share cards, and Identity Architect remain unchanged.

N1A changes no Scoring V3, Projection V11 formula, immutable six-game roster-slot window, seventh-game rollover, competitive callable authority, Firestore Rule, index, TTL policy, App Check setting, scoring-queue mode, or NHL-cache authority.

## One automated verification gate

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchn1a && echo "N1A VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Deployment

N1A is Hosting-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Mobile N1A Installable PWA Release Candidate 48"
```

No Functions, Rules, indexes, TTL policies, App Check settings, scoring configuration, or NHL-cache configuration belong to this deployment.

The Hosting configuration serves the worker with `no-cache, no-store, must-revalidate`, allows root scope, and prevents the manifest from becoming an immutable stale file.

## Site-first proof

Use a supported browser on the deployed site:

1. Open Account Settings and confirm the install card appears only when installation or manual Add to Home Screen guidance is available.
2. Install RinkRat through the native prompt or the browser's Add to Home Screen option.
3. Confirm the install card and mobile More-menu action no longer occupy space after installation.
4. Launch RinkRat from the installed icon and confirm it opens in standalone mode.
5. Confirm Dashboard and Account shortcuts route correctly when the browser exposes shortcuts.
6. Load RinkRat online once, then disable the connection and navigate or reopen it.
7. Confirm either the previously loaded shell or the static offline page appears.
8. Confirm the global offline notice appears when the Angular shell is available.
9. Attempt no destructive production action; in a disposable test league, confirm Draft/roster/waiver/testing controls remain blocked and no request is queued.
10. Restore the connection and confirm live data reconnects before competitive actions unlock.
11. On a later deployment, confirm the existing release banner performs one clean reload into the new worker rather than silently switching the active tab.

## Rollback

A normal N1A rollback is Hosting-only from a known-good verified tag. The prior worker remains safe because it caches only GET shell/assets and does not own competitive writes.

When the service worker itself is the incident source, deploy a corrected worker or a known-good Hosting build. Do not change Firestore Rules, indexes, TTL, App Check, scoring, projections, scoring queue, or NHL-cache authority as part of a PWA rollback.
