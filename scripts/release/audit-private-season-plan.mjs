import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);
const [gatesSource, freezeSource, roadmap, operations] = await Promise.all([
  readFile(new URL('config/private-season-launch-gates.json', ROOT), 'utf8'),
  readFile(new URL('config/release-freeze/beta-freeze-policy.json', ROOT), 'utf8'),
  readFile(new URL('RINKRAT_COMPETITIVE_ROADMAP.txt', ROOT), 'utf8'),
  readFile(new URL('docs/RINKRAT_OPERATIONS_O1_TESTER_SEASON_PUBLIC_LAUNCH.md', ROOT), 'utf8'),
]);

const gates = JSON.parse(gatesSource);
const freeze = JSON.parse(freezeSource);

assert.equal(gates.schemaVersion, 1);
assert.equal(gates.cohort.minimumLeagues, 2);
assert.equal(gates.cohort.maximumLeagues, 4);
assert.equal(gates.cohort.minimumManagers, 10);
assert.equal(gates.cohort.maximumManagers, 30);
assert.equal(gates.cohort.requiresNonFounderCommissioner, true);
assert.equal(gates.greenThresholds.unresolvedP0IntegrityDefectsMaximum, 0);
assert.equal(gates.greenThresholds.confirmedCoreActionReliabilityPercentMinimum, 99.5);
assert.equal(gates.greenThresholds.sixMemberLeagueDraftCompletionPercentMinimum, 75);
assert.equal(gates.greenThresholds.createdLeagueSixVerifiedMemberPercentMinimum, 60);
assert.equal(gates.greenThresholds.fourWeekLeagueRetentionPercentMinimum, 70);
assert.equal(gates.greenThresholds.paidAcquisitionHardPauseRetentionPercentBelow, 60);
assert.equal(gates.greenThresholds.medianSupportMinutesPerActiveLeagueWeekMaximum, 20);
assert.equal(gates.greenThresholds.nextSeasonCommissionerIntentPercentMinimum, 70);
assert.equal(gates.greenThresholds.stagedClientLoadTestMinimum, 5000);
assert.deepEqual(gates.controlledActivatedLeagueWaves, [5, 10, 25, 50, 100]);
assert.deepEqual(
  gates.formalGoNoGoDates.map((entry) => entry.date),
  ['2026-09-27', '2026-10-31', '2027-04-30', '2027-07-15', '2027-09-21'],
);
assert.equal(gates.operatingPolicies.commissionerFirst, true);
assert.equal(gates.operatingPolicies.optimizeForActivatedAndRetainedLeagues, true);
assert.equal(gates.operatingPolicies.noPaidEntryOrPooledLeagueMoney, true);
assert.equal(gates.operatingPolicies.noPayToWinCompetitiveAdvantage, true);
assert.equal(freeze.releaseLabel, 'Release Candidate 54');
assert.equal(freeze.scoringRulesVersion, 4);
assert.equal(freeze.projectionVersion, 11);
assert.match(roadmap, /PHASE O1 — TESTER-SEASON OPERATIONS AND PUBLIC-LAUNCH FOUNDATION/);
assert.match(roadmap, /at least 99\.5% confirmed core-action reliability/);
assert.match(roadmap, /5 → 10 → 25 → 50 → 100 activated leagues/);
for (const milestone of [
  ['O1.M1', '2026-09-27'],
  ['O1.M2', '2026-10-31'],
  ['O1.M3', '2027-04-30'],
  ['O1.M4', '2027-07-15'],
  ['O1.M5', '2027-09-21'],
]) {
  assert.match(roadmap, new RegExp(`${milestone[0]} ${milestone[1]}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(operations, /2–4 leagues/);
assert.match(operations, /10–30 observed managers/);
assert.match(operations, /0 unresolved P0 integrity defects/);
assert.match(operations, /at least 70% four-week retention/);
assert.match(operations, /written resolution/);

console.log('Tester-season and public-launch plan audit passed.');
console.log('- Private cohort: 2–4 leagues / 10–30 diverse managers');
console.log('- Launch gates: integrity, 99.5% action reliability, activation, retention, support, abuse, capacity, and legal clearance');
console.log('- Controlled public waves: 5 → 10 → 25 → 50 → 100 activated leagues');
console.log('Audit only. No signup cap, production setting, league, or acquisition campaign was changed.');
