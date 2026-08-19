# Operations Batch O1B — Private Season Control Center

**Runtime release:** Release Candidate 52
**Competitive models:** Production Scoring V4 and Projection V11
**Deployment:** Functions first, then Hosting
**Firestore Rules/indexes/TTL:** unchanged

## Purpose

O1B operationalizes the first two dated launch tasks in the Public Launch & Growth Gameplan: freeze the exact 2026–27 proof cohort and track a diverse tester matrix before the September 27 private-season go/no-go decision.

The platform-admin route is:

```text
/admin/private-season
```

It is linked from the existing Beta Operations Center and guarded by `platformAdminGuard` plus server-side platform-administrator validation.

## Privacy boundary

The control center stores only privacy-limited tester aliases or initials. It deliberately has no field for:

- email address;
- phone number;
- street address;
- date of birth;
- private league message history;
- roster, score, transaction, or waiver content.

Actual contact details remain in the operator's approved external contact system. The app records only whether the contact path and beta consent have been confirmed.

## Plan contents

The server-owned plan records:

- 2–4 exact production tester league IDs;
- at least six expected and tracked managers per league;
- Draft rehearsal completion;
- 10–30 unique tester aliases;
- one-or-more league assignments;
- commissioner or manager role;
- founder versus non-founder commissioner status;
- hockey-expert, casual-fan, or fantasy-beginner coverage;
- iPhone, Android, and desktop coverage;
- contact, consent, account, and Draft-rehearsal confirmation;
- exact release label and build ID;
- tester-season non-goals;
- support channel, Known Issues, rollback, deputy, and coverage readiness.

The server reads the exact stored league IDs to verify that each league exists, count its current teams, and report Draft status/order evidence. It does not alter those leagues.

## Gate behavior

The private season cannot be approved until the control center verifies:

```text
2–4 active tester leagues
10–30 unique tester aliases
At least one non-founder commissioner
Hockey expert coverage
Casual fan coverage
Fantasy beginner coverage
iPhone coverage
Android coverage
Desktop coverage
Every tester assigned to at least one active league
At least six tracked aliases assigned to each active league
No duplicate production league IDs or tester aliases
Contact, consent, and account readiness
Expected managers present in each exact league
Full Draft rehearsal for every planned league
Support channel and Known Issues readiness
Exact-release rollback rehearsal
Confirmed deputy communicator
Confirmed Draft-week/first-week coverage
Exact RC52 / Scoring V4 / Projection V11 build freeze
```

The tool does not automatically approve the season. A delayed decision may be recorded with stop-the-line items still open; an approved decision cannot.

## Authority and audit

The browser never writes the plan directly to Firestore.

Callables:

```text
getPrivateSeasonControlCenter
updatePrivateSeasonPlan
recordPrivateSeasonGateDecision
```

Plan changes and decisions require platform-administrator authority. Writes also require verified email and recent authentication.

The canonical document is:

```text
platformOperations/privateSeason2026-27
```

Every update writes an immutable change record. Every approved or delayed decision writes an immutable decision record containing:

- exact release and build ID;
- plan revision;
- decision reason;
- actor;
- timestamp;
- blocker/advisory counts;
- SHA-256 hash of the decided plan.

Editing the plan after an approval invalidates the visible current-decision match until another explicit decision is recorded.

## Competition boundary

O1B does not change or promote:

- Production Scoring V4;
- Projection V11;
- legacy V3 reconstruction;
- six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, scoring, waiver, or transaction authority;
- App Check Monitor;
- exact-league/callable canary controls;
- scoring queue Shadow mode;
- shared NHL-cache Shadow mode.

## Verification

```bash
npm run verify:batcho1b
```

The focused suite covers normalization, cohort bounds, diversity gates, exact-build freeze, approval blocking, immutable audit source, admin route protection, mobile layout, and protected-system retention.

## Deployment

O1B adds three Functions and one browser route.

```bash
firebase deploy \
  --only functions:getPrivateSeasonControlCenter,functions:updatePrivateSeasonPlan,functions:recordPrivateSeasonGateDecision \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1B private season authority"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1B Private Season Control Center Release Candidate 52"
```

Do not deploy Rules, indexes, TTL policies, App Check settings, scoring-queue configuration, or NHL-cache authority.

## Site proof

1. Open Admin Center, then **Private Season**.
2. Confirm the route is denied to an ordinary manager.
3. Add two exact disposable tester league IDs.
4. Add enough privacy-limited aliases to cover each league’s expected managers (12 for two six-team leagues), all required experience/device groups, and one non-founder commissioner.
5. Confirm live team/Draft evidence refreshes without changing the league.
6. Freeze the current build and record non-goals.
7. Complete support, rollback, deputy, and coverage checks.
8. Save with a reason after recent-auth step-up.
9. Confirm approval remains disabled while a blocker exists.
10. Resolve blockers and record an approved decision.
11. Edit the plan again and confirm the prior approval no longer counts as current.
12. Record the actual September 27 approved or delayed decision only after the real rehearsal evidence exists.
