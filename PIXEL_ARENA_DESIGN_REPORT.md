# Pixel Arena Shared Design System

## Goal

Carry the dashboard's strongest visual concepts across the authenticated application without redesigning every feature page independently.

## Shared visual language

- Neutral blue rink background with a subtle square grid.
- Square card, panel, button, field, chip, badge, and navigation borders.
- Primary team color on the top edge of shared panels.
- Secondary team color on the left edge.
- Tertiary team color on the bottom edge.
- Pixel-offset shadows instead of soft rounded floating cards.
- Three-color title markers beneath page headings.
- Animated three-color rails in the navbar and at the top of every authenticated page.

## Motion system

Motion is intentionally concentrated in a few places rather than applied to every card:

1. A short page-entry reveal when changing routes.
2. A moving pixel highlight along each major page header.
3. A slow pulse on active navigation, selected tabs, and active controls.
4. Pixel-button hover and pressed states.
5. Animated primary/secondary/tertiary rails across the page and navigation.

The existing reduced-motion setting disables these animations automatically.

## Mobile behavior

- Shadows are reduced on narrow screens.
- The title marker becomes smaller.
- No layout width is added to cards or controls.
- The animated accents use CSS only and do not add images or JavaScript work.

## Files changed

- `src/styles.css`
- `src/app/layouts/main-layout/main-layout.css`
- `src/app/shared/navbar/navbar.css`

No Angular logic, Firebase Functions, Firestore rules, or indexes changed.
