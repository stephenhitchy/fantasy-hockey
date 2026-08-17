# Social Batch C1K — Identity Architect

**Runtime release:** Release Candidate 37

**Competitive models:** Production Scoring V3 and Projection V11

**Primary product surface:** Account Settings → Favorite Team or RinkRat Colors

**Authority:** Server-reconciled permanent challenge rewards and server-authoritative profile saves

## Purpose

C1K turns the existing team-identity challenges into a complete cosmetic progression path. Every NHL team receives a sixth identity option named **Custom Identity**. The reward remains cosmetic and cannot affect scoring, projections, rosters, Draft authority, matchup windows, or any competitive record.

The new challenge is:

```text
Identity Architect
Complete every other team-identity challenge.
Reward: Custom logo and three-color identity for every NHL team.
```

The four foundational challenges remain:

```text
First Line Change
Commissioner Mode
League Explorer
Crowded Schedule
```

When all four are present, the server permanently awards `identity-architect`.

## Sixth identity for every NHL team

Every NHL team now has six identity cards in this order:

```text
1. Current Home
2. Current Away
3. Retro / Heritage
4. Alternate
5. Special
6. Custom Identity
```

The neutral RinkRat identity remains available, but the custom builder requires an NHL favorite because the logo choices must belong to a selected club.

After Identity Architect is unlocked, the manager can:

1. Choose among the unique current, historical, alternate, and special logos already available for the selected NHL team.
2. Choose a primary color.
3. Choose a secondary color.
4. Choose a tertiary color.
5. Preview the result immediately.
6. Save it as the active site identity.

The editor is inline inside Account Settings. It uses no modal, backdrop, bottom sheet, fixed editor, or sticky content.

## Compact saved identity

C1K keeps the existing profile schema. The custom logo and palette are encoded inside the bounded `favoriteTeamVariantId` field:

```text
custom-identity~logo-variant-id~RRGGBB~RRGGBB~RRGGBB
```

The maximum encoded length remains below the existing 80-character profile limit. The browser and server validate the exact format. The selected logo is resolved only from the chosen NHL team's own identity catalog; an unknown logo ID safely falls back to that team's home logo.

This approach avoids a new Firestore collection, document listener, migration, index, or retention policy. Existing public manager profiles continue carrying only the display-safe team abbreviation and variant string.

## Challenge authority

The browser calls:

```text
reconcileTeamIdentityChallenges
```

The callable requires an authenticated manager and reads the manager's canonical league memberships. It calculates:

```text
First Line Change: at least one active league
Commissioner Mode: commissioner of at least one active league
League Explorer: at least three active leagues
Crowded Schedule: at least ten opponents across active leagues
Identity Architect: all four foundational rewards are present
```

Challenge progress is permanent. Existing unlocks are merged with newly earned rewards inside one server transaction. A browser may no longer add, remove, or forge `teamIdentityUnlocks` directly after the final C1K Firestore Rules deployment.

The challenge scan is bounded to the same 32-league beta maximum. It stores no new league analytics document and introduces no long-lived listener.

## Completion notification

Challenge authority refreshes after sign-in, a return to the browser tab, a successful league create/join action, and when Account Settings opens. Routine route changes do not rescan every league, and passive refocus checks are throttled to once per minute. Newly awarded challenges enter one small queue and appear one at a time in a top-right notification.

Each notification contains:

- **Challenge complete**;
- the challenge title;
- the cosmetic reward;
- **Open Team Identity**;
- a dismiss action.

The notification auto-dismisses after ten seconds. Multiple new rewards queue rather than overlap. The action navigates to:

```text
/account/settings#team-identity-customizer
```

When Identity Architect is available, that link scrolls to the identity section and opens the inline custom editor. The notification has no page-blocking backdrop and remains phone-safe.

## Server profile boundary

`saveManagerProfile` now:

- accepts the fifth permanent challenge reward;
- validates the compact custom-identity format;
- refuses a custom identity for the neutral RinkRat theme;
- refuses a custom identity during account initialization;
- reads the server-stored challenge list rather than trusting browser-provided unlocks;
- refuses a custom identity until `identity-architect` is present.

The final Rules lock permits only the default `current-home` identity with an empty challenge list during the emergency legacy registration fallback. It removes `teamIdentityUnlocks`, `favoriteTeamAbbreviation`, and `favoriteTeamVariantId` from the private browser-update allowlist, and requires every browser-written public profile repair to match the post-write private profile. All later team-identity changes therefore travel through `saveManagerProfile`.

## Preserved systems

C1K changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, scoring, transaction, or waiver authority;
- transaction and waiver privacy;
- Firestore indexes or TTL policies;
- App Check Monitor or exact-callable canary configuration;
- scoring queue Shadow mode;
- shared NHL cache Shadow mode or authoritative-read setting.

## One automated verification gate

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1k && echo "C1K VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Targeted deployment

Deploy the two server-authority Functions first:

```bash
firebase deploy \
  --only functions:reconcileTeamIdentityChallenges,functions:saveManagerProfile \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1K Identity Architect authority"
```

Deploy RC37 Hosting next:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1K Identity Architect Release Candidate 37"
```

After the new browser is proven, deploy the server-only challenge and team-identity Rules lock:

```bash
firebase deploy \
  --only firestore:rules \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1K server-owned team identity progression"
```

No index, TTL, App Check, scoring queue, or NHL-cache deployment belongs to C1K.

## Site-first smoke test

Use a disposable account or test manager with the four foundational challenge rewards.

1. Sign in, return focus to the tab, complete a league create/join, or open Account Settings so challenge reconciliation runs.
2. Confirm a top-right **Identity Architect** completion notice appears.
3. Press **Open Team Identity**.
4. Confirm Account Settings scrolls to the team identity section and opens the custom editor.
5. Confirm the selected NHL team has exactly six identity cards and Custom Identity is sixth.
6. Choose a different available logo for the selected club.
7. Change primary, secondary, and tertiary colors.
8. Confirm the live preview and page theme update without a modal.
9. Save the custom identity.
10. Refresh and navigate through Dashboard, League HQ, Game Center, and Account Settings.
11. Confirm the chosen logo and all three colors persist.
12. Switch to another NHL team and confirm that team also has a sixth custom option with only that team's logos.
13. Confirm the neutral RinkRat option does not expose the custom builder.
14. On a phone, confirm the editor, logo choices, color controls, toast, and buttons remain readable and scroll normally.

For a manager who earns more than one old challenge on first reconciliation, confirm the notifications appear one at a time rather than stacking.

## Fallback diagnostics

Only when reconciliation or saving fails:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only reconcileTeamIdentityChallenges,saveManagerProfile
```

## Rollback

Before rolling Hosting back to RC36, restore the previous browser-writable profile Rules only when the old client must continue awarding old challenge rewards. The safer rollback is to keep the C1K Functions and Rules while correcting or redeploying RC37 Hosting, because older clients do not understand the fifth reward or custom identity editor.

Do not change scoring, projections, App Check, scoring queue, shared NHL cache, indexes, or TTL settings as part of a C1K rollback.
