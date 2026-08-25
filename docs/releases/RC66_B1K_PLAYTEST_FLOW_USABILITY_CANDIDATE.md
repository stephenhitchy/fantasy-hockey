# RC66 / B1K Playtest Flow Usability Candidate

**Status:** Source-complete candidate built on the RC65/B1J.2 baseline. It has not been deployed, frozen, tagged, or promoted to the production release identity.

**Deployment scope after the pinned gate passes:** targeted Email Functions plus Hosting. No Firestore Rule, index, TTL, scoring, projection, roster-window, Draft, waiver, App Check, scoring-queue, or shared-NHL-cache change is part of this batch.

## Why this candidate exists

A beginner playtest found four connected usability problems:

1. Leaving Training Camp automatically released the first verification email even though the screen looked like a manual action.
2. A cooldown-blocked resend could still look successful.
3. Sign out was available only inside Account Settings.
4. The reusable league navigation added to My Team and Matchup was missing from the other destinations it named.

The same playtest also showed that Training Camp explained how the six-game system works without briefly explaining why RinkRat uses it.

## Manual first verification send

Completing Training Camp or choosing Finish Later now marks the account as eligible for verification but does not send the first email. The manager must press **Send verification email**.

After a provider-confirmed send:

- the button changes to **Send another verification email**;
- the existing 120-second server cooldown remains intact;
- the disabled button displays the honest remaining countdown;
- the callable reports `sent`, `cooldown`, `ready`, `blocked`, or `already-verified` rather than returning the same success shape for every outcome;
- failed provider delivery releases the cooldown claim;
- invite-link continuation still joins only after Firebase reports the address verified.

The shared behavior is used by Training Camp, invite-link continuation, and Account Settings.

## Navigation

The global desktop and mobile navigation now includes cleanup-aware **Sign out** through the existing authentication service.

One presentation-only league quick-navigation component now appears on:

- League HQ
- Add / Drop Player
- My Team
- Current Matchup
- All Current Matchups
- Full Schedule
- League Standings

The open destination receives `aria-current="page"` and a visible Current marker. The component creates no Firestore, Draft, roster, or matchup listeners.

## Six-game rationale

The first Training Camp drill now contains one compact **Why RinkRat uses six games** callout. It explains that NHL schedules are uneven, equal six-game opportunities reduce schedule luck, both managers receive a more even opportunity, fewer daily lineup changes are required, meaningful roster strategy remains important, and already-earned games and points stay protected.

The five-shift, ten-drill progressive structure is unchanged.

## Verification performed in the reconstruction environment

- Focused B1K suite: 9/9 passed.
- Combined B1F–B1K onboarding/navigation regression: 60/60 passed.
- Broad project source sweep: 1,071 tests passed; two dependency-backed files could not start because compiled Functions output and the Firebase package/emulator dependencies are not installed in this reconstruction environment.
- TypeScript syntax check: all 16 changed TypeScript files passed.
- `git diff --check`: passed.
- Protected Scoring V4, Projection V11, and Firestore Rules hashes: unchanged.

The environment did not contain installed root/Functions dependencies or the pinned Node/npm pair, so the Angular build, Functions build, compiled Draft authority test, and Firebase Rules emulator test remain required locally.

## Local candidate gate

```bash
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1k
npm run build:all
```

## Targeted deployment after every gate passes

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions:resendVerificationEmail,functions:sendWelcomeEmailOnProfileCreated,functions:sendWelcomeEmailAfterTrainingCampResolved,hosting:app \
  -m "B1K manual verification and navigation usability"
```

Do not deploy Hosting alone. The new interface and the new backend email behavior must move together.

## Browser proof still required

Test completion and Finish Later from ordinary onboarding and a saved invite link; first send; cooldown and resend; reload during cooldown; verification return; invitation resume; desktop/mobile sign out; and all seven league destinations in Chrome, Safari, iPhone Safari, and Android Chrome.

## Next infrastructure batch

Near-live scoring remains intentionally separate. The next scale batch should prove the existing per-league queue through Canary, move it to Primary after parity/backlog gates pass, promote shared NHL ingestion carefully, coalesce changed NHL game versions, and target healthy 30–90-second updates without blind one-minute full-league polling.
