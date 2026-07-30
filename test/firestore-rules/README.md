# RinkRat Firestore security tests

These tests run only against Firebase's local Auth and Firestore emulators. The command uses the demo project ID `demo-rinkrat-rules`, so it cannot write to the production project.

Run:

```bash
npm run test:rules
```

Batch 5 contains **44 Firestore Emulator tests**.

Covered identities:

- commissioner
- manager
- opponent manager
- signed-in league outsider
- signed-out browser

Covered areas:

- owner-only private user profiles
- display-safe public manager profiles without email or private preferences
- league/member/team reads
- safe team-identity edits and direct standings-write denials
- roster reads and direct-write denials for every browser role
- draft setup, clock state, picks, frozen projection data, and queue privacy
- owner-only queue edits and denial of commissioner queue tampering
- immutable transaction records and server-owned waivers
- server-owned cycles, matchups, roster picks, team windows, playoffs, and playoff banks
- the narrow projection-accuracy analytics marker that remains client-compatible
- live-scoring authority
- server-only global ESPN injury data
- league-scoped commissioner availability overrides

Additional Batch 5 browser/server boundary checks run with:

```bash
npm run test:profile-injury-authority:run
```

The pure server draft-selection tests remain separate:

```bash
npm run test:draft-authority
```
