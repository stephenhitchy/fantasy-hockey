# RinkRat Social Batch C1B — Transaction and Waiver Privacy

**Runtime:** Release Candidate 28
**Competitive models:** Production Scoring V3 and Projection V11
**Primary purpose:** complete roadmap item C1.14 by removing every browser dependency on league-wide raw transaction and waiver records.
**Verification maintenance:** C1B.1 fixes the Rules-emulator denial harness only; RC28 runtime and Rules behavior are unchanged.

## Why this batch exists

League Wire already excludes pending waiver claims, queued roster plans, cancellations, request identifiers, and administrative details. The inherited Firestore model still allowed every league member to read the canonical `transactions` and `waivers` collections, however. Filtering those records by owner inside Angular was not a privacy boundary: a modified client could read all claimants, waiver priority at claim, roster targets, and queued-operation identifiers.

C1B keeps the canonical server model intact for adjudication and automation, then publishes purpose-built browser projections with the smallest useful field set.

## Data boundary

Canonical server-only sources:

```text
leagues/{leagueId}/transactions/{transactionId}
leagues/{leagueId}/waivers/{waiverId}
```

Browser projections:

```text
leagues/{leagueId}/members/{ownerId}/transactions/{hashedTransactionId}
leagues/{leagueId}/members/{ownerId}/waiverClaims/{waiverId}
leagues/{leagueId}/transactionResults/{hashedTransactionId}
leagues/{leagueId}/waiverPool/{waiverId}
```

The owner-private transaction ledger may include that manager's own roster target and queued-operation context because no other manager or commissioner can read it from the browser. The public result and waiver-pool projections never include claim arrays, claimant counts, waiver priority at claim, roster target IDs, request/submission IDs, reasons, or raw source-document IDs.

## Server publishers

`publishLeagueTransactionActivity` remains the create-only observer for canonical transactions. C1B extends it to publish:

- an owner-private transaction record when the source belongs to a manager;
- a member-public completed result only for the same allowlisted completed outcomes used by League Wire;
- deterministic SHA-256-derived document IDs and source fingerprints, never the raw source ID.

`publishLeagueWaiverPrivacy` observes canonical waiver creates, updates, and deletes. It publishes:

- one claim-free public waiver record;
- one private record per claimant containing only that claimant's own move and derived status;
- deletes for claim projections removed from the canonical document;
- cleanup of the public and private projections when a canonical waiver is deleted.

Both publishers use Admin SDK authority and retry-safe deterministic paths. They do not alter canonical waiver adjudication, roster mutation, priority ordering, six-game timing, scoring, or projections.

## Browser behavior

Free Agents listens to the public waiver pool and the signed-in manager's pending claim records. The UI can show **Your claim is private** or **Review Your Claim**, but it cannot show how many claims exist or identify another claimant.

The public waiver card resolves the full player or Team Goalie Unit display data from the already-authoritative shared Projection V11 pool. The public Firestore projection therefore remains small while the decision surface retains its normal season points, next-six-games projection, availability, and comparison detail.

The commissioner still processes waivers through `executeSecureRosterAction`. Success text is based on the server response (`cleared`, `queued`, or applied), not a browser-visible claim count.

Team Settings reads only `members/{ownerId}/transactions`. Other managers and commissioners cannot read that private ledger from the browser.

## Firestore Rules

Final RC28 Rules deny every browser read of canonical `transactions` and `waivers` while exposing only purpose-built projections. They enforce:

- raw `transactions`: no browser reads or writes;
- raw `waivers`: no browser reads or writes;
- owner-private transactions: only the signed-in owner may read;
- owner-private claims: only the signed-in owner may read;
- public completed results: league members may read;
- public waiver pool: league members may read;
- all projection writes: denied to every browser, including commissioners.

The Admin SDK remains unaffected by Rules and continues to own competitive writes.

## Existing-league migration

Existing canonical records do not retrigger automatically. C1B includes a guarded projection backfill plus a read-only inspector:

```bash
npm run social:backfill-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673

RINKRAT_APPLY_TRANSACTION_PRIVACY=APPLY \
npm run social:backfill-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673

npm run social:inspect-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673
```

Add `--league=EXACT_INTERNAL_TEST_LEAGUE_ID` to limit any command to one league.

The first command is a dry run. The apply command writes only projections; it never modifies raw transactions, raw waivers, leagues, rosters, scores, standings, priority, or release controls. Projection writes replace the complete sanitized document rather than merging into unknown prior fields. The inspector is read-only and fails when projections are missing, stale, malformed, owner-mismatched, or contain forbidden public/private fields.

## Deployment order

After manually replacing the package, restore the repository-tracked official NHL logo cache before checking the working tree. The cache is intentionally regenerated outside the source package, and restoring it prevents Git from interpreting the omitted generated SVGs as C1B deletions:

```bash
git restore -- public/assets/team-identity-logos
```

The order is mandatory because Firebase does not make a Rules/Hosting release one atomic browser cutover. RC27 still reads the raw collections, while RC28 reads only the projections. C1B therefore includes an audited temporary Rules bridge that supports both clients without changing write authority.

