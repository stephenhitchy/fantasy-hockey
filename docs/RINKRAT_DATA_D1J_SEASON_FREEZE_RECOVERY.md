# RinkRat Data Infrastructure Batch D1J

**Candidate:** RC66 / D1J
**Purpose:** exact-build private-season freeze, evidence binding, and deterministic incident recovery
**Competitive authority:** unchanged
**Production freeze posture:** queued scoring Shadow; canonical authority disabled

## Why this batch exists

D1D through D1I establish the guarded near-live scoring queue, canonical NHL game facts, affected-league routing, phase timing, preseason certification, shadow parity, one canonical-read Canary with direct fallback, the two-strike safety watchdog, and measured capacity evidence.

Those systems reduce technical risk, but a season can still fail operationally when the exact deployed build, browser validation, cohort approval, queue health, certification output, Git tag, and rollback commands are not bound together before managers begin competing.

D1J creates one non-deploying exact-build freeze gate. It refuses to generate a season baseline unless four independently produced evidence files all match the same deployed release:

1. Release Readiness manual and automated validation report;
2. Scoring Queue Control Center season-freeze evidence;
3. Private Season Control Center freeze evidence;
4. deterministic preseason scoring certification report.

The tool also requires successful CI, an explicit rollback rehearsal, production Shadow confirmation, a formal private-season approval, and an explicit freeze acknowledgment.

## Evidence exported from the site

### Scoring Queue Control Center

The new **Copy Season Freeze Evidence** action exports a bounded administrator-only JSON report containing:

- exact bundled release identity;
- Firebase project and environment;
- queue mode and revision;
- retained Canary and Internal Test configuration;
- canonical-authority state;
- season-safety status and alerts;
- safety-watchdog heartbeat, warning streaks, failures, and prior actions;
- measured-capacity status;
- dispatcher heartbeat and status;
- queue admission, pending, enqueue-failure, and stale-recovery evidence;
- completed-Draft scoring-schedule coverage;
- a deterministic ready/blocked freeze gate.

The report intentionally permits preliminary or insufficient capacity evidence as an advisory while production is frozen in Shadow. A capacity refresher error remains blocking. Broader Primary still requires the stricter D1I live sample gates.

### Private Season Control Center

The new **Copy Freeze Evidence** action exports a privacy-limited JSON report containing:

- exact bundled release identity;
- plan revision and status;
- exact approved release/build;
- feature-freeze confirmation and non-goals;
- cohort counts and required experience/device coverage;
- privacy-limited live league evidence;
- support owner, deputy, Known Issues, coverage, and rollback readiness;
- the immutable approved go/no-go decision;
- a deterministic ready/blocked freeze gate.

Tester email addresses, phone numbers, fantasy scores, rosters, player IDs, and raw Firestore documents are not added.

## Local freeze command

Generate the deterministic certification file first:

```bash
npm run certify:preseason-scoring -- \
  --output "$HOME/Downloads/rinkrat-preseason-certification.json"
```

On the deployed exact build:

1. copy the Release Readiness validation report;
2. copy the Scoring Queue Control Center season-freeze evidence;
3. copy the Private Season Control Center freeze evidence;
4. confirm GitHub Actions passed;
5. rehearse the frozen-source rollback;
6. confirm the production queue is Shadow and drained.

Then run:

```bash
RINKRAT_FREEZE_PRIVATE_SEASON=FREEZE \
npm run season:freeze -- \
  --validation-report="$HOME/Downloads/rinkrat-validation.json" \
  --scoring-evidence="$HOME/Downloads/rinkrat-scoring-freeze.json" \
  --private-season-evidence="$HOME/Downloads/rinkrat-private-season-freeze.json" \
  --preseason-certification="$HOME/Downloads/rinkrat-preseason-certification.json" \
  --tag=rinkrat-2026-private-season-baseline \
  --ci-passed \
  --rollback-rehearsed \
  --queue-shadow \
  --private-season-approved \
  --preseason-certified
```

The command performs no Firebase deployment and creates no Git tag. It writes an ignored local kit under:

```text
.season-release/rinkrat-2026-private-season-baseline/
```

