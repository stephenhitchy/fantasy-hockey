# RinkRat Security Batch S3E.1.1

## Draft Preparation Status Type Hotfix

### Purpose

S3E.1 moved Projection V11 preparation out of the Draft-settings request path. During the first dependency-backed Functions build, strict TypeScript correctly identified one optional-property narrowing problem in `functions/src/draft-automation.ts`.

The shared `FantasyDraft` model declares `projectionPreparationStatus` as an optional property:

```ts
projectionPreparationStatus?: 'ready' | 'queued' | 'processing' | 'error' | null;
```

Using the indexed property type directly in a cast therefore also includes `undefined`. The local automation variable intentionally accepts the four known statuses or `null`, but not `undefined`. The previous cast widened the observed request status back to the optional model type and caused `TS2322`.

### Correction

S3E.1.1 defines a concrete server status type that excludes both optional states:

```ts
type DraftProjectionPreparationStatus = Exclude<
  FantasyDraft['projectionPreparationStatus'],
  null | undefined
>;
```

A dedicated type guard accepts only:

```text
ready
queued
processing
error
```

The persisted request value is assigned only after that guard succeeds. The local variable remains explicitly:

```ts
DraftProjectionPreparationStatus | null
```

No broad cast is used, and `undefined` cannot enter the server update payload through this path.

### Runtime behavior is unchanged

This is a compile-time narrowing correction. It does not change:

- Draft scheduling or the saved Draft time
- Projection V11 generation
- `waiting-projection` behavior
- Automatic Draft opening
- Draft picks or Auto-Draft
- Injured Reserve activation
- Scoring V3
- Projection V11
- App Check monitor mode
- Scoring queue Shadow mode

### Verification

```bash
npm run verify:batchs3e-1-1
```

The Functions TypeScript build is the definitive confirmation that the original `TS2322` error is gone.

### Deployment

The failed deployment stopped before Functions were uploaded, so use the complete S3E.1 deployment sequence after verification:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3E.1.1 Draft preparation type hotfix"
firebase deploy --only hosting:app -m "Security S3E.1 RC23 Draft and IR hotfix"
```

No Firestore Rules, index, TTL, or backup deployment is required.
