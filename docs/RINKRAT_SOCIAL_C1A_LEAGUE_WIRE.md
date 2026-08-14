# RinkRat Social Batch C1A — League Wire

**Runtime:** Release Candidate 27
**Competitive models:** Production Scoring V3 · Projection V11
**Primary roadmap task:** C1.1 activity-feed foundation
**Deployment scope:** Firestore Rules, Cloud Functions, and Hosting
**Backfill:** None in C1A; the wire begins with events created after deployment

## Purpose

C1A adds the first intentionally bounded social-retention surface to League HQ: **League Wire**. It gives managers a compact, member-only record of recent public league outcomes without introducing full chat, another blocking dialog, a large dashboard module, or a second source of competitive truth.

The wire is a server-sanitized projection. Browsers never convert raw audit, Draft, or transaction documents into feed entries and cannot create, edit, or delete an activity record. This keeps private waiver intent, queued roster plans, invite codes, request identifiers, commissioner reasons, and administrative internals out of the social surface.

## Manager experience

League HQ shows at most five recent items by default. Managers may expand the same inline card to see the bounded listener result; there is no modal, overlay, fuzzy backdrop, fixed panel, or sticky content.

The first release covers:

- league creation;
- a manager joining;
- a changed league name, emblem, or color presentation;
- saved Draft setup, including the resulting membership lock;
- completed Draft picks;
- immediate add/drop and open-slot additions;
- completed IR moves and activations;
- public drops to waivers;
- awarded or cleared waivers;
- queued slot changes only after they actually activate;
- completed active/bench swaps.

Each item uses the manager's league team name and profile icon when available, a plain-language headline, a short timing explanation, and a relative timestamp. Internal `Cycle N` timing labels are presented to managers as `Matchup N`.

## Privacy and authority contract

C1A deliberately excludes:

- pending waiver claims;
- losing claimants and waiver priority details;
- queued add/drop plans before activation;
- queued active/bench swaps before activation;
- canceled queued moves;
- invite codes;
- request IDs and submission IDs;
- source document IDs;
- commissioner free-text reasons and arbitrary source timing labels;
- raw audit values, previous values, or new values;
- administrative migrations, repair actions, and platform operations;
- email addresses, IP addresses, App Check evidence, and support data.

A queued waiver award is public only after server adjudication has selected the winner. If the winning asset must wait for a roster-slot boundary, the wire may publish the award with its effective Matchup while the existing immutable window remains authoritative.

C1A does not change the visibility contract of older raw transaction documents. Restricting those documents behind owner-specific and public projections is tracked as a separate P0 privacy-hardening item so that it can be designed and tested without silently changing existing manager workflows.

## Server projection

Three create-only Firestore triggers observe existing server-owned records:

```text
leagues/{leagueId}/audit/{auditId}
leagues/{leagueId}/draft/current/picks/{pickId}
leagues/{leagueId}/transactions/{transactionId}
```

Approved events are written to:

```text
leagues/{leagueId}/activity/{activityId}
```

The activity ID is a deterministic SHA-256 fingerprint of the source kind and source document ID. The raw source ID is not copied into the public projection. Trigger retries are safe because each trigger writes through one Firestore transaction and returns without mutation when the deterministic activity document already exists.

Every activity record contains only an allowlisted schema:

- schema version;
- category and public event type;
- public team owner ID when relevant;
- bounded asset display summaries;
- Draft pick, round, and selection type when relevant;
- allowlisted Matchup, playoff-window, or slot-boundary timing when relevant;
- source-kind fingerprint;
- occurrence and publication timestamps;
- explicit server authority and release labels.

## Firestore access

League members may read activity records. Browsers cannot write them:

```text
match /leagues/{leagueId}/activity/{activityId}
  read: league members only
  create/update/delete: denied
```

The client listener is ordered by `occurredAt` descending and limited to 40 documents. No composite index is required.

## Competitive invariants preserved

C1A does not modify:

- Scoring V3;
- Projection V11;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft authority, timers, queues, or Auto-Draft;
- roster, waiver, lineup, and IR authority;
- historical replay or live-scoring authority;
- scoring queue Shadow mode;
- App Check Monitor mode or the exact-league/callable canary controls;
- shared NHL cache Shadow mode or authoritative-read setting;
- Firestore TTL, PITR, backup schedules, or indexes.

League Wire is a read-only social projection of completed public outcomes. It never drives a competitive action.

## Verification

