# Favorite Team Theme V2 — Implementation Report

## Design goal

The previous theme allowed a manager's NHL team colors to spread into page backgrounds,
large gradients, cards, and text. That looked dramatic for some teams, but combinations
with very dark, bright, or low-contrast colors could become tiring or difficult to read.

Theme V2 separates **application readability** from **team identity**:

- A consistent, neutral dark canvas is used on every page.
- Neutral surfaces and neutral body text remain readable regardless of selected team.
- Team primary, secondary, and tertiary colors are used as solid identity accents.
- No team-color blends are required for major UI surfaces.
- Black or white foreground text is selected automatically from measured contrast.

## Theme tokens

The shared theme now exposes:

- `--user-team-primary`
- `--user-team-secondary`
- `--user-team-tertiary`
- `--user-team-accent`
- `--user-team-on-primary`
- `--user-team-on-secondary`
- `--user-team-on-tertiary`
- subtle alpha tokens for small glows and washes

Older aliases remain available so pages not redesigned yet continue to inherit the new
rules without breaking.

## Global visual behavior

Team colors are now concentrated in:

- primary action buttons
- selected controls
- active navigation indicators
- thin identity rails and card-top accents
- focus rings
- mascot uniforms
- team-selection tiles
- manager identity chips on matchup pages

Team colors no longer control normal paragraph text, muted text, or whole-card backgrounds.

## Registration update

New profile creation now requires an NHL favorite-team selection. The selector:

- displays all 32 teams with logos and abbreviations
- previews the selected theme immediately
- does not overwrite the remembered login theme before registration succeeds
- stores the selected abbreviation in the new Firestore user profile

Normal sign-in remains unchanged.

## Shared page coverage

The following shared/high-visibility areas were updated now:

- global application canvas and shared components
- desktop and mobile navigation
- login/profile creation
- dashboard
- account settings
- league detail shared controls
- cycle matchup manager themes

Other feature pages inherit the new neutral surfaces and shared team variables. They can be
fine-tuned individually later without another theme architecture migration.

## Compatibility

- Existing `highlightColor` consumers remain supported through a legacy alias.
- Existing profiles that do not contain a favorite team still fall back to Vegas.
- Existing profile editing continues to update Firestore and the live theme.
- No Firestore schema or rules change is required.
- No Functions change is required.

## Validation completed

- 32 unique NHL palette entries checked.
- Automatic black/white foreground selection checked against every team color.
- All selected foreground combinations met the package's 4.5:1 contrast target.
- All application TypeScript files passed syntax transpilation.
- All CSS files passed structural parsing.
- All Angular HTML templates passed structural parsing and interpolation-balance checks.

A full Angular production build could not be completed in the packaging sandbox because
the npm gateway repeatedly returned a service-unavailable response. The local build command
in `TEAM_THEME_V2_INSTALL.txt` is therefore required before deployment.
