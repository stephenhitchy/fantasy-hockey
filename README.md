# Fantasy Hockey Player Card Visual Cleanup V1

## Files replaced

- `src/app/features/cycles/cycle-one/cycle-one.html`
- `src/app/features/cycles/cycle-one/cycle-one.css`

## Changes

- Enlarged NHL/team logos on matchup player cards.
- Enlarged player names.
- Enlarged team abbreviation and position line.
- Shifted six-game markers and cycle status farther left so cards feel less compressed.
- Changed all six-game marker numbers to black for stronger contrast.
- Removed the green `View six-game window` dropdown and its detail panel.
- Preserved full-card click and keyboard navigation to the player detail page.
- Preserved the side-by-side matchup layout and Team A / Both / Team B selector.
- Preserved the My Team / single-team layout, with larger cards in that mode.

## Install

1. Stop the development server.
2. Extract this package into:
   `/Users/StephenH/Documents/Programming/fantasy-hockey`
3. Allow both included files to replace the existing copies.
4. Restart:

```bash
npm start
```

## Validation

- `npm run build` passed.
- The only remaining output is the existing non-blocking `cycle-one.css` warning.
