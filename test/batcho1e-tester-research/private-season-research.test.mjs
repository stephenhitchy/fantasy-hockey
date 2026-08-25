import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildPrivateSeasonResearchSummary,
  normalizePrivateSeasonResearchAnswers,
  normalizePrivateSeasonResearchResponse,
  privateSeasonResearchMilestoneAvailable,
  privateSeasonResearchMilestonePrompt,
  privateSeasonResearchResponseId,
} from '../../functions/src/shared/core/operations/private-season-research.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function answers(overrides = {}) {
  return {
    clarityRating: 4,
    trustRating: 5,
    informationAmount: 'about-right',
    founderIndependence: 'mostly',
    supportNeeded: 'once',
    nextSeasonIntent: 'probably',
    recommendationScore: 8,
    promptResponse: 'The workflow made sense once the result was confirmed.',
    biggestFriction: 'The first confirmation took longer than expected.',
    mostUsefulFeature: 'Game Center',
    followUpAllowed: true,
    ...overrides,
  };
}

function response(overrides = {}) {
  return {
    schemaVersion: 1,
    responseId: 'a'.repeat(64),
    leagueId: 'league-a',
    leagueLabel: 'Family League',
    managerHash: overrides.managerHash ?? 'b'.repeat(32),
    role: overrides.role ?? 'manager',
    milestone: overrides.milestone ?? 'after-first-matchup',
    revision: 1,
    answers: answers(overrides.answers),
    releaseLabel: 'Release Candidate 65',
    buildId: 'release-candidate-58-test-build',
    submittedAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:00Z',
  };
}

test('milestone prompts preserve the tester-season interview questions from the launch plan', () => {
  assert.equal(privateSeasonResearchMilestonePrompt('after-join'), 'What did you expect to happen next?');
  assert.equal(privateSeasonResearchMilestonePrompt('after-draft'), 'Could your league run this without Stephen?');
  assert.equal(privateSeasonResearchMilestonePrompt('after-first-matchup'), 'Explain the six-game system in your own words.');
  assert.equal(privateSeasonResearchMilestonePrompt('after-first-transaction'), 'What made you confident the move worked?');
  assert.equal(privateSeasonResearchMilestonePrompt('week-4'), 'What brings you back? What do you still use elsewhere?');
  assert.equal(privateSeasonResearchMilestonePrompt('midseason'), 'What would make you quit?');
  assert.equal(privateSeasonResearchMilestonePrompt('season-end'), 'Would you choose RinkRat next year? Why or why not?');
});

test('research answers stay bounded and reject contact details in free text', () => {
  const normalized = normalizePrivateSeasonResearchAnswers(answers());
  assert.equal(normalized?.clarityRating, 4);
  assert.equal(normalized?.informationAmount, 'about-right');
  assert.equal(normalized?.followUpAllowed, true);

  assert.equal(normalizePrivateSeasonResearchAnswers(answers({
    promptResponse: 'Email me at manager@example.com when this is fixed.',
  })), null);
  assert.equal(normalizePrivateSeasonResearchAnswers(answers({
    biggestFriction: 'Call 702-555-0100 for details.',
  })), null);
  assert.equal(normalizePrivateSeasonResearchAnswers(answers({ promptResponse: 'Too short' })), null);
});

