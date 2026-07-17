# Fantasy Hockey Favorite-Team Theme Expansion V1

This package expands the saved favorite-team identity across the app. It does not change the Firestore save workflow or rules.

## What changed

### Dashboard favorite-team referee
- The dashboard rink attendant now wears the user's saved favorite-team colors.
- The selected NHL team crest appears on the attendant's jersey.
- The scoreboard beside the attendant shows the saved team abbreviation and name.

### Account locker favorite-team referee
- The favorite-team profile area now contains a pixel referee wearing the selected team's colors and crest.
- Changing the favorite team updates this referee immediately.
- The saved selection remains the source of truth when returning to the page.

### Site-wide favorite-team accents
The favorite team's palette now controls shared presentation throughout the app:
- card and panel outlines
- eyebrow labels and secondary/subtext
- navbar borders and muted navigation labels
- active navigation indicators
- focused form fields
- primary actions
- active matchup view controls
- Cycle page matchup outlines, transparency panels, and supporting text
- My Team, Free Agents, Draft, Playoffs, Standings, and Projection card outlines where matching shared classes are present

Semantic colors remain unchanged:
- green = completed/played
- yellow = upcoming
- red = missed/error

### Persistence note
This package assumes the updated Firestore rules from Pixel Account Page V1 are deployed. No additional rules update is required.

## Files included
- `src/app/core/user/user-theme.service.ts`
- `src/styles.css`
- `src/app/shared/navbar/navbar.css`
- `src/app/features/dashboard/dashboard.ts`
- `src/app/features/dashboard/dashboard.html`
- `src/app/features/dashboard/dashboard.css`
- `src/app/features/account/account-settings/account-settings.html`
- `src/app/features/account/account-settings/account-settings.css`

## Install
1. Stop the dev server.
2. Extract into the project root:
   `/Users/StephenH/Documents/Programming/fantasy-hockey`
3. Replace the included files.
4. Restart:

```bash
npm start
```

## Recommended test
1. Open Account Settings.
2. Select a favorite team and save.
3. Return to the Dashboard.
4. Confirm the dashboard referee wears that team's colors and crest.
5. Open the League Hub and Cycle page.
6. Confirm outlines and secondary text use the saved favorite-team palette.
7. Refresh and sign back in to verify the theme remains applied.

## Validation
- TypeScript application compilation passed.
- Angular template compilation passed.
- `npm run build` passed.
- The existing non-blocking `cycle-one.css` warning remains below its error threshold.

## Next visual stage
The next focused package should be a mobile-first refinement pass for:
- Dashboard
- League Hub
- Cycle / Matchup
- My Team
- Free Agents
- Draft Room
- Account

That pass should prioritize thumb reach, horizontal overflow removal, readable player cards, compact navigation, and side-by-side comparison behavior appropriate to phone width.
