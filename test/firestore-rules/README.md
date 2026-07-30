# RinkRat Firestore security tests

These tests run only against Firebase's local Auth and Firestore emulators. The command uses the demo project ID `demo-rinkrat-rules`, so it cannot write to the production project.

Run:

```bash
npm run test:rules
```

Batch 4 contains **40 Firestore Emulator tests**.

Tests labeled **`[baseline exposure]`** intentionally document risky permissions scheduled for later batches. Batch 4 closes the former commissioner browser exceptions for rosters, transactions, waivers, standings, cycles, matchups, roster snapshots, team windows, playoff brackets, and playoff window banks.

Covered identities:

- commissioner
- manager
- opponent manager
- signed-in league outsider
- signed-out browser

Covered areas:

- user profiles
- league/member/team reads
- safe team-identity edits and direct standings-write denials
- roster reads and direct-write denials for every browser role
- draft setup, clock state, picks, frozen projection data, and queue privacy
- owner-only queue edits and denial of commissioner queue tampering
- immutable transaction records and server-owned waivers
- server-owned cycles, matchups, roster picks, team windows, playoffs, and playoff banks
- the narrow projection-accuracy analytics marker that remains client-compatible
- live-scoring authority
- global and league availability data

Additional Batch 4 browser/server boundary checks run with:

```bash
npm run test:competition-authority:run
```

The pure server draft-selection tests remain separate:

```bash
npm run test:draft-authority
```
