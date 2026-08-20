# Operations Batch O1E.2 — Matchup Date Time-Zone Hotfix

**Runtime release:** Release Candidate 55
**Competitive models:** Production Scoring V4 · Projection V11

## Defect

The League Dashboard matchup card formats the latest scheduled starter-game date as `Finalizes Mon DD`. The NHL schedule source provides a canonical calendar date, but the original formatter inherited the machine time zone. On a Pacific-time Mac, `2026-08-24T02:00:00Z` rendered as `Aug 23`, while the UTC packaging environment rendered `Aug 24`.

This made the O1A.2 test environment-dependent and could show managers a date one day earlier than the schedule date.

## Correction

`formatMonthDay()` now specifies `timeZone: 'UTC'`. The date label therefore preserves the NHL calendar date consistently across local Mac development, GitHub Actions, Firebase builds, and production browsers.

The window-selection logic is unchanged: active matchups still use the latest remaining scheduled starter game across both teams, and completed matchups still prefer the recorded completion date when available.

## Regression coverage

The existing O1A.2 suite now runs four checks, including an explicit `America/Los_Angeles` test that proves an Aug 24 calendar date does not shift to Aug 23. The suite remains inherited by `npm run verify:batcho1e`.

## Deployment boundary

O1E.2 changes one browser utility and tests/documentation only. It adds no Function, Rule, index, TTL policy, migration, scoring change, projection change, or competitive write. If RC55 Hosting has not yet deployed because verification stopped, deploy the corrected RC55 Hosting after the complete O1E verification passes. No Functions redeployment is required solely for this hotfix.
