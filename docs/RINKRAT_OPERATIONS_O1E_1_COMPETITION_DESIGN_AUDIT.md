# Operations Batch O1E.1 — Current Competition Design Audit Hotfix

**Runtime release:** Release Candidate 55
**Competitive models:** Production Scoring V4 · Projection V11
**Deployment:** None. Source-control and GitHub verification only.

## Diagnosis

The GitHub `RinkRat security and release verification` workflow failed inside:

```text
npm run audit:competition-design-migration
```

The unified Add / Drop page was not the defect. The repeatable audit still expected the older pre-A1C Free Agents implementation from Batch 7C.3:

```text
rr-toolbar
rr-list-row
replacement-player-card
--rr-free-agents-migration-color-
```

A1C intentionally replaced that page with the unified Player Board/Add-Drop route. The current implementation composes the reviewed shared system through:

```text
rr-page-shell
rr-card / rr-card--padded
rr-field
rr-select
rr-button
rr-notice
rr-state
```

It also keeps the incoming player, valid roster choices, and confirmation inside the same page rather than restoring the retired action sheet or dialog.

## Evidence that the current page is valid

Before changing the audit, the current source already passed:

```text
npm run test:competition-design-migration:run
npm run audit:design-system
npm run test:design-system:run
npm run audit:mobile-readability
npm run audit:accessibility
```

The current Free Agents/Add-Drop stylesheet contains:

```text
8 literal colors
0 !important declarations
0 retired Free Agents migration aliases
```

The eight literals are the compact, numbered six-game marker colors. The former Batch 7C.3 budget allowed 168 literals and eight important declarations, so the reviewed successor has substantially lower local design debt.

## Corrective change

O1E.1 does not add old classes back to the page.

Instead it:

1. Adds `scripts/competition-design-migration.expectations.mjs` as the shared current-surface contract.
2. Makes `audit-competition-design-migration.mjs` import that contract.
3. Makes the competition-design regression test import the same contract.
4. Preserves an independent assertion that Unified Add / Drop must use the current Player Board layout and must not restore the old replacement card, action sheet, dialog backdrop, or viewport overlay.
5. Tightens `freeAgentsCssLiteralColors` from `168` to `8`.
6. Tightens the Add / Drop important-declaration allowance from `8` to `0` through the shared expectation.
7. Runs `audit:competition-design-migration` explicitly near the end of `verify:batcho1e:core`, which is the command used by GitHub `security:ci`.

## Protected behavior

O1E.1 changes no runtime application surface and no production authority. It does not modify:

- Unified Add / Drop or Player Board markup.
- Add, Drop, Claim, Watchlist, Decision History, Roster Fit, or Player Intel behavior.
- Production Scoring V4 or legacy V3 reconstruction.
- Projection V11.
- Six-game roster-slot windows or seventh-game rollover.
- Draft, roster, waiver, transaction, scoring, standings, or playoff authority.
- Firestore Rules, indexes, or TTL policies.
- App Check Monitor, scoring queue Shadow, or shared NHL-cache Shadow.

## Verification

```bash
npm run audit:competition-design-migration
npm run test:competition-design-migration:run
npm run verify:batcho1e
```

The complete RC55 verification is unchanged at the operator level. The command now explicitly reruns the corrected audit near the end, and the GitHub workflow continues to call `npm run security:ci`.

## Deployment

No Firebase deployment is necessary because no runtime source, Function, Hosting asset, Rule, index, or data model changed.

Commit and push the source correction so GitHub reruns the security and release verification workflow.
