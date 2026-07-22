# Injury Refresh / Firestore Recovery Fix

## Root cause

The shared injury report was refreshed from the commissioner browser. Before fetching NHL/ESPN data, the client wrote `status: running` to `/appData/playerAvailability` with a ten-minute lease. If Safari or the current network interrupted Firestore's WebChannel, the refresh could stop before writing `success` or `error`. The UI treated any saved `running` status as active forever and continued showing `Updating injury report...`.

## Changes

- Force Firestore long polling to avoid relying on one continuously open Safari/WebChannel response.
- Retry the shared injury-report listener with exponential backoff.
- Keep the last in-memory/cached report when the realtime listener disconnects.
- Stop draft startup from waiting forever for the first listener snapshot.
- Fall back to a one-time Firestore read after eight seconds.
- Treat a refresh with no progress for 90 seconds as interrupted, regardless of its original ten-minute lease.
- Allow a new browser attempt to reclaim a stale refresh after 90 seconds.
- Add explicit timeouts for:
  - Firestore listener initialization
  - Firestore refresh-lock transactions
  - NHL roster loading
  - ESPN injury loading
  - final Firestore success/error writes
- Abort the ESPN request when it exceeds its deadline.
- Preserve the most recently saved injury records whenever a refresh fails.

## Deployment

This is a client-side resilience update. It requires Firebase Hosting only. No Functions, Firestore rules, or indexes changed.
