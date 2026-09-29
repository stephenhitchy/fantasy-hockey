# Batch B1O — Approved RinkRat Brand Refresh

## Scope

This is a **Hosting-only** brand-asset and presentation change. It replaces the
retired pixel mascot in site-owned branding surfaces without altering the
application palette, fantasy-team themes, manager avatars, NHL logos, page
hierarchy, or any competitive behavior.

## Approved assets

- `rinkrat-colored-mascot.png` is the untouched approved source for normal
  standalone branding. `rinkrat-colored-mascot-512.png` is its proportional
  runtime export.
- `rinkrat-full-logo.png` is the untouched approved horizontal source.
  `rinkrat-full-logo-1024.png` is its proportional authentication-page export.
- `rinkrat-minimalist-icon.png` is the untouched small-icon source. It produces
  the 32-pixel PNG favicon, ICO favicon, and internal 128-pixel favicon asset.
- Apple and Android installed-app icons use proportional, centered exports of
  the colored mascot with safe transparent padding. The horizontal logo is
  never stretched into an app icon.

The source files are preserved byte-for-byte. Runtime exports resize the
approved pixels without redrawing, recoloring, filtering, or substituting the
artwork.

## Placement

- Shared desktop and mobile headers use the colored mascot while preserving
  the existing dashboard/home link and adjacent `RinkRat Fantasy` text.
- The sign-in, registration, recovery, and welcome hero uses the horizontal
  logo because that existing region can keep the full subtitle readable.
- Email verification, invitation recovery, Training Camp, Coach help, neutral
  RinkRat identity, offline, loading, and empty-state branding use the colored
  mascot.
- Dashboard content order is unchanged and no decorative brand banner was
  added.
- Browser favicons use the minimalist mark. Installed-app and Apple touch icons
  use the padded colored mascot.
- The high-resolution source artworks are not precached by the service worker;
  only the runtime-sized branding required by the shell is downloaded eagerly.

## Competitive boundaries

Production Scoring V4, Projection V11, six-game windows, seventh-game
rollover, Draft authority, roster and waiver authority, Firestore Rules,
indexes, TTLs, App Check, queue modes, worker limits, and canonical scoring
authority are unchanged.

## Release and rollback

If approved after verification, the only Firebase selector is `hosting:app`.
Rollback is a Git revert of the B1O commit followed by a clean Hosting rebuild
and targeted Hosting release, or restoration of the previous Firebase Hosting
version. No Function, Rule, index, TTL, migration, queue, or production-data
operation is part of B1O.
