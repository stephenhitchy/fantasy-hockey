# Batch 6B.2 — Game Center Hierarchy Rollback Test Checklist

This update restores the approved Batch 6A.1 Game Center appearance while retaining the structural component refactor.

## Automated verification

Run:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm run verify:batch6b-rollback
```

The command should complete with:

- Firestore rules tests passing
- Draft-authority tests passing
- League-onboarding tests passing
- Competition-authority tests passing
- Profile/injury-authority tests passing
- Game Center structural-refactor tests passing
- Game Center rollback tests passing
- Angular production build completing
- Functions TypeScript build completing

Do not deploy if any test or build fails.

## Manual Game Center checks

Use the same started league used for Batch 6A and Batch 6B testing.

1. Open Game Center on desktop.
2. Confirm the large Batch 6B lead/trail/tie overview is gone.
3. Confirm the matchup card begins with the original matchup heading and status badges.
4. Confirm each team still has its original Roster Progress bar with played and left totals.
5. Confirm scores, projections, game markers, lineups, bench cards, and completed-matchup details still appear.
6. Switch among Team A, Both, and Team B views and verify the correct roster appears.
7. Resize to approximately 390 pixels wide.
8. Confirm the sticky mobile scorebar has returned to the simpler score, projection, cycle, and status layout.
9. Confirm there is no duplicated matchup progress information.
10. Verify dark and light themes remain readable.
11. Open player details and bench cards.
12. Confirm there are no new red browser-console errors.

## Deployment

This update is frontend-only:

```bash
firebase deploy --only hosting:app -m "Restore original Game Center hierarchy"
```

After deployment, hard-refresh with Command + Shift + R.
