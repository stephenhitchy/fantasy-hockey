# RinkRat Security Batch S3E — App Check Enforcement Readiness

**Runtime:** Release Candidate 23  
**App Check mode:** Monitor only  
**Competitive models:** Scoring V3 and Projection V11

## Purpose

S3E turns App Check monitoring into an evidence-based release gate without enabling enforcement automatically. The Beta Operations Center evaluates only evidence produced by the exact deployed build, so traffic from an older release cannot make a new release look safe.

The same batch also repairs the mobile Matchup presentation for injured players. Mobile lineup rows now show one compact status icon, a short designation, and the expected return date. The full injury article remains available on the player detail page and in richer desktop contexts.

## Why enforcement remains off

A valid App Check token indicates that a request likely came through the legitimate RinkRat web client. It does not replace authentication, authorization, identifier validation, or server-side competitive rules.

S3E therefore follows this order:

1. Deploy the monitor-only client and server evidence changes.
2. Exercise supported browsers and important competitive workflows.
3. Collect exact-build evidence for multiple days and manager-days.
4. Review missing or invalid token patterns.
5. Begin a later, deliberate selected-callable canary only after every gate passes.
6. Keep Firestore enforcement as a separate later gate.

No S3E command or screen can silently turn enforcement on.

## Exact-build readiness policy

The source-controlled policy is:

```text
config/app-check-enforcement-readiness.json
```

The initial gate requires:

```text
At least 50 exact-build samples
At least 3 UTC observation days
At least 5 privacy-limited manager-days
At least 99% overall App Check verification
At least 3 samples for every required browser
At least 3 samples for every required device class
At least 3 samples for every required platform
At least 3 samples for every required competitive action
```

Required browsers:

```text
Chrome
Safari
Mobile Safari
```

Required device classes:

```text
Phone
Desktop
```

Required platforms:

```text
iOS
Android
```

Required competitive actions:

```text
Draft pick
Add/drop
Lineup swap
Injured Reserve
Waiver claim
```

The dashboard also reports observed operating-system families, including iOS, Android, macOS, Windows, ChromeOS, and Linux. These are generalized categories, not full user-agent strings.

## Administrator review

Open:

```text
Admin Center
→ Live Evidence
→ Selected-callable enforcement gate
```

The panel shows:

- exact build ID;
- total, valid, and missing samples;
- verification percentage;
- observed UTC days and manager-days;
- required browser coverage;
- required device coverage;
- required competitive-action coverage;
- observed platform families;
- explicit blockers and advisories.

Possible states:

```text
Collecting
Needs attention
Ready for selected-callable canary
```

“Ready” is permission to plan a later canary. It is not an enforcement switch.

## Later selected-callable canary scope

The policy records the first intended candidates:

```text
secureDraftPick
executeSecureRosterAction
applyImmediateRosterMove
advanceHistoricalReplayDay
requestProjectionSnapshotGeneration
```

A future enforcement batch must still:

- use an explicit operator confirmation;
- retain a rollback route;
- begin with the smallest practical scope;
- verify supported browser workflows after deployment;
- keep Firestore enforcement off until callable enforcement is proven.

## Compact mobile injury status

On phone-width Matchup rows, an injured player now shows a bounded status such as:

```text
✚ IR · Return Sep 15
✚ Out · Return TBD
```

The compact status deliberately excludes:

- long injury articles;
- medical-detail paragraphs;
- source text;
- roster-impact essays.

The accessible label still communicates the full status and return date to screen readers. Selecting the player continues to open the complete Game Film/player detail experience where the longer update may be read.

## Privacy

The readiness evidence may include:

- exact build ID;
- generalized browser family;
- generalized operating-system family;
- phone/tablet/desktop category;
- App Check valid or missing status;
- generalized competitive-action type;
- outcome and duration;
- daily rotating manager hash.

It excludes raw user IDs, league IDs, player IDs, scores, rosters, invite codes, raw IP addresses, and full user-agent strings.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci

npm run verify:batchs3e
```

The focused audit can be run separately:

```bash
npm run security:audit-app-check-readiness
npm run test:batchs3e:run
```

## Deployment

Deploy Functions first because the evidence schema and exact-build readiness calculation are server-owned:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions \
  -m "Security S3E App Check readiness evidence"
```

Then deploy Hosting for the RC23 client, Admin Center panel, and compact mobile injury status:

```bash
firebase deploy --only hosting:app \
  -m "Security S3E RC23 readiness and mobile injury clarity"
```

Do not deploy Firestore Rules or indexes for S3E.

## Post-deployment validation

1. Confirm Release Readiness reports Release Candidate 23, Scoring V3, and Projection V11.
2. Confirm App Check remains valid and monitor-only.
3. Open Admin Center → Live Evidence and verify the exact build ID matches the deployed manifest.
4. Complete a Draft pick, add/drop, lineup swap, IR move, and waiver claim.
5. Repeat representative workflows on desktop Chrome, desktop Safari, and Mobile Safari.
6. Confirm new evidence appears under the expected browser, device, platform, and action buckets.
7. Confirm no enforcement has been enabled.
8. On a phone-width Matchup page, confirm injured players show only the compact icon, short status, and return date.
9. Open the same player’s detail page and confirm the full injury update is still available there.

## Rollback

If the Admin Center evidence view or mobile Matchup presentation regresses:

```bash
git checkout LAST_KNOWN_GOOD_TAG
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run build:all
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Rollback S3E Functions"
firebase deploy --only hosting:app -m "Rollback S3E Hosting"
```

App Check enforcement is already off, so no enforcement rollback is required for S3E itself.