test('milestone availability follows real league evidence and dated research gates', () => {
  const base = {
    draftComplete: false,
    firstMatchupViewedAt: null,
    firstRosterActionAt: null,
    activatedAt: null,
    planStatus: 'live',
    nowMilliseconds: Date.parse('2026-10-01T12:00:00Z'),
  };

  assert.equal(privateSeasonResearchMilestoneAvailable({ milestone: 'after-join', ...base }).available, true);
  assert.equal(privateSeasonResearchMilestoneAvailable({ milestone: 'after-draft', ...base }).available, false);
  assert.equal(privateSeasonResearchMilestoneAvailable({
    milestone: 'after-first-matchup',
    ...base,
    draftComplete: true,
    firstMatchupViewedAt: '2026-09-30T12:00:00Z',
  }).available, true);
  assert.equal(privateSeasonResearchMilestoneAvailable({
    milestone: 'week-4',
    ...base,
    activatedAt: '2026-09-01T12:00:00Z',
  }).available, true);
  assert.equal(privateSeasonResearchMilestoneAvailable({
    milestone: 'midseason',
    ...base,
    nowMilliseconds: Date.parse('2027-01-04T12:00:00Z'),
  }).available, true);
  assert.equal(privateSeasonResearchMilestoneAvailable({
    milestone: 'season-end',
    ...base,
    nowMilliseconds: Date.parse('2027-04-11T12:00:00Z'),
  }).available, true);
});

test('stored responses accept the 32-character pseudonymous manager hash used by private-season health', () => {
  const normalized = normalizePrivateSeasonResearchResponse(response());
  assert.equal(normalized?.managerHash, 'b'.repeat(32));
  assert.equal(normalized?.responseId, 'a'.repeat(64));
});

test('unanswered optional categories do not bias percentage summaries', () => {
  const summary = buildPrivateSeasonResearchSummary([
    response({
      answers: {
        informationAmount: 'not-answered',
        founderIndependence: 'not-applicable',
        supportNeeded: 'not-answered',
        nextSeasonIntent: 'not-asked',
      },
    }),
  ]);

  assert.equal(summary.informationAboutRightPercent, null);
  assert.equal(summary.informationTooMuchPercent, null);
  assert.equal(summary.founderIndependentPercent, null);
  assert.equal(summary.recurringSupportPercent, null);
  assert.equal(summary.positiveReturnIntentPercent, null);
});

test('response identity is deterministic per account, league, and milestone without exposing the account ID', () => {
  const first = privateSeasonResearchResponseId('user-a', 'league-a', 'after-draft');
  const again = privateSeasonResearchResponseId('user-a', 'league-a', 'after-draft');
  const otherLeague = privateSeasonResearchResponseId('user-a', 'league-b', 'after-draft');
  const otherMilestone = privateSeasonResearchResponseId('user-a', 'league-a', 'week-4');

  assert.equal(first, again);
  assert.notEqual(first, otherLeague);
  assert.notEqual(first, otherMilestone);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /user-a|league-a|after-draft/);
});

test('research summary reports clarity, trust, information load, independence, support, and return intent', () => {
  const summary = buildPrivateSeasonResearchSummary([
    response(),
    response({
      responseId: 'c'.repeat(64),
      managerHash: 'd'.repeat(32),
      answers: {
        clarityRating: 2,
        trustRating: 3,
        informationAmount: 'too-much',
        founderIndependence: 'no',
        supportNeeded: 'weekly',
        nextSeasonIntent: 'no',
        recommendationScore: 3,
        followUpAllowed: false,
      },
    }),
  ]);

  assert.equal(summary.responseCount, 2);
  assert.equal(summary.uniqueRespondentCount, 2);
  assert.equal(summary.averageClarity, 3);
  assert.equal(summary.averageTrust, 4);
  assert.equal(summary.informationAboutRightPercent, 50);
  assert.equal(summary.informationTooMuchPercent, 50);
  assert.equal(summary.founderIndependentPercent, 50);
  assert.equal(summary.recurringSupportPercent, 50);
  assert.equal(summary.positiveReturnIntentPercent, 50);
  assert.equal(summary.followUpAllowedCount, 1);
});

