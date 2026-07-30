# RinkRat Firestore security tests

These tests run only against Firebase's local Auth and Firestore emulators. The command uses the demo project id `demo-rinkrat-rules`, so it cannot write to the production project.

Run:

```bash
npm run test:rules
```

Tests labeled **`[baseline exposure]`** intentionally prove that a risky browser permission still exists in the current rules. They are not approvals of that behavior. Each later security batch should change the relevant rule or client flow and then flip the corresponding test from `expectAllowed` to `expectDenied`.

Covered identities:

- commissioner
- manager
- opponent manager
- signed-in league outsider
- signed-out browser

Covered areas:

- user profiles
- league/member/team reads
- rosters
- draft state, picks, and queues
- transactions and waivers
- cycles, matchups, roster picks, team windows, and playoffs
- live-scoring authority
- global and league availability data
