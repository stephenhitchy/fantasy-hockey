# RinkRat B2D — Automatic Promotion of Authorized Injury Replacements

> **Historical scope:** This document records the narrower B2D release.
> B2F supersedes the current-runtime limits that excluded Day-to-day players
> and allowed automatic promotion only for an exact queued bench swap. Read
> `docs/RINKRAT_PRODUCT_B2F_INSTANT_INJURY_TRANSACTIONS.md` for current
> behavior; the B2D details below remain the historical baseline.

## Purpose

B2D automatically promotes an exact bench swap that the manager already
scheduled when its current starter later becomes authoritatively eligible for
injury replacement. It does not select a replacement, create a new roster
decision, or change the six-game allowance.

The automatic path is limited to **Out**, **IR**, and **LTIR**. Day-to-day,
suspended, personal-leave, and unknown statuses remain ineligible.

## Required saved intent

Automation may act only when all of the following still match the manager's
saved move:

- the pending move belongs to the roster owner and active slot;
- the outgoing asset is still the active skater;
- the source bench slot still contains the exact incoming skater;
- both skaters have the same roster position;
- the move sends the outgoing player to the bench, has no waiver source, and
  uniquely reserves that bench player; and
- an IR slot is open.

Any mismatch fails closed and leaves the queued move untouched. The shared
server transaction then repeats all B1Z checks against current membership,
draft state, replay mode, availability, roster, pick, window, playoff-bank,
schedule, and reservation evidence.

## Timing and recovery

Three independent entry points call the same server-owned transaction:

1. a successful global availability refresh, for ordinary ESPN status
   updates;
2. a league availability override write, for league-specific corrections;
3. a bounded scheduled reconciliation cursor, for moves and injury statuses
   that already existed before deployment or whose event delivery was missed.

The entry points do not run inside scoring or email delivery. One failed
candidate is recorded and remains retryable without blocking another roster
or a scoring pass. Health is stored separately for the global trigger, each
league/player override, and the scheduled backstop so an unrelated later
success cannot erase a failure. The backstop advances its bounded league
cursor even when one page has excess or permanently failing work. A saved
per-page candidate cursor rotates the next attempt through eligible work when
that page returns, so neither the page tail nor later leagues can be starved.

Only a league record whose source is `commissioner` and whose saved league and
player identities match its Firestore path is accepted as an override. Legacy
per-league ESPN documents are ignored; they can never bypass the fresh shared
ESPN report required for unattended mutation.

Each manager-approved move has one deterministic receipt keyed by league,
owner, active slot, and pending-move ID. Retries from any entry point replay
that receipt instead of applying the move twice. The transaction revalidates
the saved reservation immediately before writing. It also compares the
preflight ownership plan with the transaction's latest cycle window and, in
the playoffs, its latest bank window. If scoring marks another outgoing game
live or final during preflight, the attempt aborts and retries from fresh
evidence instead of dropping or reassigning that game. Because no manager is
waiting on an unattended attempt, automation also applies a stricter
transaction-time wall-clock guard to every game whose ownership would change.
If an outgoing or incoming game crosses its verified puck-drop time during
the slow checks—even before scoring records a live state—the attempt aborts
and retries with fresh schedule evidence.

## Competitive result

The outgoing injured player keeps every started game and every earned point.
The selected bench player receives only the still-unstarted remainder of the
same six-game slot. The mixed-player ownership plan and audit evidence are the
same as the manager-triggered B1Z injury-replacement path.

B2D does not modify Scoring V4 values, Projection V11, seventh-game rollover,
started-window immutability, Rules, indexes, TTLs, App Check mode, the scoring
queue, or canonical scoring authority.

## Release and rollback

Release the shared `applyImmediateRosterMove` Function together with the three
automatic entry points. Hosting is also required for the scheduling disclosure
on My Team.

To roll back, restore the prior Hosting release and prior
`applyImmediateRosterMove` revision, then disable or remove only the three B2D
entry points. Completed replacements remain authoritative roster transactions
and must not be reversed automatically.
