# RinkRat B2F — Instant Injury Transactions

Date: 2026-10-09

## Purpose

B2F makes roster timing match the manager's actual transaction while
preserving the six-game competitive contract. A free agent replacing a bench
player remains an immediate ownership-only move. An active skater who is
authoritatively **Day-to-day**, **Out**, **IR**, or **LTIR** may also be
replaced immediately, without waiting for the next matchup.

B2F supersedes B2D's current-runtime limits that excluded Day-to-day players
and allowed unattended promotion only for an exact queued bench swap. The B2D
document remains the historical record of that narrower release.

## Timing and destination contract

| Manager intent | Timing | Outgoing destination |
| --- | --- | --- |
| Free agent replaces a bench player | Immediate ownership-only change | Waivers |
| Bench player fills a genuinely open active slot | Immediate when the open window and incoming player remain eligible | Not applicable |
| Bench player replaces a Day-to-day/Out/IR/LTIR active skater | Immediate mixed-player window | Bench |
| Free agent replaces a Day-to-day/Out/IR/LTIR active skater | Immediate mixed-player window | Waivers |
| Bench player or free agent replaces a healthy/available active skater | Queued for the next legal matchup window | The manager's selected bench/waiver destination at that boundary |

An injury does not create extra games or erase a result. Every NHL game that
has reached puck drop stays with the player who owned it, together with all
points already earned. Only the still-unstarted remainder of that slot's
six-game window transfers to the incoming player. The saved mixed-player plan
continues to identify the exact player and source team for every owned game.

The destination is part of the manager's intent. An active/bench swap moves
the injured starter to the selected bench slot; it does not silently consume
an IR slot. A direct free-agent add/drop sends the injured starter to waivers;
it does not retain that player on the roster.

## Server authority and retry safety

The browser may explain the likely timing, but the Function owns the decision.
Before committing an immediate injury transaction, server authority verifies
the current roster and ownership, same-position eligibility, incoming-player
availability, authoritative injury status, exact NHL schedules, and each
relevant puck-drop boundary. Status and competitive state are reread in the
committing transaction. Missing or conflicting evidence fails closed.

A queued transaction may be promoted only when its exact manager-authorized
identity still matches: owner, active slot, outgoing player, incoming player,
destination, pending-move ID, and pending-move fingerprint. Bench-swap and
free-agent queues use distinct exact shapes. Deterministic private receipts
make global-status triggers, league-override triggers, the scheduled recovery
sweep, browser retries, and ambiguous transport recovery idempotent. No path
may select a replacement for the manager or promote a different reservation.

Read-only Production evidence identified the held Genitalman transaction as
the exact queued active/bench swap from C-1 Celebrini to B-1 and B-1 Leo
Carlsson to C-1. After the B2F Functions are deployed, the bounded recovery
sweep can self-promote that existing queue without another manager action,
provided its exact saved fingerprint, roster ownership, authoritative injury
status, schedule, and puck-drop checks still pass.

## Unchanged contracts

B2F does not change Scoring V4 values, Projection V11, the six-game allowance,
seventh-game rollover, started-game ownership, Rules, indexes, TTLs, App Check
mode, scoring queue mode, worker limits, or canonical scoring authority. It
changes roster transaction authority only for the explicitly described
injury-eligible timing and destination cases.

## Release and rollback

Deploy the activity publisher first. It is a create-only transaction trigger,
so it cannot backfill a transaction that an older revision ignored:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "functions:publishLeagueTransactionActivity"
```

Then deploy the five private operations readers/writers that classify the new
transaction types:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "functions:getPrivateSeasonHealthDashboard,functions:updatePrivateSeasonWeeklyHealth,functions:getPrivateSeasonResearch,functions:submitPrivateSeasonResearch,functions:getPrivateSeasonResearchDashboard"
```

Then deploy the four roster mutation and automatic-promotion Functions
together, followed by Hosting:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "functions:applyImmediateRosterMove,functions:processGlobalAutomaticInjuryReplacements,functions:processLeagueAutomaticInjuryReplacement,functions:reconcileAutomaticInjuryReplacements"
firebase deploy --project nhl-fantasy-app-ab673 --only "hosting:app"
```

`applyImmediateRosterMove` owns the manager-triggered mixed-player transaction
and exact receipt. The global and league availability triggers must recognize
the expanded exact pending intents, and `reconcileAutomaticInjuryReplacements`
is the bounded backstop that can recover a preexisting queue such as the
Genitalman transaction. Hosting is separate because My Team and Free Agents
must send and explain the new injury-specific intent only after the server can
accept it. `executeSecureRosterAction` is not in the selector because B2F does
not change that export.

For rollback, restore the preceding Hosting release first so browsers stop
sending B2F-only intent, then restore the prior revisions of the four mutation
and automation Functions together. Keep the forward-compatible activity
publisher live until every in-flight creator invocation has finished; the
automatic Functions have a 540-second timeout, so wait longer than nine
minutes after restoring them before reverting the publisher. The five private
operations Functions may then be restored with the publisher if a full
rollback is required. Do not reverse completed roster transactions, delete
private receipts, or remove saved mixed-player ownership plans; completed
moves and their retained game ownership remain authoritative.
