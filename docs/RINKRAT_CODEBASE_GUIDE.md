# RinkRat Codebase Guide

Last verified against source: 2026-09-21

## Purpose

This is the stable map for understanding the current RinkRat codebase. Read it
before tracing an unfamiliar feature or changing a cross-cutting workflow. It
explains where behavior lives, which layer owns a decision, and which contracts
must remain unchanged.

This guide describes the current structure. The chronological record of shipped
batches remains in `docs/RINKRAT_PROJECT_DOCUMENTATION.md`, and operational
handoff state remains in `docs/RINKRAT_CODEX_HANDOFF.md`. Feature-specific and
release-specific documents in `docs/` supply deeper evidence; they do not
replace the current source.

Comments in source code follow the same rule as this guide: explain authority,
invariants, lifecycle, recovery, or non-obvious tradeoffs. Do not add comments
that merely restate a function name or speculate about historical intent.

## Read this first

Before changing code:

1. Read `AGENTS.md` and the nearest nested `AGENTS.md`.
2. Read `docs/RINKRAT_CODEX_HANDOFF.md`.
3. Read this guide.
4. Read the closest feature, batch, or runbook document for the subsystem.
5. Inspect the implementation and its tests; documentation is orientation, not
   permission to skip source verification.
6. Confirm the working tree, branch, current commit, live release manifest, and
   deployed Firebase evidence independently.

## Protected competitive contracts

These are product contracts, not implementation suggestions:

- Production Scoring V4 is the production scoring system.
- Projection V11 is the production projection model.
- Prospect Projection Layer V1 is an optional, disabled-by-default evidence
  adapter into Projection V11. Its contract and current data-source limitation
  are documented in `docs/RINKRAT_DRAFT_FF1_18_PROSPECT_PROJECTIONS.md`.
- Every active roster slot owns an independent six-NHL-game fantasy window.
- A seventh eligible NHL game belongs to that slot's next fantasy matchup.
- A started window is immutable; later data or roster changes cannot move a
  game, its points, or its transaction boundary.
- Draft picks, roster moves, waivers, IR, scoring publication, standings, and
  playoff advancement are server-authoritative.
- Team Goalie Units are fantasy assets; individual NHL goalies are not drafted
  as independent assets.
- Missing competitive evidence must not be silently converted to zero.
- Retries must be idempotent and an older task must not overwrite or clear a
  newer source version.

Changing any item above requires an explicitly scoped task, dedicated
compatibility tests, a rollback path, and exact deployment evidence.

## System at a glance

```text
Browser route/component
        |
        +--> read models and bounded Firestore listeners
        |
        +--> callable request for a competitive mutation
                    |
                    v
          Cloud Function authority
          validates identity, league state,
          expected revision, and idempotency
                    |
                    v
                Firestore
                    |
                    v
          listener/read confirmation in UI

NHL API --> proxy/canonical facts --> affected-league queue --> scoring task
                                                           --> immutable result
```

The browser presents state, collects intent, and reconciles committed results.
It must not become the final authority for a competitive decision simply
because equivalent validation logic is convenient to run in the UI.

## Authority map

| Concern              | Browser responsibility                                  | Authoritative responsibility                                |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Authentication       | Session UX, redirects, recent-auth prompts              | Firebase Authentication                                     |
| Route access         | Avoid unusable navigation and show access-denied UX     | Firestore Rules and callable validation                     |
| Draft                | Render board, queue, clock, submit expected pick        | `functions/src/draft-authority.ts` and draft automation     |
| Roster / waiver / IR | Preview eligibility, collect intent, show pending state | `functions/src/roster-authority.ts` and roster move helpers |
| Projections          | Read and verify published snapshots, request generation | `functions/src/projection-authority.ts`                     |
| Scoring              | Render windows and scores; run explicit simulators only | league automation and server scoring path                   |
| Standings / playoffs | Render committed state                                  | server completion and advancement logic                     |
| NHL data             | Request through the approved client service             | NHL proxy, canonical fact ingestion, and queue workers      |
| Operations           | Present evidence and submit bounded admin commands      | admin-only callable authority with audit records            |

Route guards and client-side validation are defense-in-depth and user
experience controls. They never replace Rules or server validation.

## Repository map

### Browser application

- `src/main.ts` is the bootstrap boundary. App Check initializes before modules
  that can initialize Auth, Firestore, Functions, or Analytics.
