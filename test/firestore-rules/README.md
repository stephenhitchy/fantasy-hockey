# RinkRat Firestore security tests

These tests run only against Firebase's local Auth and Firestore emulators. The command uses the demo project ID `demo-rinkrat-rules`, so it cannot write to the production project.

Run:

```bash
npm run test:rules
```

Batch 3 currently contains **32 Firestore Emulator tests**.

Tests labeled **`[baseline exposure]`** intentionally prove that a risky browser permission still exists in an area scheduled for a later security batch. They are not approvals of that behavior. Each later batch changes the relevant rule or client flow and then flips the test from `expectAllowed` to `expectDenied`.

Tests labeled **`[temporary Batch 4 dependency]`** preserve a narrowly documented commissioner browser path that Batch 4 will move behind server authority. Batch 3 removes the former temporary manual-draft exception: draft setup, clock progression, picks, roster placement during a pick, and automatic selections are now server-owned.

Covered identities:

- commissioner
- manager
- opponent manager
- signed-in league outsider
- signed-out browser

Covered areas:

- user profiles
- league/member/team reads
- roster reads and direct-write denials
- draft setup, clock state, picks, frozen projection data, and queue privacy
- owner-only queue edits and denial of commissioner queue tampering
- transaction and waiver reads plus direct manager write denials
- cycles, matchups, roster picks, team windows, and playoffs
- live-scoring authority
- global and league availability data

The pure server draft-selection tests are separate:

```bash
npm run test:draft-authority
```

They cover snake order, live-team/order consistency, starter-first auto-drafting, queue fallback, bench-role diversity, goalie reserve protection, and authoritative roster placement.
