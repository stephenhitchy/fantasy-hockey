# RinkRat B1Y — Roster Deployment Contract Recovery

## Incident

Production Hosting expected the B1V contract of fourteen active slots, five
bench slots, and three Injured Reserve slots. A later dependency-only release
deployed all Functions from a clean source revision that predated B1V. The
older `ensureFantasyRoster` normalizer retained only three bench slots, while
the browser continued to display `B-4` and `B-5`. Secure add/open-slot actions
for those slots consequently failed at the server boundary.

The same rollback also replaced the B1V-aware mixed-player scoring source.
Because Production already contained injury-replacement transactions, the
repair cannot safely stop at the two roster callables. Every deployable export
that transitively consumes the post-baseline roster, Draft, Projection,
canonical NHL, or scoring modules must be restored from one clean source.

## Guard

Firebase predeploy already invokes `release:verify-clean-deploy-source` for
Functions and Hosting. B1Y extends that command with a source contract that
fails closed unless all of the following remain present together:

- five browser and server bench slots;
- five-slot server roster migration;
- nineteen-round/five-bench Draft defaults and Auto-Draft targets;
- Draft Ranking V4's five-bench demand model;
- instant injury-replacement authority;
- exact game-to-player scoring ownership; and
- current-segment-only rollover.

The inherited verification chain now runs both the original B1V injury
ownership fixture and adversarial tests proving that a three-bench rollback or
removal of mixed-player scoring ownership fails the guard.

## Recovery source and resources

Use one clean descendant of `df4644d21d514c11b66a79f585bbe07572174968`
after the complete B1Y gate passes. Deploy only the 43 affected exports,
split into bounded batches for Firebase control-plane safety:

- roster authority: `ensureFantasyRoster`, `executeSecureRosterAction`,
  `applyImmediateRosterMove`;
- league automation: `advanceHistoricalReplayDay`,
  `bootstrapLeagueAutomationSchedules`, `cleanupLeagueAutomationTaskHistory`,
  `clearExpiredOrErroredLiveScoringLease`, `dispatchDueLeagueAutomation`,
  `getFinalScoreReconciliationPage`, `getLeagueAutomationQueueControlCenter`,
  `initializeSeasonAfterDraft`, `monitorLeagueAutomationSeasonSafety`,
  `openNextCompetitionPeriod`, `processHistoricalReplayAdvance`,
  `processLeagueAutomationTask`, `queueLeagueAutomationCanaryCheck`,
  `recoverStaleLeagueAutomationQueue`, `recoverStaleHistoricalReplayQueue`,
  `refreshLeagueAutomationCapacityEvidence`, `releaseLeagueLiveScoringHandoff`,
  `requestLeagueLiveScoringRefresh`, `runScheduledLeagueAutomation`,
  `runSeasonStartAutomation`, and `updateLeagueAutomationQueueConfig`;
- Draft automation: `continueServerDraftAutomation`,
  `processAutoDraftQueueChange`, `processDraftClockDeadline`,
  `reconcileDraftTurnAfterCommittedPick`, and `runScheduledDraftAutomation`;
- Draft authority: `executeDraftCommand`, `makeSecureDraftPick`, and
  `repairDraftTurnHandoff`;
- Projection authority: `manageProjectionSnapshotIntegrity`,
  `processProjectionGenerationTask`, `recoverStaleProjectionGenerationRequests`,
  and `requestProjectionSnapshotGeneration`;
- league lifecycle: `createLeagueSecure`, `joinLeagueSecure`,
  `migrateLeagueAuthoritySchema`, `removeLeagueMemberSecure`,
  `updateLeagueCapacitySecure`, and `updateLeagueCosmeticsSecure`; and
- canonical feed: `pollCanonicalNhlImpactFeed`.

No Hosting, Rules, indexes, TTL, App Check, queue configuration, or production
data migration belongs to this recovery.

## Rollback

Do not roll the scoring or roster Functions back to a pre-B1V revision while
any injury-replacement window is active. If a B1Y-specific guard regression is
found, revert only the guard and test wiring while retaining the B1V-capable
Functions. Existing roster documents continue to normalize empty `B-4` and
`B-5` slots on demand; no bulk write is required.