- `src/app/app.config.ts` registers application-wide Angular providers.
- `src/app/app.routes.ts` is the route and navigation-access map.
- `src/app/app.ts` owns root-lifetime concerns: release/PWA coordination,
  telemetry, global profile/theme refresh, route context, and cleanup.
- `src/app/layouts/` contains shared page shells.
- `src/app/features/` contains route-level screens and feature presentation.
- `src/app/core/` contains reusable domain models, reads, listeners, callable
  adapters, pure utilities, and cross-feature services.
- `src/app/shared/` contains presentation primitives and reusable accessibility
  behavior that is not owned by one business domain.
- `src/environments/` contains checked-in runtime configuration. Treat secrets
  and production state as external, even when configuration flags live here.

### Server and Firebase

- `functions/src/index.ts` is the Cloud Functions export surface and also owns a
  small set of legacy/top-level HTTP and callable handlers.
- `functions/src/*-authority.ts` files own validated server decisions for their
  named domains.
- `functions/src/*-automation.ts` files own scheduled/task-driven orchestration.
- `functions/src/shared/` contains logic shared by server domains, including the
  server copies of competitive core models and security utilities.
- `firestore.rules`, `firestore.indexes.json`, and Firebase configuration are
  separate protected deployment surfaces. Application code changes do not
  imply that any of them should be deployed.

### Verification and operations

- `test/` contains source-level, emulator, release, security, load, and
  regression suites.
- `scripts/` contains deterministic verification, release, and operational
  tooling. Read a script before running it; names that mention staging or
  production can still require external authority or credentials.
- `docs/` contains the architecture history, release evidence, runbooks, and
  rollback notes.
- `public/release-manifest.json` and its validation tooling identify the bundled
  client release. The live manifest must be checked separately.

## Browser architecture

### Routing tiers

`src/app/app.routes.ts` is organized into three broad tiers:

1. Public entry routes for authentication and league invitations.
2. Public resource routes for legal, support, fairness, and scoring material.
3. Authenticated application routes inside the main layout.

Within the authenticated tier:

- `platformAdminGuard` protects platform operations screens.
- `leagueMemberGuard` protects league-member screens.
- `commissionerGuard` adds commissioner-only navigation checks.
- pending-action `canDeactivate` guards keep users from accidentally leaving a
  draft, roster, or draft-setup operation before its outcome is reconciled.

All route components are lazy loaded. Preserve this boundary when adding a
screen unless there is a measured reason to move code into the initial bundle.

### Feature and core split

Feature components should coordinate presentation and user interaction. Put
portable models, deterministic calculations, bounded data access, and callable
adapters in the matching `src/app/core/<domain>/` folder.

The main client domains are:

- `auth/`: account session, recent authentication, deletion, and password
  policy.
- `cycle/`: fantasy cycle documents, independent slot windows, matchup
  selection, and explicit simulators.
- `draft/`: draft models, player-pool reads, queue/listener behavior, browser
  strategy previews, and server-authority adapters.
- `league/`: league reads, member/team identity, activity feed, manager
  briefing, standings presentation, and share-card data.
- `live-scoring/`: live state reads, score view models, freshness, and
  diagnostics simulators.
- `nhl/`: the approved browser NHL API boundary.
- `observability/`: telemetry, client errors, listener health, performance, and
  pending competitive-action tracking.
- `player/`: player board, availability, notes, watchlist, opportunity, roster
  fit, and window-progress presentation.
- `playoffs/`: playoff models, read helpers, window-bank presentation, and
  simulators.
- `projection/`: Projection V11 utilities, snapshot verification, ranking,
  trajectories, and explicit simulators.
- `pwa/`: service-worker coordination and bounded offline matchup snapshots.
- `release/`: bundled/live manifest comparison, update safety, readiness, and
  release simulations.
- `scoring/`: scoring rules and engine helpers. Treat this as protected even
  when a function appears pure.
- `team/`: roster and team models, configuration, normalization, and reads.
- `transactions/`: server-authority adapters and non-authoritative eligibility
  previews for roster actions.

Operations, privacy, security, replay, notifications, onboarding, and admin
folders provide the corresponding cross-feature services.

### Firebase initialization

The import order is deliberate:

1. `src/main.ts` initializes App Check.
2. `src/app/core/firebase-app.ts` creates or reuses the Firebase app.
3. `firebase-auth.ts`, `firebase-firestore.ts`, and `firebase-functions.ts`
   initialize products and connect emulators only when the loopback-only,
   session-bounded D1N emulator configuration is enabled.
4. `firebase-firestore.ts` forces long polling for resilience on Safari,
   privacy relays, and mobile networks.

