# RinkRat Firestore security tests

These tests run only against Firebase's local Auth and Firestore emulators. The command uses the demo project id `demo-rinkrat-rules`, so it cannot write to the production project.

Run:

```bash
npm run test:rules
```

Tests labeled **`[baseline exposure]`** intentionally prove that a risky browser permission still exists in the current rules. They are not approvals of that behavior. Each later security batch should change the relevant rule or client flow and then flip the corresponding test from `expectAllowed` to `expectDenied`.

Tests labeled **`[temporary Batch 3 dependency]`** or **`[temporary Batch 4 dependency]`** preserve a narrowly documented legacy browser path that a later server-authority batch will remove. Batch 2 now denies ordinary manager roster, transaction, waiver, and waiver-claim writes outside those explicit transition paths.

Covered identities:

- commissioner
- manager
- opponent manager
- signed-in league outsider
- signed-out browser

Covered areas:

- user profiles
- league/member/team reads
- roster reads, direct-write denials, roster creation denials, and the temporary manual-draft transition
- draft state, picks, and queues
- transaction and waiver reads plus direct manager write denials
- cycles, matchups, roster picks, team windows, and playoffs
- live-scoring authority
- global and league availability data
