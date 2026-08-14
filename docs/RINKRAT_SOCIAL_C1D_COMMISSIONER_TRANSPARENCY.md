# RinkRat Social Batch C1D — Commissioner Transparency

**Runtime release:** Release Candidate 30
**Competitive models:** Production Scoring V3 and Projection V11 (unchanged)
**Primary surface:** League HQ / League Wire
**Deployment:** Two targeted Functions, then Hosting RC30

## Purpose

C1D makes ordinary commissioner actions visible to every league member without turning League Wire into an administrative log. It reuses existing server-authoritative Draft and league-specific player-availability records. Browsers still cannot write League Wire entries.

The feature publishes only successful actions that can affect how managers interpret or participate in the competition:

- A commissioner sets or changes a league-specific player availability status.
- A commissioner clears a league-specific player availability override.
- A commissioner opens a scheduled Draft.
- A commissioner pauses the live Draft clock.
- A commissioner resumes the live Draft clock.

## Public projection contract

Every C1D item is a deterministic, create-only projection in:

```text
leagues/{leagueId}/activity/{activityId}
```

The two publishers are:

```text
publishLeagueAvailabilityOverrideActivity
publishLeagueDraftControlActivity
```

Before publishing, each Function reads the live league document and verifies that the saved action actor matches the current `commissionerId`. The existing League Wire authority creates the activity only when its hashed identity does not already exist, so retried trigger delivery cannot create duplicates.

### Player availability

The public item may contain only:

- The commissioner owner ID already used for league display identity.
- A bounded player name.
- An allowlisted public availability status.
- The event timestamp and standard League Wire authority metadata.

It never copies:

- The commissioner's note.
- A raw player or source-document ID.
- A request or submission ID.
- Internal matching or injury-source diagnostics.
- A failed save attempt.

A note-only edit creates no activity. Changing status or IR eligibility creates one status item. Deleting the override creates one clear item.

### Draft controls

The Draft publisher compares the before and after state and allows only these transitions:

```text
not live -> live       Commissioner opened the Draft
running -> paused      Commissioner paused the Draft clock
paused -> running      Commissioner resumed the Draft clock
```

It requires `clockUpdatedBy` to match the live league commissioner. Automatic scheduled openings, server recovery, automatic Draft actions, and a first manager starting an initial clock are not labeled as commissioner actions. Draft messages, recovery details, projection metadata, and internal timing fields are not copied.

## Mobile experience

C1D reuses the existing bounded League Wire card:

- Five recent entries remain visible by default.
- At most 40 recent activity documents are listened to.
- Earlier entries expand inline.
- There is no modal, fuzzy backdrop, fixed action sheet, sticky panel, or extra listener.
- Commissioner items use the existing readable typography and a distinct warning-toned category treatment.

Examples:

```text
Commissioner
Marked Jack Hughes as Out.

Commissioner
Cleared the availability override for Jack Hughes.

Commissioner
Opened the Draft.

Commissioner
Paused the Draft clock.
```

## Deliberate exclusions

C1D does not publish:

- Commissioner notes.
- Note-only edits.
- Failed or rejected attempts.
- Automatic server Draft openings or recovery actions.
- First-manager clock starts.
- Live score changes.
- Pending waiver claims or queued roster plans.
- Internal platform-admin, replay, scoring-queue, cache, App Check, or recovery controls.
- Historical backfill for actions that occurred before deployment.

Internal recovery tools remain operational evidence, not member-facing social events. A later batch may add a separately designed, privacy-reviewed administrative history if beta evidence shows that league members need it.

## Protected systems

C1D changes no:

- Production Scoring V3 source or earned score.
- Projection V11 source or frozen projection.
- Independent immutable six-game roster-slot window.
- Seventh-game rollover behavior.
- Roster, Draft, scoring, waiver, or transaction authority.
- Firestore Rule or index.
- TTL policy.
- App Check Monitor or exact-league/callable canary control.
- Scoring queue Shadow authority.
- Shared NHL cache Shadow authority.

## Verification

After manually replacing the project files, use one automated verification gate:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1d && echo "C1D VERIFICATION PASSED"
```

Only the final `C1D VERIFICATION PASSED` line is needed to approve the local gate. Expected Firestore `PERMISSION_DENIED` messages inside the Rules suite are normal when the suite itself reports zero failures.

After verification:

```bash
git restore -- firestore-debug.log public/assets/team-identity-logos/source-manifest.json

git add .
git diff --cached --check
git commit -m "Add commissioner transparency to League Wire"
git push
```

## Targeted deployment

Build the exact committed browser release:

```bash
npm run build
```

Deploy only the two new publishers:

```bash
firebase deploy \
  --only functions:publishLeagueAvailabilityOverrideActivity,functions:publishLeagueDraftControlActivity \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1D commissioner transparency publishers"
```

Then deploy Hosting RC30:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1D Release Candidate 30"
```

Do not deploy Firestore Rules, indexes, TTL configuration, scoring-queue controls, App Check controls, or shared-cache controls for C1D.

## Site-first smoke test

Use a disposable Internal Test league.

1. Open **Player Availability** as commissioner.
2. Save one player's status as `Out` or another non-default status.
3. Open League HQ and confirm exactly one **Commissioner** item names the player and public status.
4. Edit only the note and save again. Confirm no additional League Wire item appears.
5. Clear the override. Confirm exactly one clear item appears.
6. On a narrow phone viewport, confirm the card remains readable and expands inline without blocking scrolling.
7. Optional Draft proof: in a disposable live Draft, pause and resume the clock once. Confirm one item for each successful action.

When those visible checks pass, C1D is complete. No routine TTL, cache, global Function-list, or log inspection is required.

## Fallback diagnostics

Use logs only when a visible item is missing, duplicated, or incorrect:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueAvailabilityOverrideActivity,publishLeagueDraftControlActivity
```

A missing item after a successful save should be investigated. A failed browser save correctly creates no activity.

## Rollback

C1D is additive and does not mutate authoritative competition records. Restoring the prior Functions revision stops future C1D publication; already-created sanitized activity remains valid and member-only. Restoring prior Hosting removes the new rendering labels. No Rules, index, TTL, scoring, projection, queue, App Check, or cache rollback is required.