Do not replace these files with eager barrel imports that can initialize a
Firebase product before App Check.

### Listener and asynchronous-operation lifecycle

Every realtime listener needs an explicit owner and cleanup path. Components
should unsubscribe on destruction; root-lifetime services must expose or own
their shutdown. Reuse an existing shared subscription or bounded read before
adding another listener.

Every competitive action needs these states:

- submitting/loading;
- authoritative success confirmation;
- explicit failure with retry or recovery;
- transport timeout with Firestore reconciliation when the server may still
  have committed;
- stale-tab/release handling;
- safe navigation-away behavior.

The callable response is useful evidence, but the committed authoritative
document is what the rest of the application must converge on.

## Server architecture

### Export surface

`functions/src/index.ts` exports the deployable Firebase resources. Targeted
deployment selectors come from this export surface, not from filenames alone.
Do not broaden a selector simply because a changed module is imported by more
than one resource; trace the import graph and name each affected export.

Major server domains include:

- `draft-authority.ts`, `draft-automation.ts`, and `draft-pick-engine.ts` for
  commands, picks, clocks, auto-draft, handoff, and retry-safe pick application;
- `roster-authority.ts` and `roster-moves.ts` for add/drop, open-slot, waiver,
  bench, and IR mutations;
- `projection-authority.ts` for server-generated, versioned, integrity-checked
  Projection V11 snapshots;
- `league-automation.ts` for scoring queues, season transitions, historical
  replay orchestration, completion, and operations evidence;
- `nhl-canonical-impact-feed.ts` for canonical NHL changes and affected-league
  targeting;
- `league-lifecycle-authority.ts` for secure league create/join/member/capacity
  and cosmetics operations;
- `league-activity.ts` for server-authored league feed events and reactions;
- security, privacy, private-season, incident, manager-profile, player-note,
  watchlist, notification, and identity-challenge authorities.

### Server mutation checklist

For every competitive write, confirm:

1. authenticated identity and role;
2. sanitized document identifiers;
3. exact league/entity state and expected revision;
4. idempotency key or deterministic document identity;
5. transactional or batch atomicity where partial application is unsafe;
6. retry behavior after an ambiguous transport result;
7. audit and observability evidence;
8. protection against an older source/task clearing newer state;
9. bounded reads and writes;
10. a test for duplicate delivery and the corrected edge case.

## Canonical league data paths

The paths below are orientation, not an exhaustive schema:

- `leagues/{leagueId}`: league identity, settings, capacity, and lifecycle.
- `leagues/{leagueId}/members/{userId}`: membership identity.
- `leagues/{leagueId}/teams/{ownerId}`: fantasy team identity.
- `leagues/{leagueId}/teams/{ownerId}/roster/current`: current roster state.
- `leagues/{leagueId}/draft/current`: draft settings and live turn state.
- `leagues/{leagueId}/draft/current/picks/{pickId}`: committed draft picks.
- `leagues/{leagueId}/draft/current/queues/{ownerId}`: manager draft queues.
- `leagues/{leagueId}/projectionSnapshots/{snapshotId}`: projection metadata.
- `leagues/{leagueId}/projectionSnapshots/{snapshotId}/assets/{assetId}`:
  snapshot assets.
- `leagues/{leagueId}/cycles/cycle-{number}`: fantasy period state.
- `leagues/{leagueId}/cycles/cycle-{number}/matchups/{matchupId}`: matchup
  results and progress.
- `leagues/{leagueId}/transactions/{transactionId}`: transaction history.
- `leagues/{leagueId}/waivers/{waiverId}` and manager claim collections:
  waiver state.
- `leagues/{leagueId}/activity/{activityId}`: league wire/activity entries.
- `leagues/{leagueId}/liveScoring/*`: live-scoring control and cycle evidence.
- `leagues/{leagueId}/historicalReplay/control`: historical replay control.

Always inspect the current model and normalizer before relying on a field. A
path being readable by the browser does not mean the browser may write it.

## End-to-end workflows

### Draft

1. Draft screens subscribe through `src/app/core/draft/draft.service.ts` and
   load the server-published player pool/projection snapshot.
2. `draft-authority.service.ts` sends a command or pick with the exact league,
   asset, submission ID, and expected overall pick.
3. `functions/src/draft-authority.ts` validates the request and delegates the
   deterministic pick operation to the server engine.
4. Draft automation advances clocks, scheduled starts, and auto-draft without
   transferring authority to a browser tab.
5. The Draft Room reconciles the callable result or ambiguous timeout against
   committed draft and pick documents.