Use the exact release toolchain:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci
npm run verify:batchc1a
```

## C1A.1 verification correction

C1A.1 does not change RC27 runtime behavior or deployment scope. It registers the new League Wire template in the existing design-system migration allowlist and removes C1A-introduced Markdown trailing whitespace so the inherited verification chain can complete cleanly.


## C1A.2 integrity-baseline correction

C1A.2 also leaves RC27 runtime behavior and deployment scope unchanged. The League Wire member-read/server-write-only rule was already covered by the passing Firestore emulator suite, but older executable regression tests still embedded the pre-C1A Rules hash. C1A.2 advances the active protected-source fixture to the approved C1A Rules hash and routes executable integrity checks through that single active source-controlled Firestore Rules hash baseline. Historical release snapshot fixtures remain historical.

Older whole-Functions-tree guards also needed to recognize that C1A intentionally adds only `functions/src/league-activity.ts` and `functions/src/shared/core/league/league-activity.util.ts`. Those two paths are now explicit exclusions while every unrelated Function remains protected by its prior digest. Inherited README release-family allowlists now recognize `Social Batch C1A` as well.

The C1A suite verifies that the current Rules file matches the active fixture, executable `.mjs` tests do not duplicate either the current hash or the historical D1C hash, every active Functions-tree guard accounts for the two isolated projection files, and inherited release-family checks cannot stop at D1B.

Focused verification covers:

- deterministic activity IDs that do not reveal source IDs;
- audit, Draft, and transaction allowlists;
- waiver and queued-action privacy exclusions;
- bounded asset sanitization;
- create-only, retry-safe Function triggers;
- member-only and server-write-only Firestore Rules;
- the 40-document listener and five-item default view;
- absence of dialogs, overlays, fixed content, and sticky content;
- RC27, Scoring V3, Projection V11, Monitor, and both Shadow modes.

## D1C operational prerequisite

The previous handoff did not confirm that D1C was deployed or that the tenth TTL policy became active. Because C1A includes the complete Functions source tree, deploying C1A before that proof would also deploy the D1C server code.

Before the C1A release, confirm:

```bash
npm run security:inspect-ttl -- \
  --project=nhl-fantasy-app-ab673
```

The required result is:

```text
TTL baseline passed: 10/10 expected policies are ACTIVE.
```

When the tenth policy is missing, apply the guarded baseline once and inspect again:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673

npm run security:inspect-ttl -- \
  --project=nhl-fantasy-app-ab673
```

Keep the shared NHL cache in Shadow with authoritative reads disabled.

## Deployment

C1A requires the member-only activity rule, the three server triggers, and the RC27 League HQ interface:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy \
  --only firestore:rules,functions,hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1A League Wire Release Candidate 27"
```

Do not deploy Firestore indexes. Do not promote App Check, the scoring queue, or the shared NHL cache.

## Production smoke test

Existing leagues are not backfilled in C1A. Use one disposable Internal Test league and create new events after deployment:

1. Change a league presentation field or save Draft settings. Confirm one League item appears; saving Draft settings must not create a second duplicate membership-lock item.
2. Complete one Draft pick. Confirm the team, asset, pick number, and selection context appear.
3. Complete one immediate roster move. Confirm the public outcome appears.
4. Submit a pending waiver claim. Confirm it does **not** appear.
5. Process that waiver. Confirm only the award or clear outcome appears.
6. Queue an add/drop or active/bench swap. Confirm it does **not** appear before the boundary.
7. Activate the queued move through the normal server workflow. Confirm the completed activation appears once.
8. Sign in as another league member and confirm the same public items are readable.
9. Sign out or use a non-member account and confirm the activity collection is not readable.
10. Confirm League HQ remains usable while the listener loads or fails.
11. Confirm the release manifest reports RC27, Scoring V3, and Projection V11.
12. Confirm App Check remains Monitor, scoring remains Shadow, and shared NHL cache authoritative reads remain disabled.

Inspect the new trigger logs when needed:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueAuditActivity,publishLeagueDraftPickActivity,publishLeagueTransactionActivity
```

## Rollback

1. Check out the last known-good revision.
2. Restore the exact pinned dependencies and run that revision's verification command.
3. Redeploy Firestore Rules, the complete Functions codebase, and Hosting from the known-good revision.
4. Leave existing activity documents in place. An older client ignores them, and they cannot change competitive state.
5. Confirm Scoring V3, Projection V11, Monitor, scoring Shadow, and shared-cache Shadow remain unchanged.

Do not delete league, Draft, roster, waiver, score, audit, or recovery data as part of a League Wire rollback.

## Deliberate follow-on work

C1A is the activity-feed foundation, not completion of the full social phase. Later batches should be driven by beta evidence and may add scoring milestones, matchup results, playoff advancement, fuller commissioner-action coverage, recaps, reactions, notification controls, retention, and moderation. Full chat remains deferred until activity-feed usage and abuse controls justify it.

## Social Batch C1B follow-up

Release Candidate 28 completes the P0 privacy boundary discovered during C1A. Canonical league-wide `transactions` and `waivers` are now server-only; managers read only their own private transaction and claim projections, while members read a claim-free waiver pool and allowlisted completed outcomes. League Wire behavior remains unchanged. See `RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md` for migration and deployment order.