1. Verify the complete source with `npm run verify:batchc1b`.
2. Commit and push the exact verified revision.
3. Confirm 10/10 TTL policies remain ACTIVE and all safety modes remain unchanged.
4. Deploy **Functions only** so future canonical writes create projections while RC27 continues operating.
5. Run the dry-run backfill.
6. Apply the backfill.
7. Run the inspector and require zero privacy issues.
8. Exercise one claim and one completed waiver in an Internal Test league; inspect again.
9. Run `npm run social:audit-transaction-privacy-transition`.
10. Deploy `firestore.transaction-privacy-transition.rules` with `firebase.transaction-privacy-transition.json`. This temporary bridge keeps the inherited member reads for canonical transactions and waivers while also allowing the new private/public projection reads.
11. Verify the live RC27 browser still completes transaction and waiver workflows.
12. Deploy **Hosting RC28 only**.
13. Verify two manager accounts and a commissioner account use only the new projections; run the inspector again.
14. Deploy the default final `firestore.rules` **Rules only** to remove every canonical browser read.
15. Verify raw reads fail for managers, commissioners, outsiders, and signed-out users while RC28 remains functional.

No Firestore index deployment is required. The transition config contains no Hosting or Functions target, and the final default Rules remain the source-controlled privacy authority. Keep the bridge window short. Do not promote App Check, the scoring queue, or the shared NHL cache as part of C1B.

### Exact staged deployment commands

Select the production project and record the live RC27 state before changing anything:

```bash
firebase use nhl-fantasy-app-ab673

curl -fsS https://rinkratfantasy.com/release-manifest.json

gcloud functions list \
  --v2 \
  --project=nhl-fantasy-app-ab673
```

Deploy the complete verified Functions codebase first. Do not deploy Hosting, Rules, or indexes in this command:

```bash
firebase deploy \
  --only functions \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1B transaction privacy projection publishers"
```

Prove the tools against one disposable Internal Test league before scanning every league:

```bash
npm run social:backfill-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_INTERNAL_TEST_LEAGUE_ID

RINKRAT_APPLY_TRANSACTION_PRIVACY=APPLY \
npm run social:backfill-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_INTERNAL_TEST_LEAGUE_ID

npm run social:inspect-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_INTERNAL_TEST_LEAGUE_ID
```

After the scoped inspection reports zero issues, prepare every existing league and require another zero-issue inspection:

```bash
npm run social:backfill-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673

RINKRAT_APPLY_TRANSACTION_PRIVACY=APPLY \
npm run social:backfill-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673

npm run social:inspect-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673
```

Audit and deploy only the temporary dual-read Rules bridge:

```bash
npm run social:audit-transaction-privacy-transition

firebase deploy \
  --config firebase.transaction-privacy-transition.json \
  --only firestore:rules \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1B temporary dual-read privacy transition"
```

After RC27 still completes its waiver and transaction workflows, deploy only RC28 Hosting:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1B Release Candidate 28"
```

Run the RC28 multi-account smoke test and privacy inspector again. Only after both pass, deploy the final source-controlled Rules lock:

```bash
firebase deploy \
  --only firestore:rules \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1B final transaction and waiver privacy rules"
```

Inspect the two publishers after each production exercise:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueTransactionActivity,publishLeagueWaiverPrivacy
```

## Production smoke test

Use a disposable Internal Test league:

1. Manager A drops an asset to waivers.
2. Manager B opens Free Agents and sees the waiver without a claim count.
3. Manager B submits a claim and sees **Your claim is private**.
4. Manager C sees the same waiver but cannot see that Manager B claimed it.
5. The commissioner sees no claimant count and processes the waiver through the existing button.
6. The result appears in League Wire and the sanitized completed-result projection.
7. Manager B's private ledger shows only Manager B's own transaction history.
8. Manager C and the commissioner cannot read Manager B's private transaction or claim paths.
9. A signed-out/outsider account cannot read public league projections.
10. Raw `transactions` and `waivers` reads fail for every browser account.

Then run:

```bash
npm run social:inspect-transaction-privacy -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_INTERNAL_TEST_LEAGUE_ID
```

Required result:

```text
Privacy issues: 0
Privacy projection inspection passed.
Inspection only. No raw transaction, waiver, league, score, or production setting was changed.
```

## Rollback

Before final privacy Rules are deployed, the transition bridge supports both clients. RC28 Hosting can be rolled back to the verified RC27 Hosting build without first changing Rules; then roll back Functions if the server publishers are the identified source.

After final privacy Rules are live, do not roll back Hosting directly to RC27. First redeploy the bundled transition Rules bridge, verify canonical member reads are restored, and then roll back Hosting to RC27. The prior RC27 Rules and Functions may be restored afterward from the verified rollback revision. Projection documents may remain because they are non-authoritative and browser writes are denied.

A C1B rollback must not change Scoring V3, Projection V11, roster windows, scoring queue mode, App Check mode, or NHL cache authority.


## C1B.1 verification-harness hotfix

The original C1B Rules test created seven intentionally forbidden Firestore write promises before it began awaiting them. The emulator correctly denied every write, but a later promise could reject before `expectDenied` attached its handler. Node then reported a temporary `unhandledRejection` and failed the suite even though the privacy Rules behaved correctly.

C1B.1 stores those operations as zero-argument functions and starts one write at a time inside `expectDenied`. This attaches the rejection handler before each emulator request begins. A focused regression test now requires all seven denial checks to remain lazy. No application source, Cloud Function, Firestore Rule, index, TTL policy, release identifier, or production setting changed.

## Verification gate

```bash
npm run verify:batchc1b
```

The gate inherits the complete C1A/D1C/security chain and adds privacy utility tests, Firestore Rules emulator coverage, client-path checks, migration-tool guards, RC28 release validation, protected-source hashing, documentation synchronization, and unchanged competitive-model assertions.