### Roster, waiver, and IR

1. Client utilities may preview whether a move appears eligible.
2. `src/app/core/transactions/roster-authority.service.ts` sends the user's
   intent to `executeSecureRosterAction` or requests roster initialization.
3. Server authority revalidates current ownership, slot state, timing, league
   rules, and transaction boundaries.
4. The committed roster, waiver, and transaction documents drive UI success.

### Projection snapshots

1. Client projection services read the current or target-cycle pointer.
2. Metadata must match Projection V11, the current draft-ranking version, the
   scoring-rules compatibility range, and integrity evidence.
3. Missing or stale data triggers a server generation request; the browser does
   not fabricate a competitive snapshot.
4. Server authority publishes versioned metadata and asset documents, then the
   client invalidates its bounded read cache and reconciles the result.

### Scoring and six-game windows

1. Each active roster slot owns its own immutable window.
2. NHL facts are fetched through the approved direct/canonical architecture and
   carry source-version evidence.
3. A per-league idempotent task evaluates only the affected scope.
4. Final and post-final checks distinguish provisional data from settlement and
   later corrections.
5. Publication must not duplicate a game, move window ownership, reactivate a
   transaction, or advance standings/playoffs twice.
6. Direct NHL scoring remains the proven fallback unless the live Canary gates
   explicitly establish a narrower canonical authority.

### League and dashboard reads

Dashboard and League HQ features aggregate bounded league, team, schedule,
matchup, and NHL data for presentation. Keep derived card/view logic in pure
utilities where possible. When a card links to a league-specific destination,
carry the exact league/cycle/matchup identity instead of inferring it later
from a player alone.

### Releases and updates

The bundled manifest and live manifest are different evidence. The root app
detects a changed deployment, defers reload while a competitive action is
pending, and coordinates the service worker. A source commit, Hosting deploy,
and Function deploy are independent events and must be reported separately.

## How to trace an unfamiliar behavior

### From a screen

1. Find the URL in `src/app/app.routes.ts`.
2. Open the lazy-loaded feature component and its template/styles.
3. List imported `core/` services and pure utilities.
4. For each listener, find its unsubscribe path and error callback.
5. For each mutation, follow the callable name into `functions/src/index.ts`
   and then its authority module.
6. Follow each Firestore path into its model normalizer and Rules.
7. Find focused tests by the component, utility, callable, or batch name.

### From a Cloud Function

1. Find the exported resource in `functions/src/index.ts`.
2. Identify the authority/automation module and imported shared helpers.
3. Record every collection read or written and every task/schedule invoked.
4. Check idempotency, revisions, leases, source versions, audit evidence, and
   older-task behavior.
5. Identify the exact deployment selector and any dependent exports.

### From a production symptom

1. Verify the live release manifest and deployed resource state first.
2. Determine whether the symptom is presentation, stale client, missing read,
   rejected command, ambiguous timeout, or committed server-state failure.
3. Use existing operations evidence before adding new listeners or writes.
4. Reproduce with the smallest safe local/emulator fixture.
5. Add a regression test that fails for the actual boundary that broke.

## Commenting standard

Add a comment when it preserves knowledge that types and names do not express:

- why a browser is not authoritative;
- why an operation uses a timeout, lease, revision, or deterministic ID;
- what must remain immutable across retries or corrections;
- who owns a listener and when it stops;
- why a fallback is safe and what evidence activates it;
- why an import/initialization order matters;
- which compatibility/version contract a normalizer enforces.

Do not add comments that:

- translate one obvious line into English;
- claim intent that cannot be proven from source, tests, or documentation;
- copy an entire release note into runtime code;
- describe temporary line numbers or file counts;
- imply that client validation is competitive authority;
- promise zero risk or perfect correctness.

When behavior changes, update the nearest durable comment and this guide only
if the architecture changed. Put release-specific facts and rollback evidence
in a focused batch document instead of allowing this guide to become a release
log.

## Verification and deployment boundaries

Use Node.js 22.23.1 and npm 11.17.0 through nvm. Run the smallest focused test
while developing, then the current inherited release gate from `AGENTS.md`, the
full build, diff checks, and clean-deploy-source verification before declaring
the change ready.

Codex prepares and reports deployment selectors but does not deploy Firebase
resources. A documentation-only change requires no Firebase deployment. A
browser-source change can require `hosting:app`; a server change requires only
the exact exported Functions that transitively changed. Never infer permission
to deploy Rules, indexes, TTLs, queue modes, migrations, or production data.
