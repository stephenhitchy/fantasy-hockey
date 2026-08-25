# Release Candidate 65 — Beta Batch B1J

## Tutorial Return, Navigation Consolidation, and Draft Readiness

**Release scope:** Hosting only  
**Protected game systems:** Production Scoring V4, Projection V11, immutable six-game windows, seventh-game rollover, server-authoritative Draft/roster/waiver/IR/membership actions, App Check Monitor, Scoring Queue Shadow, and Shared NHL Cache Shadow remain unchanged.

## Release-integrity correction

The first RC65 archive was not deployable as packaged: its root `package.json` did not expose `verify:batchb1j`, and the archive did not contain the complete B1J source described by its release notes. The corrected RC65 package adds the inherited verification chain, moves repository CI and freeze metadata to B1J/RC65, includes the complete manager-facing implementation, and adds focused tests that fail if the release script or source disappears again.

Do not deploy the superseded RC65 archive. The corrected package remains Release Candidate 65 because the incomplete archive never passed the release gate or reached Firebase.


## B1J.2 position-help and archive-size hotfix

A later browser playtest found that the position definition could appear far to the side on desktop and could be offset on mobile. The panel used `position: fixed`, but Training Camp and the route shell intentionally animate with transform/translate-based motion. Browsers treat a fixed descendant of those animated surfaces as fixed to the transformed surface instead of the visual viewport. The positioning code was calculating viewport coordinates, so the transformed ancestor added a second offset.

B1J.2 moves the open Hockey Term panel directly under `document.body` while leaving the trigger in place. This is a non-modal portal: it does not lock page scrolling. The panel continues to:

- allow only one definition at a time;
- clamp to the current desktop viewport;
- use the mobile bottom-sheet layout;
- close with Escape, outside click, or Close;
- preserve focus restoration;
- preserve the inherited position and team-theme variables after portaling.

The corrected source archive omits `.git` entirely. The doubled RC65 ZIP was not caused by application growth: the archive had begun including the full `.git` directory so the release manifest could retain an exact commit, and that directory contained 1,408 loose objects. Those objects added about 13.36 MB to the compressed ZIP, while the non-Git application payload remained about 12.37 MB. B1J.2 adds a tiny ignored `.rinkrat-source-revision` file to packaged source and teaches the manifest generator to use it only when the project root has no `.git` metadata. This preserves the exact clean revision without duplicating the full source history or accidentally reading an unrelated parent repository.

## Why this batch exists

The first independent new-manager playtest showed that the progressive Training Camp was easier to follow, but four usability gaps remained:

1. Opening the full Scoring Guide abandoned the exact Training Camp location.
2. The Coach Challenge quiz added friction after the lesson had already been simplified.
3. The global navigation contained too many league-specific choices while league pages also had their own navigation.
4. Slow projection reads could keep a manager waiting before the useful Draft Room appeared.

B1J resolves those gaps without moving any scoring, roster, projection, or membership authority into the browser.

## Training Camp continuity

The full Scoring Guide link carries the active Training Camp shift and drill. It also preserves the pending invitation continuation state when onboarding began through a shareable league link.

The Scoring Guide presents a persistent **Training Camp is paused** notice with **Back to Training Camp**. Returning restores the exact lesson rather than restarting Training Camp or sending the manager to a generic dashboard.

The return state is bounded to recognized Training Camp values. It is navigation state only and cannot mark a lesson or Training Camp as complete.

## Progressive lessons without a quiz gate

Training Camp continues to reveal one short drill at a time. The mandatory Coach Challenge question-and-answer gate has been removed. Managers advance with **Next Drill**, while completed managers retain free review access.

The six-game marker example now depicts:

- Games 1–3: played
- Game 4: missed/injured
- Games 5–6: upcoming

This mirrors the intended visual story: the player appeared, missed the fourth scheduled game, and still has future schedule markers ahead.

## Simplified global navigation

The durable global navbar is limited to:

- Dashboard
- Create League
- Join League
- Scoring Guide
- Support
- Account

League-specific choices are kept inside league pages. Rendering the global navbar does not require league, matchup, or Draft listeners merely to decide which links to display.

## Shared league quick navigation

My Team and Matchup now use the same reusable league quick-navigation surface. The Matchup version is compact but retains the same visual hierarchy:

- League HQ
- Add / Drop Player
- My Team
- All Current Matchups
- Full Schedule
- League Standings

The Matchup page intentionally offers **My Team** rather than linking back to the matchup already being viewed.

## Non-blocking Draft projections

The Draft Room renders its essential live experience independently of projection rankings:

- Draft board
- Pick clock
- Pick order
- Teams
- Queue
- Live Draft state

Projection rankings load in the background. After a bounded delay, the ranking area explains that loading is still in progress and provides **Retry Rankings**. A projection request can fail without trapping the entire Draft Room behind a global loading state.

### Request isolation and authority

After four seconds, the ranking panel explains that the read is still pending and exposes **Retry Rankings**. Starting a retry gives the new request a higher local request ID, so an older response cannot overwrite the newest result.

Every accepted ranking list still comes from the existing shared projection snapshot service. RinkRat continues to require server generation, the projection authority schema, the snapshot-hash schema, SHA-256 integrity, the pinned snapshot identity when present, and the Draft document's expected content hash. No browser-generated projections or browser projection cache were introduced.

## Manual browser acceptance matrix

Before deployment sign-off, verify:

1. Open the full Scoring Guide from every Training Camp shift and return to the exact drill.
2. Repeat while onboarding from a pending league invitation.
3. Complete Training Camp without encountering a required quiz.
4. Confirm Game 4 is the missed/injured marker.
5. Verify the six-link global navbar signed in and signed out, desktop and mobile.
6. Confirm My Team and Matchup share the league quick-navigation layout.
7. Throttle the network and confirm the Draft board appears before rankings.
8. Use **Retry Rankings** after an induced projection failure.
9. Start a second ranking request and confirm an older response cannot replace the newer request.
10. Confirm a mismatched snapshot identity or content hash is still rejected.
11. Repeat the projection matrix in Safari and Mobile Safari.
12. Open every position definition on desktop and confirm it stays beside the selected position and inside the viewport.
13. Repeat the position-definition test on a narrow phone and confirm the bottom sheet stays centered with no horizontal offset.

## Deployment boundary

After the complete pinned release gate passes, deploy Hosting only:

```bash
firebase deploy --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Beta B1J Tutorial Navigation Draft Readiness Release Candidate 65"
```

Do not deploy Functions, Firestore Rules, indexes, or TTL policies for B1J.
