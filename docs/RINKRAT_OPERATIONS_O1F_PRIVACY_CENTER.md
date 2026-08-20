# Operations Batch O1F — Privacy Center and Request Operations

**Runtime release:** Release Candidate 56
**Competitive models:** Production Scoring V4 · Projection V11
**Deployment:** Targeted Functions first, then Hosting
**Firestore Rules/indexes/TTL deployment:** None

## Purpose

O1F gives a signed-in manager one clear place to download an immediate account-data package, review retention, submit a privacy request, follow up when RinkRat needs more information, and see the request history. It also gives the platform administrator a separate audited request-operations surface.

This is a private-beta operational workflow. It does not claim that the current public Privacy or Terms text has completed jurisdiction-specific attorney review.

## Manager Privacy Center

Route:

```text
/privacy-center
```

The manager may:

- download a bounded JSON package after recent password verification;
- review export-audit metadata;
- submit Additional Data Access, Correction, Deletion Support, or Privacy Question requests;
- respond when a request is waiting for the manager;
- cancel a nonterminal request;
- review manager-visible timeline entries and retention descriptions;
- open the public Privacy notice or permanent account-deletion workflow.

The immediate export includes the account/private profile, public profile, authentication metadata, league membership/team summaries, watchlist, player notes, linked feedback and client diagnostics, private-season research and engagement evidence, privacy-request history, retention schedule, and deletion behavior.

The export excludes passwords, authentication/App Check tokens, secrets, raw server logs, other managers’ private data, and raw sports-provider payloads. RinkRat stores export metadata and a SHA-256 package hash, not a server copy of the JSON download.

## Recent authentication

Creating, responding to, cancelling, or exporting requires:

- an authenticated account;
- verified email;
- recent authentication inside the existing 15-minute security window;
- the exact deployed RC56 / Scoring V4 / Projection V11 build.

The Privacy Center keeps password verification inline. It adds no modal or fuzzy backdrop.

## Platform-administrator operations

Route:

```text
/admin/privacy-requests
```

The administrator may:

- filter by status and request type;
- search by privacy-limited owner reference, request reference, subject, or manager-visible text;
- move a request through valid statuses;
- publish a manager-visible response;
- maintain a separate private operations note;
- record a required audit reason;
- review export metadata without accessing a stored export package.

Every update uses optimistic revision checks and writes an immutable subcollection audit. Terminal requests cannot be reopened or rewritten.

## Request states

```text
Submitted
In Review
Waiting for Manager
Completed
Declined
Cancelled
```

The private-beta response target is 30 days. The application explicitly labels that target as an internal operating target rather than a universal statutory deadline.

## Retention and cleanup

```text
Privacy request operations: up to 730 days
Data-export audit metadata: up to 365 days
```

Both records carry `expiresAt` and are registered in the existing daily `cleanupExpiredSecurityData` fallback. Expired privacy requests are removed recursively so their immutable `changes` subcollection cannot outlive the parent request. They do not add new Firestore TTL field overrides; the approved production TTL policy count remains 10.

## Account deletion

Permanent account deletion:

- removes manager request text and direct account linkage;
- cancels a nonterminal request;
- preserves a limited pseudonymous operations record until expiration;
- pseudonymizes manager-linked immutable request changes;
- pseudonymizes every linked export-audit record, including accounts with more than one cleanup page;
- preserves anonymous league competition history when needed so other managers’ completed results are not rewritten.

## Security and privacy boundaries

O1F adds no browser Firestore write. All data access, export preparation, request changes, administrator changes, retention cleanup, and account-deletion reconciliation run through server authority.

The administrator dashboard does not display email addresses, phone numbers, or raw account IDs. The pseudonymous owner reference is not a public identifier.

## Verification

```bash
npm run verify:batcho1f
```

The verification chain includes:

- inherited RC55/O1E verification;
- privacy utility and authority tests;
- manager/admin route and mobile-surface tests;
- account-deletion pseudonymization checks;
- retention-policy and cleanup registration checks;
- Firestore identifier-boundary audit;
- protected scoring/projection/Rules/index comparison;
- release-manifest validation.

## Deployment

Deploy the new manager callables first:

```bash
firebase deploy \
  --only functions:getMyPrivacyCenter,functions:manageMyPrivacyRequest,functions:getMyPrivacyExport \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1F manager privacy authority"
```

Deploy the administrator callables:

```bash
firebase deploy \
  --only functions:getPrivacyRequestOperations,functions:updatePrivacyRequestOperation \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1F privacy request operations"
```

Update cleanup and deletion authority:

```bash
firebase deploy \
  --only functions:cleanupExpiredSecurityData,functions:deleteMyAccount \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1F privacy retention and account deletion"
```

Then deploy RC56 Hosting after the maintained O1B–O1E exact-build callables have been updated to RC56.

## Live smoke test

1. Open `/privacy-center` as a verified password account.
2. Confirm requests and retention load without password step-up.
3. Confirm protected actions remain disabled until the password is re-entered.
4. Download one JSON export and verify it opens locally.
5. Confirm the file contains only the signed-in manager’s account data.
6. Submit a disposable Privacy Question.
7. Open `/admin/privacy-requests` as the platform administrator.
8. Move the request to Waiting for Manager with a public response and private note.
9. Return as the manager, send a follow-up, then complete the request as administrator.
10. Confirm no private operations note is visible to the manager.
11. Confirm no modal, fixed panel, fuzzy backdrop, or horizontal scrolling appears on mobile.

O1F is complete when the export, request lifecycle, account-deletion pseudonymization, and scheduled cleanup evidence work without exposing another manager’s data or changing competition state.
