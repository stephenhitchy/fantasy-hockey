# RinkRat Security Batch S3D — Firestore Identifier Boundaries

## Purpose

A Firestore document identifier is not just display text. Once inserted into an Admin SDK path, an unexpected slash, control character, reserved `__...__` name, oversized UTF-8 value, or malformed persisted cross-reference can change which document is addressed or cause repeated server failures.

S3D requires every externally supplied or persisted identifier to pass through one normalized policy before it becomes a path segment.

## Shared layers

```text
firestore-document-id-core.util.ts
  normalizeFirestoreDocumentId()
  isSafeFirestoreDocumentId()
  resolveSafeFirestoreDocumentId()

firestore-document-id.util.ts
  requireFirestoreDocumentId()          callable-safe HttpsError
  optionalFirestoreDocumentId()
  requireFirestoreDocumentIds()
  requireServerFirestoreDocumentId()    server/task/trigger Error

firestore-document-id-policies.ts
  semantic per-identifier constraints
```

The core resolver trims once, applies the requested case normalization, checks the UTF-8 byte ceiling, rejects `/`, control characters, `.`, `..`, and reserved `__...__` names, then applies the semantic pattern.

## Covered boundaries

The inventory at `config/firestore-document-id-boundaries.json` records 13 authority modules covering:

- Draft clock tasks, pick triggers, queue triggers, saved Draft owners, and Draft order;
- live-scoring tasks, historical replay requests, schedule/task IDs, and replay assets;
- projection-generation tasks, snapshot pointers, asset chunks, and canonical catalogs;
- profile-created and injury-status email triggers;
- authenticated feedback membership lookups;
- existing league lifecycle, roster, waiver, add/drop, profile, and beta-operations callables.

## Static audit

Run:

```bash
npm run security:audit-firestore-ids
```

The audit fails when it finds direct path interpolation from:

```text
event.params
request.auth.uid
request.data
payload.*
```

It also checks that every Cloud Tasks module uses the resolver, every Firestore-trigger module consuming parameters uses the resolver, all semantic policies exist, and every inventory contract still contains its required guard.

## App Check boundary

S3D does not enable App Check enforcement. App Check remains in monitor mode until supported-browser workflows have enough verified production evidence. Identifier validation is required even after App Check enforcement because a valid application token does not make every supplied identifier trustworthy.

## Competitive preservation

S3D does not change:

- Production Scoring V3;
- Projection V11 mathematics or rankings;
- six-game roster-slot windows;
- seventh-game rollover;
- Draft order, clock, queue selection, or Auto-Draft strategy;
- add/drop, waivers, Injured Reserve, standings, or playoffs.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchs3d
```

## Deployment order

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3D Firestore identifier boundary closure"
firebase deploy --only hosting:app -m "Security S3D Release Candidate 22"
```

Do not deploy Firestore Rules or indexes for S3D.

## Post-deployment smoke test

1. Complete a manual Draft pick, queue change, and clock-expiration Auto-Draft.
2. Run one historical replay day and one manual score refresh.
3. Generate or verify one Projection V11 snapshot.
4. Complete one immediate add/drop, one scheduled move, and one lineup swap.
5. Trigger a disposable welcome email and inspect one injury-status transition.
6. Submit feedback with and without a valid league context.
7. Confirm malformed IDs return bounded errors and do not create nested documents.
8. Refresh Release Readiness and confirm Scoring V3, Projection V11, App Check monitor status, and queue Shadow mode remain correct.

## Rollback

Keep the approved B1D/S4A package available. A full application rollback uses the previously approved Functions first and Hosting second. No data migration is needed because S3D only rejects malformed identifiers; it does not rewrite valid document IDs or competitive records.
