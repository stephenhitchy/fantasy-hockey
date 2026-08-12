# RinkRat Data Quality Batch D1A.1

## Live-scoring timestamp TypeScript hotfix

Date: 2026-08-12  
Release family: Release Candidate 25  
Competitive models: Scoring V3 and Projection V11

## Build failure

The Angular TypeScript 6 build stopped with `TS2352` in:

```text
src/app/core/live-scoring/live-scoring-freshness.util.ts
```

The timestamp helper first proved only that an unknown object had a numeric `seconds` property. It then separately asserted that the same value had the required shape:

```ts
{ nanoseconds: number }
```

TypeScript correctly warned that the narrowed `seconds` object did not necessarily contain a required `nanoseconds` field. Firestore timestamp-like values may also omit `nanoseconds`, so the required-property assertion was unnecessarily strong.

## Correction

D1A.1 narrows the unknown value once through:

```ts
function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown>
```

The helper then reads `toMillis`, `seconds`, and `nanoseconds` as independent unknown fields and validates each value before using it.

```ts
const seconds = value['seconds'];
const rawNanoseconds = value['nanoseconds'];
```

A missing or nonnumeric `nanoseconds` value safely defaults to zero. A nonnumeric `seconds` value is rejected. The old overlapping assertions are removed.

## Runtime behavior is unchanged

D1A.1 does not change:

- the score-freshness labels or status thresholds;
- Last checked, Last score change, or Next check meaning;
- Production Scoring V3;
- Projection V11;
- live-scoring cadence or queue routing;
- Draft, roster, waiver, or Injured Reserve behavior;
- App Check monitor/canary controls;
- Firestore Rules, indexes, TTL, PITR, or backup schedules.

The human-facing release remains Release Candidate 25. A new production build will still receive a new exact build identifier, as expected.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci
npm run verify:batchd1a-1
```

The Angular build should now progress beyond the prior `live-scoring-freshness.util.ts:74` error.

## Deployment

The original D1A deployment stopped during the Angular build. After verification and a clean commit, rebuild and deploy Hosting only:

```bash
npm run build:all
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app \
  -m "Data D1A.1 RC25 timestamp type hotfix"
```

No Functions, Firestore Rules, indexes, TTL, PITR, or backup deployment is required.
