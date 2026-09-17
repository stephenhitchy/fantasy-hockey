# FF1.40 — First Draft-night Usability Repair

Status: source implementation, focused regression coverage, the complete
inherited release gate, both builds, and final local diff review are complete.
The clean candidate commit, independent review, exact staging deployment,
authenticated visual evidence, and Production release remain open.

## Observed problem

The first real family-and-friends Draft exposed six narrow usability problems:

- mobile status and upcoming-pick cards truncated fantasy-team names;
- completed picks did not retain the fantasy team that selected the asset;
- the live page repeated healthy connection/readiness information;
- the player-pool toolbar used a visually disconnected light surface;
- managers needed an explicit regression guarantee that two missed turns, not
  three, activates forced Auto-Draft;
- automatic bench completion could select a second Team Goalie Unit even
  though only one goalie starter is required.

The separate league-size-aware ranking request remains a decision-bound
competitive slice. Projection V11 already receives team count, computes
position replacement depth from `3 LW / 3 C / 3 RW / 4 D / 1 G` per team, and
uses a goalie starter-slot curve. The unresolved decision is whether the
revised no-bench-goalie scarcity order should affect only the visible Draft
Room board or also the authoritative server Auto-Draft order. FF1.40 does not
change ranking formulas, hashes, or snapshot identity.

## Narrow repair

- Replace the large upcoming-pick hourglass with the existing accessible
  manager avatar and allow fantasy-team names to occupy two lines.
- Preserve fantasy-team ownership beneath every completed-pick asset name.
- Give the mobile live status bar two primary columns and move its action to a
  full-width second row so the clock and button cannot squeeze the team name.
- Hide healthy connection and successful injury-refresh banners; retain
  visible running, error, offline, reconnect, retry, and stale-tab states.
- Compact the live mobile heading while retaining the league name and
  Auto-Draft control.
- Restyle the search/position/sort surface with semantic theme tokens so it
  remains coherent in Rink Dark, OLED Black, Ice Gray, and Light Ice.
- Preserve the existing server rule that the second consecutive clock expiry
  activates forced Auto-Draft and add explicit source regression coverage.
- Change only automatic bench selection from one forward, one defenseman, and
  one goalie unit to two forwards, one defenseman, and zero goalie units.
  Manual Draft choices remain unchanged; the single starting goalie slot is
  still filled before any automatic bench pick.

## Acceptance and edge cases

- Long fantasy-team names remain identifiable at 320, 390, 430, and desktop
  widths without reducing accessible text.
- Recent picks show player/goalie identity, selecting fantasy team, position,
  and NHL identity.
- Offline, reconnecting, injury-refresh-running, and error states remain
  visible and actionable.
- A manager's second expired turn sets `autoDraftEnabled`,
  `autoDraftActivatedByTimeout`, and the capped expiration count of two.
- Server queue and ranking fallback both skip a bench goalie and select the
  next legal forward or defenseman.
- Automatic bench completion permits at most two forward roles and one
  defense role. It cannot consume a second Team Goalie Unit.
- Existing Drafts, completed picks, rosters, identities, six-game windows,
  and Projection V11 snapshots are not rewritten.

## Exact deployment boundary and rollback

After a clean merge and exact staging review, deploy only:

1. `functions:processDraftClockDeadline`
2. `functions:runScheduledDraftAutomation`
3. `functions:continueServerDraftAutomation`
4. `functions:processAutoDraftQueueChange`
5. site-pinned `hosting:app`

The four Functions are the automatic-pick consumers in
`draft-automation.ts`; no callable, Rule, index, TTL, queue configuration, or
projection worker belongs to this release.

Rollback the Hosting release first for the presentation changes, then restore
the preceding revisions of the four automatic-pick consumers in reverse
producer/consumer order. Preserve any staging Draft, pick, queue, and roster
evidence collected during validation.

## Protected contracts

Production Scoring V4, Projection V11 formulas and hashes, six-game ownership,
Game 7 rollover, immutable started windows, manual Draft authority, add/drop,
waiver, Injured Reserve, transactions, standings, playoffs, Rules, indexes,
TTLs, App Check mode, scoring/canonical queue modes, and Function/queue limits
remain unchanged. The only competitive behavior change is the bounded server
Auto-Draft bench composition described above.