test('server research authority derives membership and identity, enforces the operations contract, and stores no raw contact details', async () => {
  const source = await read('functions/src/private-season-research.ts');

  assert.match(source, /assessOperationsClientCompatibility/);
  assert.match(source, /normalizeOperationsClientIdentity/);
  assert.doesNotMatch(source, /CURRENT_BUILD_ID_PATTERN/);
  assert.match(source, /requireVerifiedManager/);
  assert.match(source, /leagues\/\$\{leagueId\}\/members\/\$\{input\.userId\}/);
  assert.match(source, /privateSeasonManagerHash/);
  assert.match(source, /privateSeasonResearchResponseId/);
  assert.match(source, /where\('ownerId', '==', ownerId\)/);
  assert.match(source, /collection\('managerDays'\)[\s\S]*where\('managerHash', '==', managerHash\)/);
  assert.match(source, /researchResponses/);
  assert.match(source, /buildIdentity\(input\['build'\], true\)/);
  assert.doesNotMatch(source, /followUpEmail|phoneNumber|emailAddress/);
  assert.doesNotMatch(source, /request\.data\?\.\['userId'\]|input\['userId'\]/);
});

test('manager and administrator research routes are separate, inline, and linked from existing support and operations surfaces', async () => {
  const [routes, managerPage, managerStyles, adminPage, adminStyles, supportHome, footer, adminCenter, health] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/support/private-season-feedback/private-season-feedback.html'),
    read('src/app/features/support/private-season-feedback/private-season-feedback.css'),
    read('src/app/features/admin/private-season-research/private-season-research.html'),
    read('src/app/features/admin/private-season-research/private-season-research.css'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/layouts/main-layout/main-layout.html'),
    read('src/app/features/admin/admin-center/admin-center.html'),
    read('src/app/features/admin/private-season-health/private-season-health.html'),
  ]);

  assert.match(routes, /path: 'private-season\/feedback'/);
  assert.match(routes, /path: 'admin\/private-season\/research'[\s\S]*platformAdminGuard/);
  assert.match(managerPage, /Season Feedback/);
  assert.match(managerPage, /Privacy-limited research/);
  assert.match(managerPage, /Could the league operate without Stephen/);
  assert.match(adminPage, /Private Season Research/);
  assert.match(adminPage, /Export CSV/);
  assert.match(adminPage, /Pseudonymous responses/);
  assert.match(adminPage, /league-manager respondents/);
  const adminComponent = await read('src/app/features/admin/private-season-research/private-season-research.ts');
  assert.ok(adminComponent.includes('/^\\s*[=+\\-@]/'));
  assert.match(supportHome, /Tester-season milestones/);
  assert.match(footer, /Tester Feedback/);
  assert.match(adminCenter, /Tester Research/);
  assert.match(health, /Tester Research/);
  assert.doesNotMatch(managerPage + adminPage, /role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(managerStyles + adminStyles, /position:\s*(?:fixed|sticky)/);
  assert.match(managerStyles, /min-height:\s*44px/);
});

test('account deletion removes private-season research by pseudonymous manager hash', async () => {
  const source = await read('functions/src/index.ts');
  assert.match(source, /collection\('researchResponses'\)/);
  assert.match(source, /where\('managerHash', '==', managerHash\)/);
  assert.match(source, /batch\.delete\(document\.ref\)/);
});

test('O1E stays server-authoritative and preserves scoring, projection, Rules, and indexes', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    runtime,
    productionRuntime,
    freezeSource,
    packageSource,
    indexSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('functions/src/index.ts'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(packageJson.scripts['security:ci'], /verify:batchb1j:core/);
  assert.match(indexSource, /getPrivateSeasonResearchDashboard/);
  assert.match(indexSource, /submitPrivateSeasonResearch/);
});

test('roadmap and documentation record milestone research as evidence collection rather than product-market-fit proof', async () => {
  const [roadmap, docsRoadmap, readme, runbook, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1E_TESTER_RESEARCH.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /O1E \/ Release Candidate 55/);
  assert.match(roadmap, /live interviews and the full-season postmortem remain open/i);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(readme, /npm run verify:batchb1j/);
  assert.match(runbook, /seven milestone surveys/i);
  assert.match(runbook, /No email address, phone number, or raw account ID/i);
  assert.match(runbook, /Functions first/i);
  assert.match(releaseRunbook, /rinkrat-rc65-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc65-invite-beta/);
});
