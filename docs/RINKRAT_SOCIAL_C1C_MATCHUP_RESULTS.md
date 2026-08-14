# RinkRat Social Batch C1C — League Wire Matchup Results

**Runtime:** Release Candidate 29

**Competitive models:** Production Scoring V3 and Projection V11 (unchanged)

**Primary surface:** Mobile-first League Wire in League HQ

## Purpose

C1C adds one high-signal social event when a real fantasy matchup is final. It does not publish live score changes, individual NHL game changes, projected winners, temporary leads, or repeated milestone posts.

The first scoring-social feature is intentionally narrow:

- one activity document per completed two-team matchup;
- only the first `active-to-complete` transition is eligible;
- regular-season wins and ties are supported;
- playoff advancement, placement results, championships, and higher-seed tiebreaks are supported;
- bye matchups and malformed results fail closed;
- no historical matchup backfill is performed;
- the existing bounded 40-document listener and five-item collapsed view are retained.

This provides a trustworthy result signal without turning League Wire into live-score spam.

## Server authority and idempotency

The new create-only outcome publisher is:

```text
publishLeagueMatchupResultActivity
```

It observes:

```text
leagues/{leagueId}/cycles/{cycleId}/matchups/{matchupId}
```

The Function returns without publishing unless:

1. the source document existed before and after the update;
2. the prior status was not `complete`;
3. the new status is exactly `complete`;
4. both teams are present and distinct;
5. scores are finite and bounded;
6. a non-tied result names the score-leading team as winner;
7. a regular-season tie has no winner;
8. a playoff tie has a valid winner and `tieBrokenByHigherSeed: true`.

The source identity combines the cycle and matchup document IDs only in memory. The public activity document uses the existing deterministic SHA-256 League Wire identity, so retries converge on one document and raw source IDs are not stored.

Once the activity document exists, the server leaves it unchanged. Later writes to an already-complete matchup do not create another event.

A scoped read-only inspector is included for Functions-first proof when the currently live browser does not yet understand matchup entries:

```text
social:inspect-matchup-activity
```

## Public activity contract

The allowlisted matchup fields are:

```text
category: matchup
eventType: matchup-result
matchupPhase
matchupCycleNumber
teamAOwnerId
teamBOwnerId
teamAScore
teamBScore
winnerOwnerId
playoffBracketType
playoffRoundNumber
winnerPlace
loserPlace
tieBrokenByHigherSeed
```

The projection excludes:

- matchup, cycle, and playoff source-document IDs;
- roster-slot and six-game-window IDs;
- seeds except for the boolean higher-seed tiebreak outcome;
- score ledgers and individual player scoring;
- projections, confidence values, and temporary favorite state;
- commissioner notes and administrative reasons;
- request, task, and retry identifiers.

The existing `activity` Firestore Rule remains sufficient: league members may read the server-owned projection, while browser create, update, and delete operations remain denied.

## Mobile presentation

League Wire presents matchup results as `Game Final` entries.

Examples:

```text
Rink Raiders beat Blue Line Bandits.
42.75–38.2 · Matchup 7
```

```text
Rink Raiders and Blue Line Bandits finished tied.
40.5–40.5 · Matchup 7
```

```text
Rink Raiders advanced past Blue Line Bandits.
55–55 · Higher seed advanced · Playoff Round 1
```

```text
Rink Raiders won the RinkRat Championship.
Defeated Blue Line Bandits, 61.4–58.05 · Playoff Round 2
```

The existing inline card remains non-blocking. C1C adds no modal, viewport overlay, backdrop, sticky panel, duplicate dialog, or additional Firestore listener.

## No historical matchup backfill

C1C begins with matchups that complete after the Function is deployed. Existing completed matchups are intentionally not backfilled because doing so would flood League Wire with old results, reorder recent Draft/transaction activity, and make deployment look like current league action.

If historical league storytelling becomes valuable later, it should use an explicit season archive or recap feature rather than silently inserting old feed entries.

## Protected systems

C1C does not change:

- Production Scoring V3 math or source files;
- Projection V11 math, snapshots, or Draft enforcement;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- server-authoritative Draft, roster, waiver, cycle, or playoff actions;
- Firestore Rules or indexes;
- TTL policies;
- App Check Monitor mode;
- exact-league/callable canary controls;
- scoring queue Shadow mode;
- shared NHL cache Shadow mode or authoritative-read lock.

## Verification

