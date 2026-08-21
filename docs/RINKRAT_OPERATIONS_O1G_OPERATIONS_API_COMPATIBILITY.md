# Operations Batch O1G — Versioned Operations API Compatibility

**Runtime release:** Release Candidate 57
**Competitive models:** Production Scoring V4 and Projection V11
**Operations API contract:** v1

## Why this batch exists

O1B–O1F originally protected their callable Functions with an exact Release Candidate label and exact build-ID pattern. That was intentionally conservative while the private-season operations system was being introduced, but it meant every browser release required redeploying the same private-season, incident, research, and privacy Functions even when their request/response contract had not changed.

O1G replaces that release-label coupling with one explicit operations API contract.

A compatible operations client must provide:

```text
operationsApiVersion: 1
Release Candidate 56 or newer
Matching release label and build-ID candidate number
Production Scoring V4
Projection V11
```

During the one-time transition, an already-open deployed RC56 client that predates the explicit `operationsApiVersion` field is treated as legacy contract v1. Versionless RC57-or-newer clients still fail closed. The server continues rejecting malformed, pre-contract, mismatched scoring/projection, and incompatible-contract clients.

## What the release identity does and does not prove

The release label and build ID are compatibility and audit metadata, not an authentication credential. User ownership, verified email, recent authentication, tracked-league membership, and platform-administrator authority remain server-derived and cannot be gained by changing browser metadata.

## What remains exact-build protected

The Private Season Control Center still freezes and approves one exact release and one exact build. An RC57 browser can read an RC56-approved plan, but the old decision does not silently become approval for RC57. The exact release and build must still match the frozen plan revision before the approval is current.

App Check canary evidence also remains exact-build evidence. O1G does not widen security-canary approval.

## Local build behavior

Compatible local builds may read operations pages for development and inspection. Operations that create or change formal evidence remain blocked until the deployed production site is used.

Examples of protected writes include:

- changing or approving the private-season plan;
- recording weekly health evidence;
- creating or updating incidents;
- submitting formal tester research;
- creating privacy requests or exports;
- changing privacy-request status.

## Deployment rule after O1G

### Hosting-only release

When a later release changes only browser templates, styling, client-side presentation, static documentation, or other Hosting assets—and operations API v1, Scoring V4, and Projection V11 remain unchanged—deploy only:

```bash
firebase deploy --only hosting:app
```

The O1B–O1F Functions do not need another release-label update.

### Targeted Function change

When one Function implementation or its request/response schema changes, deploy only that new or changed Function and any directly coupled function listed in the release instructions.

### Operations contract change

When `operationsApiVersion` changes, redeploy every affected operations Function before deploying the browser that sends the new version.

### Scoring or projection version change

When the operational tools intentionally move to a new scoring or projection version, redeploy the affected operations Functions and preserve versioned league/history behavior.

### Shared competitive Function change

When shared scoring, projection, Draft, cycle, roster, or transaction code changes across a broad Functions tree, use the deliberate full or grouped deployment required by that release rather than assuming Hosting-only is safe.

## Source-controlled contract

The policy is stored at:

```text
config/operations-api-compatibility.json
```

The client identity is built by:

```text
src/app/core/operations/operations-client-compatibility.ts
```

The server validates it through:

```text
functions/src/shared/core/operations/operations-client-compatibility.util.ts
```

The verification audit is:

```bash
npm run operations:audit-compatibility
```

The full release gate is:

```bash
npm run verify:batcho1g
```

## O1G deployment

O1G itself requires one final compatibility rollout of the maintained O1B–O1F Functions because their current deployed revisions still contain exact RC56 checks. After that rollout, compatible browser-only releases no longer need those repeated Function updates.

O1G changes no score, projection, Draft, roster, waiver, transaction, standings, playoff, six-game window, seventh-game rollover, Firestore Rule, index, TTL policy, App Check mode, scoring-queue mode, or NHL-cache authority.
