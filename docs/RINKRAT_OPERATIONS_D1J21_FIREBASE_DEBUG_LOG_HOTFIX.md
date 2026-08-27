# RinkRat Operations Hotfix D1J.2.1

**Purpose:** prevent Firebase CLI and Emulator Suite debug logs from making an otherwise reproducible deployment appear dirty.

## Problem

Firebase can create `firebase-debug.log`, `firestore-debug.log`, and related root-level `*-debug.log` files before or during predeploy checks. An older repository state also tracked `firestore-debug.log`. D1J.2 correctly blocked dirty source, but these generated logs created a self-blocking loop and caused the release manifest to carry a `-dirty` suffix.

## Fix

- Ignore root Firebase/Emulator debug logs with `/*-debug.log` and `/*-debug.*.log`.
- Make repository-automation recovery restore those ignore rules if they are removed.
- Require a one-time `git rm --cached` for any debug log inherited as a tracked file.
- Keep the clean-source guard strict for real source, configuration, and documentation changes.

## Safety

The hotfix changes no scoring, projections, roster authority, Firestore Rules, indexes, TTLs, queue modes, worker ceilings, or Firebase runtime code. No Firebase resource deployment is required for this local release-tooling fix beyond the original D1J.2 targeted deployment after a clean rebuild.