Use the pinned toolchain:

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
node --version
npm --version
npm run verify:batchc1c
```

The focused suite verifies:

- deterministic source identity without raw IDs;
- regular wins and ties;
- playoff advancement and championship context;
- higher-seed tiebreak validation;
- bye and malformed-result rejection;
- first-transition-only trigger behavior;
- a scoped read-only activity inspector with strict schema/privacy checks;
- bounded existing listener use;
- mobile no-overlay/no-sticky presentation;
- RC29 while Scoring V3, Projection V11, Rules, indexes, and safety modes remain unchanged.

## Owner-friendly validation lane

The default operator path for C1C is intentionally short:

1. Run one complete automated gate and look only for the final success line.
2. Commit and push the verified source.
3. Deploy the one new Function and RC29 Hosting.
4. Prove the feature on the actual site with one Internal Test matchup.

Use the detailed inspector or Function logs only when the result does not appear, appears more than once, or shows incorrect data. An empty error log is useful but is not proof by itself: a trigger can be deployed yet never fire, and a browser can silently read stale or incomplete data without producing a clear error. The live-site result is the primary product proof; the automated gate protects the invisible security and regression boundaries.

One-command local gate:

```bash
npm run verify:batchc1c && echo "C1C VERIFICATION PASSED"
```

After a clean commit, rebuild the exact revision and deploy only the new publisher plus Hosting:

```bash
npm run build && \
firebase deploy \
  --only functions:publishLeagueMatchupResultActivity \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1C League Wire matchup result publisher" && \
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1C Release Candidate 29"
```

No TTL, index, App Check, scoring-queue, NHL-cache, or broad Function-list inspection is part of the normal C1C happy path. Those systems are unchanged and should be inspected only when a related symptom appears or during a scheduled major-phase audit.

## Deployment prerequisite: finish C1B privacy preparation

C1C does not remove the staged C1B privacy requirement. Before RC29 Hosting is deployed:

1. Complete the global C1B backfill dry run.
2. Apply the global privacy projections only when the dry run is clean.
3. Require the global inspector to report zero privacy issues.
4. Audit and deploy the temporary dual-read transition Rules.
5. Confirm the currently live browser still loads Free Agents and Team Settings.

When production is still on a pre-RC28 browser, RC29 may be the first projection-reading Hosting release. An intermediate RC28 Hosting deployment is not required as long as the temporary bridge is live, the global inspector is clean, and the RC29 privacy smoke test passes before the final Rules lock.

## Deploy Functions only

Deploy the complete verified Functions codebase first:

```bash
firebase deploy \
  --only functions \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1C League Wire matchup result publisher"
```

Do not approve unexpected Function deletions.

## Optional diagnostic Function proof

The live RC29 site test is the normal proof. Use this scoped inspector path only when the browser result is missing, duplicated, incorrect, or cannot yet be tested. It is also available for a deeper release audit.

Use one disposable Internal Test league whose matchup is still active. Record the scoped read-only baseline before advancing it:

```bash
npm run social:inspect-matchup-activity -- \
  --project=nhl-fantasy-app-ab673 \
  --league=EXACT_INTERNAL_TEST_LEAGUE_ID
```

The baseline may report zero matchup results. It must report zero privacy/schema issues.

1. Record the reported matchup-result count.
2. Advance normal scoring or the serialized historical replay until one two-team matchup becomes complete.
3. Run the same inspector again and require the count to increase by exactly one.
4. Confirm the latest result has the correct matchup number, final score, and timestamp.
5. Refresh scoring again, rerun the inspector, and confirm the count does not increase.
6. Confirm a bye does not create a result.
7. Require `Privacy/schema issues: 0` throughout.

This command-line proof works even when the currently live browser predates C1C and cannot render `Game Final` yet. The inspector reads only `leagues/{leagueId}/activity`; it does not change a matchup, score, league, activity document, or production setting.

Inspect only the new publisher when necessary:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueMatchupResultActivity
```

## Deploy Hosting RC29 only

After the Function smoke test and C1B transition prerequisites pass:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1C Release Candidate 29"
```

No Firestore Rules or index deployment is required for C1C itself. The later final privacy Rules deployment belongs to the inherited C1B cutover and occurs only after RC29 proves the owner-private projections.

## RC29 browser smoke test

On a narrow phone viewport and desktop:

1. Open League HQ and confirm the existing five-item collapsed feed.
2. Confirm `Game Final` uses readable team names and scores.
3. Confirm a championship result uses the RinkRat Championship headline.
4. Confirm a playoff score tie states that the higher seed advanced.
5. Confirm old completed matchups did not suddenly appear.
6. Confirm no live score changes create feed entries.
7. Confirm Draft and roster items still render normally.
8. Confirm `Show earlier updates` expands inline without a modal or sticky obstruction.
9. Confirm an outsider cannot read the activity collection.
10. Confirm a member cannot forge, edit, or delete a result.

## Final inherited C1B Rules lock

When RC29 Free Agents, Team Settings, waiver privacy, and League Wire all pass under the transition bridge, deploy the default final Rules:

```bash
firebase deploy \
  --only firestore:rules \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1B final transaction and waiver privacy rules after RC29 proof"
```

This is not a C1C Rules change. It completes the previously staged C1B privacy boundary.

## Rollback

The C1C publisher is additive and does not change authoritative competition data. A Functions rollback stops future result publication; already-created sanitized activity remains safe and member-only.

Before the final C1B Rules lock, the temporary bridge supports both the old and RC29 clients.

After final privacy Rules are live, do not restore a pre-projection browser directly. First restore the bundled transition Rules bridge, then restore the known-good Hosting revision.

C1C requires no scoring-mode, App Check, NHL-cache, TTL, index, or competitive-data rollback.
