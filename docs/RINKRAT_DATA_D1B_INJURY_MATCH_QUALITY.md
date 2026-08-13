# RinkRat Data Quality Batch D1B — Injury Identity Match Quality

**Runtime:** Release Candidate 26  
**Competitive models:** Scoring V3 · Projection V11  
**Primary roadmap tasks:** D1.11 and D1.18

## Purpose

The shared ESPN injury refresh previously reported only a total number of names that could not be matched to the current NHL roster feed. That was honest, but it did not explain whether a name was absent, ambiguous, intentionally ignored, or safely matched despite a team or position difference.

D1B turns that count into a bounded, categorized match-quality report. The refresh never guesses and still refuses to attach an uncertain identity. A source entry affects player availability only after one exact current-roster identity or one reviewed source-controlled alias resolves it.

## Match categories

### No exact roster name

The normalized ESPN name did not exactly match any current NHL skater identity. RinkRat leaves the entry unresolved and may show up to three roster-context suggestions based on surname, team, position, and first initial. Suggestions are informational and are never applied automatically.

### Ambiguous roster identity

More than one current NHL skater shares the normalized identity, and ESPN team or position context did not safely reduce the candidates to one.

### Alias needs maintenance

A reviewed source-controlled alias exists, but the canonical NHL player ID is no longer present in the current roster feed. RinkRat blocks the alias rather than attaching the injury to another player.

### Matched · team differs

The identity matched safely, but ESPN and the current NHL roster feed list different teams. The match remains valid because public feeds may update trades or assignments at different times. The discrepancy is preserved as an advisory.

### Matched · position differs

The identity matched safely, but ESPN and the current NHL roster feed list different primary positions. The discrepancy is visible without changing RinkRat roster eligibility or Projection V11.

### Individual goalie entry intentionally ignored

RinkRat drafts one Team Goalie Unit rather than individual goalies. ESPN goalie injuries are counted separately and never treated as unresolved skater identities.

## Source-controlled alias registry

Verified exceptions live in:

```text
functions/src/shared/core/player/injury-player-aliases.ts
```

An alias may contain:

```ts
{
  sourceName: 'Verified ESPN Name',
  sourceTeamAbbreviation: 'NHL', // optional
  playerId: 1234567,
  note: 'Verified against the current NHL roster feed.',
}
```

Rules:

1. Never add a placeholder or guessed NHL player ID.
2. Verify the ESPN public name, current NHL player ID, and current roster identity.
3. Prefer a team-specific alias when one source name could be ambiguous.
4. Keep the note short and factual.
5. Run the complete D1B verification chain before deployment.
6. Remove or update an alias when the Injury Match Quality panel reports that its target is missing.

## Stored match-quality record

A successful global injury refresh writes one bounded `matchQuality` object to:

```text
appData/playerAvailability
appData/injuryAutomation
```

The object contains:

- source entry count;
- matched skater count;
- unresolved skater count;
- matched advisory count;
- alias-resolved count;
- intentionally ignored goalie count;
- category totals;
- at most 60 categorized issue records;
- at most three bounded candidate suggestions per unresolved record.

The record contains public athlete identity context only. It does not contain manager IDs, league IDs, rosters, scores, invite codes, email addresses, raw Firestore documents, or raw request bodies.

## Commissioner interface

Open:

```text
League Home
→ Player Availability
→ Injury Match Quality
```

The panel shows:

- matched skaters;
- unresolved skaters;
- verified alias matches;
- individual goalies intentionally ignored;
- unresolved identity cards with category explanations;
- bounded current-roster suggestions;
- matched team or position advisories.

Candidate suggestions do not change player availability. Commissioner overrides remain league-specific and continue to take priority over the shared report.

## Release Readiness

Release Readiness adds a non-blocking check named:

```text
Shared injury identity coverage
```

A successful refresh with no unresolved skaters passes. Categorized unresolved skaters produce an advisory rather than a launch failure because the shared report still refuses to attach those injuries to an uncertain identity.

## Competitive safety

D1B does not change:

- Scoring V3;
- Projection V11 calculations or rankings;
- NHL player eligibility;
- Draft order, queue, timers, or Auto-Draft;
- six-game roster-slot windows;
- add/drop, waiver, lineup, or Injured Reserve timing;
- team goalie-unit scoring;
- historical replay;
- App Check enforcement or canary routing;
- scoring queue mode;
- Firestore Rules, indexes, TTL, PITR, or backup schedules.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1
npm install -g npm@11.17.0

npm ci
npm --prefix functions ci

npm run verify:batchd1b
```

## Deployment

Functions must be deployed because the global injury matcher and stored diagnostics changed:

```bash
firebase use nhl-fantasy-app-ab673

firebase deploy --only functions \
  -m "Data D1B injury identity match quality"
```

Then deploy Hosting for the commissioner panel, Release Readiness check, and RC26 release identity:

```bash
firebase deploy --only hosting:app \
  -m "Data D1B Release Candidate 26"
```

Do not deploy Firestore Rules, indexes, TTL, PITR, or backup schedules.

## Post-deployment validation

1. Open one commissioner Player Availability page.
2. Press **Check Today’s Report**.
3. Confirm the refresh message distinguishes unresolved skaters from intentionally ignored goalies.
4. Expand **Injury Match Quality**.
5. Confirm every unresolved skater has a category.
6. Confirm candidate suggestions do not create or change an availability record.
7. Confirm matched team or position discrepancies are advisory only.
8. Confirm an individual goalie entry is counted as ignored rather than unresolved.
9. Open Release Readiness and confirm **Shared injury identity coverage** appears.
10. Confirm the shared injury report still updates Draft Room, Free Agents, Waivers, My Team, and IR eligibility normally.
11. Confirm Scoring V3 and Projection V11 remain unchanged.
12. Confirm App Check remains in Monitor, the callable canary remains inactive, and scoring remains in Shadow.

## Rollback

D1B adds only match diagnostics, a source-controlled alias registry, and a read-only interface. To roll back, deploy the prior known-good Functions and Hosting release. Existing `matchQuality` fields are ignored by older clients and do not require data cleanup.