## Generated season kit

### `FREEZE_RECORD.json`

Records:

- live build ID and source commit;
- evidence hashes and summaries;
- frozen competitive versions;
- pinned Node/npm versions;
- active TTL count;
- exact Firebase project/Hosting target;
- exact targeted scoring Function selector;
- source hashes for lockfiles, Firebase configuration, Rules, indexes, scoring rules, Projection V11, and the competitive roadmap;
- human confirmations and intended Git tag.

### `ROLLBACK.md`

Provides the frozen-source recovery sequence:

1. preserve evidence;
2. return queued scoring to Shadow when scoring may be involved;
3. avoid manual competitive-data edits;
4. classify the incident;
5. build from the frozen tag;
6. deploy only the source-controlled scoring Function selector;
7. deploy frozen Hosting;
8. verify the live manifest and scoring health.

The plan explicitly prohibits a broad `firebase deploy` during an emergency.

### `INCIDENT_FIRST_15_MINUTES.md`

Separates the opening response into:

- minute 0–3: protect competitive truth;
- minute 3–8: determine scope;
- minute 8–15: choose canonical-only fallback, Shadow, Hosting-only rollback, targeted Function rollback, or reviewed Rules/index recovery.

### `SEASON_LAUNCH_CHECKLIST.md`

Creates the final human checklist for:

- exact release identity;
- CI and verification;
- full-season simulation;
- preseason certification;
- queue/Watchdog/dispatcher health;
- schedule coverage;
- cohort/support approval;
- tag verification;
- noncritical feature freeze.

## Freeze policy

Source-controlled policy lives in:

```text
config/release-freeze/season-freeze-policy.json
config/release-freeze/season-deployment-policy.json
```

The D1J baseline requires:

- 2026–27 private season;
- Release Candidate 65 runtime identity until deliberately advanced;
- Scoring V4;
- Projection V11;
- six NHL games per active player window;
- Node 22.23.1;
- npm 11.17.0;
- ten active TTL policies;
- App Check monitor mode;
- CSP report-only mode;
- production queued scoring Shadow at freeze time;
- zero canonical-authority leagues at freeze time;
- D1J verification;
- the exact targeted cumulative D1I scoring Function list.

Canary selections may remain recorded while the freeze is taken in Shadow. They are an advisory and can be deliberately reactivated after the frozen baseline is recorded.

## Verification and tag lifecycle

Source preflight:

```bash
npm run season:preflight -- --source-only
```

Production preflight:

```bash
npm run season:preflight
```

After reviewing the generated kit, create the annotated tag exactly as printed by the command. The tag deliberately points to the source revision recorded by the live release manifest.

Verify the tag:

```bash
npm run season:verify-tag -- \
  --tag=rinkrat-2026-private-season-baseline
```

Verify that the same build remains live:

```bash
npm run season:verify-freeze -- \
  --tag=rinkrat-2026-private-season-baseline
```

Regenerate recovery documents without changing the record:

```bash
npm run season:incident-kit -- \
  --tag=rinkrat-2026-private-season-baseline
```

## Deployment scope

D1J adds browser evidence-export controls and local non-deploying release tooling. When D1I Functions are already live, D1J itself requires Hosting only:

```bash
firebase deploy --only hosting:app \
  --project nhl-fantasy-app-ab673 \
  -m "D1J exact season freeze evidence controls"
```

When D1I has not yet been deployed, deploy the cumulative D1I Function selector first, then Hosting. D1J requires no Firestore Rule, index, TTL, or data migration deployment.

## Competitive safety boundary

D1J changes no:

- Production Scoring V4 value;
- legacy V3 reconstruction;
- Projection V11 calculation;
- six-game ownership;
- seventh-game rollover;
- Draft, roster, waiver, IR, transaction, standings, or playoff authority;
- queue worker or admission ceiling;
- App Check enforcement state;
- Firestore Rule;
- Firestore index;
- TTL policy;
- automatic Primary promotion.

The freeze is a release-safety layer. It does not replace live Canary proof, real support coverage, or the first-season stop-the-line policy.
