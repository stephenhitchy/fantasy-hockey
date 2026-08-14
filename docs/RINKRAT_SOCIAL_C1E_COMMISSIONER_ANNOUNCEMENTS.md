# Social Batch C1E — Commissioner Announcements

**Runtime release:** Release Candidate 31

**Competitive models:** Production Scoring V3 and Projection V11

**Primary product surface:** League HQ → League Wire

## Purpose

C1E gives a league commissioner one small, trustworthy place to communicate with every manager without introducing full chat. A commissioner can post a plain-text title and message to League Wire and may optionally replace the league's single pinned announcement.

The feature is deliberately bounded. It does not add replies, images, GIFs, attachments, direct messages, reactions, notification fanout, moderation queues, or a separate social page.

## Authority and privacy contract

Publishing and unpinning use two callable Cloud Functions:

```text
publishLeagueAnnouncement
unpinLeagueAnnouncement
```

The server requires:

- an authenticated manager;
- a verified email address;
- a valid league identifier;
- the caller to match the league's live `commissionerId` inside the transaction;
- a valid bounded title and body;
- a deterministic request identifier for idempotent retry.

Browser clients cannot create, update, or delete League Wire documents. The existing member-only Firestore rule continues to govern announcement reads, so C1E needs no Firestore Rules or index deployment.

## Content limits

Announcements are plain text only:

```text
Title: 1–72 characters
Message: 1–500 characters
Message lines: no more than 8
```

Control characters and invisible zero-width formatting are removed. Repeated spaces are normalized. Angular renders the content through ordinary interpolation rather than HTML, so markup is never executed.

The server applies a short 10-second league-level posting interval to prevent rapid accidental duplicates. A retry with the same request identifier and same content is idempotent. Reusing that identifier for different content fails closed.

## Storage design

Every successful post creates one immutable activity document:

```text
leagues/{leagueId}/activity/{hashedActivityId}
```

The raw request identifier is never stored in the document ID. The activity contains only the commissioner owner ID, sanitized title/body, timestamps, deterministic fingerprints, and authority/release markers.

When pinning is selected, the server also replaces this exact snapshot:

```text
leagues/{leagueId}/activity/pinned-announcement
```

The pin deliberately uses `announcementOccurredAt` rather than the normal feed field `occurredAt`. Firestore's existing ordered 40-item activity query therefore does not return the pin snapshot, while one exact-document listener can display it above the feed. This prevents duplicate rendering and adds no unbounded query.

Unpinning deletes only `pinned-announcement`. The original immutable announcement remains in League Wire history.

A server-only rate-control document is maintained at:

```text
leagues/{leagueId}/activityControls/announcements
```

The Firestore catch-all denies browser access to that internal document.

## Mobile experience

The commissioner composer opens inline inside League Wire. It adds no modal, fuzzy backdrop, bottom sheet, fixed panel, or sticky controls. It includes:

- title and message fields;
- character and line counters;
- one optional pin checkbox;
- Post and Cancel actions;
- compact success/error feedback.

Managers see the current pin first, followed by the existing five-item collapsed feed. The ordinary feed remains capped at 40 documents. The pinned announcement uses readable interface typography and preserves intentional line breaks.

## Preserved systems

C1E does not change:

- Production Scoring V3;
- Projection V11;
- independent immutable six-game roster-slot windows;
- seventh-game rollover;
- server-authoritative Draft, roster, scoring, and waiver actions;
- App Check Monitor mode;
- exact-league/callable canary controls;
- scoring queue Shadow mode;
- shared NHL cache Shadow mode or authoritative-read setting;
- transaction and waiver privacy;
- Firestore Rules, indexes, or TTL policies.

## One automated verification gate

After manually replacing the project files:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batchc1e && echo "C1E VERIFICATION PASSED"
```

The release is eligible to continue only when the final line appears.

## Targeted deployment

After verification, cleanup, commit, push, and a fresh browser build, deploy only the two callables and Hosting:

```bash
firebase deploy \
  --only functions:publishLeagueAnnouncement,functions:unpinLeagueAnnouncement \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1E commissioner announcements"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1E Release Candidate 31"
```

Do not deploy Firestore Rules, indexes, TTL configuration, scoring queue configuration, App Check enforcement, or NHL-cache authority for C1E.

## Site-first smoke test

Use one disposable Internal Test league.

1. As commissioner, open League Wire and post a short announcement without pinning.
2. Confirm exactly one Announcement item appears with the right title, body, identity, and time.
3. Refresh League HQ and confirm it does not duplicate.
4. Post a second announcement with **Pin at the top** selected.
5. Confirm the new pin appears above the feed and its normal history entry appears only once below.
6. Sign in as an ordinary manager and confirm the pin and history are readable but the composer and Unpin control are absent.
7. Return as commissioner and unpin it.
8. Confirm the pin disappears while the original history entry remains.
9. Check a narrow phone viewport: the composer, counters, pin, feed, and Show earlier updates control must remain readable and scroll normally.

When this visible flow passes, no TTL, NHL-cache, global Function-list, or routine log inspection is required.

## Fallback diagnostic

Only when publishing or unpinning fails on the site:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueAnnouncement,unpinLeagueAnnouncement
```

## Rollback

C1E is additive and uses the existing activity read rule. A Hosting rollback removes the composer and pin presentation, while existing announcement documents remain harmless member-only activity records. If the callable behavior itself is defective, restore the previous Functions revision for the two named callables. No Rules rollback or data migration is required.
