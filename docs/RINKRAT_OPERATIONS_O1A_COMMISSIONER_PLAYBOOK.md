# Operations Batch O1A.1 — Commissioner Playbook

**Runtime release:** Release Candidate 51

**Competitive models:** Production Scoring V4 and Projection V11

**Primary surfaces:** League HQ → Commissioner Playbook; public Support → Commissioner Guide

## Purpose

O1A reduces founder-only league operation before the 2026–27 tester season. It gives commissioners one league-specific preparation surface and gives prospective or signed-out commissioners one public reference they can read before creating a league.

The implementation follows the launch plan’s commissioner-first principle: a commissioner is the highest-leverage acquisition and retention unit because one prepared commissioner can activate a complete league. O1A does not claim that commissioner independence is proven; that still requires an observed non-founder commissioner to create, fill, Draft, and operate a real league.

## League-specific readiness

Only the current league commissioner may open:

```text
/leagues/{leagueId}/commissioner
```

The readiness summary checks existing authoritative or member-readable state:

1. Commissioner email verification.
2. Intended manager count versus league capacity.
3. Saved Round 1 Draft order containing every current team.
4. Saved Draft date and time.
5. A healthy Projection V11 board matching the league’s Scoring V3 or V4 identity.

The page reports `ready`, `attention`, or `blocked` and links to the existing setup surface responsible for the missing evidence. It does not write competition data, approve the Draft automatically, regenerate projections, or bypass any authority control.

A live or completed Draft continues using its frozen verified board. The playbook does not reinterpret or rewrite an active competition.

## Commissioner copy tools

The playbook generates plain-text copy for:

- Initial manager invitations.
- Draft-night reminders.

The invitation includes the league name, invite code, current team count, Draft time when available, the six-NHL-game rule, seventh-game rollover, and a prompt to verify sign-in before Draft night.

The Draft reminder tells managers to arrive early, review their Queue, and avoid resubmitting a pick while the server is confirming it.

No message is sent automatically. The commissioner chooses whether and where to paste it.

## Draft-night checklist

The six-item checklist covers:

- Successful sign-in for every manager.
- Shared Draft time.
- Queue and Auto-Draft understanding.
- A commissioner backup device.
- A deputy communicator.
- Easy access to Known Issues and Support.

Checklist state is device-local and stored only in that browser’s `localStorage` under the exact league ID. It is convenience state, not league authority, and it cannot block or change the Draft.

The page also supports ordinary browser printing.

## Recovery guidance

The playbook tells commissioners to:

- Avoid repeating an action while RinkRat is still confirming it.
- Check connection state before refreshing.
- Review Known Issues.
- Submit the exact expected and observed result.
- Never manually alter a score, roster, waiver outcome, or six-game window outside approved server tools.

This preserves the no-silent-score-edit and evidence-first incident approach required for the tester season.

## Public commissioner guide

The public route is:

```text
/commissioner-guide
```

It contains:

- A 30-second six-game explanation.
- Setup order.
- Printable Draft-night checklist.
- Weekly operating guidance.
- Competition-safe recovery steps.
- A concise FAQ.
- Links to Support, Known Issues, Terms, and Privacy.

The public page contains no private league data and requires no account.

## Mobile and information-density boundaries

O1A adds no Dashboard panel and no default League HQ card. The commissioner playbook remains inside the existing collapsed Commissioner Tools section.

Both pages:

- Use ordinary vertical scrolling.
- Have no modal or fuzzy backdrop.
- Have no fixed or sticky panel.
- Keep explanations task-specific.
- Use direct actions instead of duplicating the underlying setup forms.

## Data, authority, and performance

O1A adds:

```text
No Cloud Function
No permanent Firestore listener beyond existing Draft/team listeners on the commissioner-only page
No Firestore Rule
No Firestore index
No TTL policy
No migration
No scoring or roster write
```

The league-specific page uses the existing league, team, Draft, and projection metadata services. The public guide is static.

## Remaining O1.5 work

O1A substantially advances commissioner self-service, but O1.5 remains in progress until RinkRat also has:

- A public non-private demo league or matchup.
- Observed proof that a non-founder commissioner can create, fill, Draft, and operate a league without founder intervention.
- Evidence-backed revisions from commissioner interviews and Draft rehearsals.

## O1A.1 strict-TypeScript hotfix

The original O1A checklist normalizer built a `Set` from the six literal checklist IDs. TypeScript correctly inferred a narrow union for that set, while `Object.entries()` returns each stored object key as a general `string`. Passing that general string into the narrow set's `has()` method caused Angular compilation error TS2345 even though runtime behavior was safe.

O1A.1 declares the membership-only allowlist as:

```ts
ReadonlySet<string>
```

The six supported checklist IDs remain unchanged. Unknown local-storage keys still fail closed, only `true` values survive normalization, and no league, Draft, scoring, projection, Firestore, or deployment behavior changes.

## Verification

```bash
npm run verify:batcho1a
```

The O1A verification chain preserves the complete V4A scoring and operational checks, then adds commissioner-readiness, route, access-boundary, mobile-surface, documentation, and release-identity tests.

## Deployment

O1A is browser-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1A commissioner playbook Release Candidate 51"
```

Do not deploy Functions, Firestore Rules, indexes, TTL, App Check, scoring-queue mode, or NHL-cache authority for O1A.

## Site proof

Use one pre-Draft tester league and a non-founder commissioner account:

1. Confirm only the commissioner sees the League HQ playbook tile.
2. Open the playbook and verify all five readiness checks.
3. Copy the invitation and Draft reminder.
4. Complete and reset the device checklist.
5. Open every direct action.
6. Sign out and confirm the public guide remains readable.
7. Use a narrow phone viewport and confirm ordinary scrolling, no overlays, and practical touch targets.
8. Have the non-founder commissioner explain and rehearse the Draft without Stephen coaching each step.

The eighth step is product evidence, not an automated completion claim.
