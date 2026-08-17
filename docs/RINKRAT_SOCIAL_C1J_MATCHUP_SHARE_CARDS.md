# Social Batch C1J — Matchup Share Cards

**Runtime release:** Release Candidate 36

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** League HQ → League Wire → completed Game Final

**Authority:** Read-only browser rendering from an existing server-sanitized final result

## Purpose

C1J begins the shareable-card roadmap with completed fantasy matchups and championships. A league member can turn an existing immutable League Wire Game Final into a square RinkRat result image without creating a new Firestore document, callable Function, listener, or public result endpoint.

The share control appears only when the existing `matchup-result` activity contains both final scores. Live matchups, projections, Draft activity, transactions, and malformed results do not receive a share control.

## Card contents

The generated 1080×1080 PNG contains only:

- RinkRat Game Final or Champion branding;
- the league name;
- the matchup, playoff-round, placement, or championship context;
- both team names;
- both final fantasy scores;
- winner or tie presentation;
- higher-seed advancement context when applicable;
- the public RinkRat site name.

The card does not contain user IDs, emails, invite codes, transaction identifiers, waiver claims, commissioner notes, roster-slot IDs, NHL game ledgers, or private league records.

## Browser-only rendering

`league-matchup-share-card.service.ts` creates the result image with the native Canvas API. The card draws a compact rink, scoreboard, winner treatment, and championship accent without fetching a remote template, uploading data, or adding an image-generation dependency.

The Canvas is converted to a PNG synchronously before the first asynchronous boundary, so the native share call retains the phone browser's required user activation.

The browser uses this order:

1. Native Web Share with the PNG file when supported.
2. Native Web Share with text and the public RinkRat URL when file sharing is unavailable.
3. A local PNG download on desktop or unsupported browsers.
4. Best-effort caption copy after the local download when clipboard permission is available.

Canceling the native share sheet is treated as a normal cancellation, not an error.

## Mobile behavior

The share action is inline beneath the final result. It uses a 44-pixel touch target and becomes full-width on narrow phones. No preview modal, fuzzy backdrop, bottom sheet, fixed panel, or sticky control is introduced.

The card is generated only after the manager presses Share, so ordinary League HQ loading does not pay the Canvas rendering cost.

## Privacy boundary

League Wire remains member-only. A manager deliberately choosing Share exports the limited final-result summary outside the league. The UI footer makes this boundary explicit.

C1J adds no Firestore Rule, index, TTL policy, database migration, Cloud Function, Cloud Storage object, or analytics record.

## Preserved systems

C1J changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, scoring, roster, transaction, or waiver authority;
- transaction and waiver privacy;
- App Check Monitor or exact-league/callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority.

## Verification

```bash
npm run verify:batchc1j && echo "C1J VERIFICATION PASSED"
```

The C1J suite verifies text normalization, score formatting, safe filenames, championship and tie captions, 1080-square Canvas rendering, native-share and download fallbacks, final-only League Wire integration, 44-pixel mobile controls, no new backend resource, RC36 release identity, protected-source hashes, and permanent documentation.

## Deployment

C1J is Hosting-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1J matchup share cards Release Candidate 36"
```

Do not deploy Functions, Firestore Rules, indexes, TTL, App Check, scoring-queue configuration, or NHL-cache configuration for C1J.

## Site-first smoke test

Use one completed regular-season matchup and one completed championship or playoff result when available:

1. Open League HQ and find a Game Final.
2. Confirm **Share result** appears only beneath the completed result.
3. Press it on a phone and confirm the native share sheet receives a PNG card.
4. Confirm the league name, team names, scores, and matchup context are correct.
5. Cancel once and confirm no error appears.
6. Share or save the card and confirm the square image is readable.
7. On desktop, confirm the fallback downloads a PNG when native file sharing is unavailable.
8. Confirm a championship uses **RinkRat Champion** treatment.
9. Confirm a tie displays **TIE** and no false winner.
10. Confirm a higher-seed playoff advance includes that context.
11. Confirm live score surfaces, Draft picks, transactions, announcements, and Round Recaps do not show the share control.
12. Confirm reactions and mobile scrolling remain unchanged.

## Fallback diagnostic

C1J has no new server logs. When sharing fails, reproduce it in another supported browser and inspect the browser console for Canvas, Web Share, file, download, or clipboard errors. Competitive data remains unaffected because the feature is read-only.

## Rollback

A Hosting rollback removes the share control and browser renderer. It requires no data migration, Function rollback, Rules change, or cleanup because C1J writes no server state.
