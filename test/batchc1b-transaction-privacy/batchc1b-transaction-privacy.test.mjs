import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildPrivateTransactionProjection,
  buildPrivateWaiverClaimProjections,
  buildPublicTransactionResultProjection,
  buildPublicWaiverProjection,
  getPrivateTransactionDocumentId,
  getPublicTransactionResultDocumentId,
  getTransactionPrivacyFingerprint,
  sanitizeTransactionPrivacyAsset,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function skater(name = 'Privacy Player', position = 'C', assetKey = 'skater-1') {
  const [firstName, ...lastParts] = name.split(' ');

  return {
    assetType: 'skater',
    assetKey,
    position,
    player: {
      id: 8478402,
      fullName: name,
      firstName,
      lastName: lastParts.join(' ') || 'Player',
      nhlTeamAbbreviation: 'VGK',
      teamAbbrev: 'VGK',
      teamLogoUrl: 'https://assets.nhle.com/logos/nhl/svg/VGK_light.svg',
      email: 'must-never-project@rinkrat.test',
      privateScoutingNote: 'do not publish',
    },
    eligibleFromCycleNumber: 4,
    projectedCyclePoints: 92.4,
    projectionBreakdown: { goals: 10 },
  };
}

function goalie(assetKey = 'goalie-vgk') {
  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    teamName: 'Vegas Golden Knights',
    teamAbbreviation: 'VGK',
    teamLogoUrl: '/assets/team-identity-logos/VGK_light.svg',
    eligibleFromCycleNumber: 2,
    secretDepthChart: ['private'],
  };
}

function activeWaiver(overrides = {}) {
  return {
    assetKey: 'skater-1',
    asset: skater(),
    droppedAsset: skater('Dropped Player', 'C', 'skater-2'),
    droppedByOwnerId: 'owner-drop',
    status: 'active',
    claims: [
      {
        ownerId: 'owner-a',
        moveType: 'drop',
        rosterArea: 'active',
        dropSlotId: 'C-1',
        targetSlotId: null,
        waiverPriorityAtClaim: 1,
        effectiveCycleNumber: 4,
        effectiveLabel: 'Cycle 4',
        claimedAt: '2026-08-13T20:00:00.000Z',
        submissionId: 'private-claim-request-a',
      },
      {
        ownerId: 'owner-b',
        moveType: 'open-slot',
        rosterArea: 'bench',
        dropSlotId: null,
        targetSlotId: 'BENCH-2',
        waiverPriorityAtClaim: 2,
        effectiveCycleNumber: 4,
        effectiveLabel: 'Cycle 4',
        claimedAt: '2026-08-13T20:01:00.000Z',
      },
    ],
    awardedToOwnerId: null,
    effectiveCycleNumber: 4,
    effectiveLabel: 'Cycle 4',
    queuedMoveId: 'private-queued-move',
    rosterSlotId: 'C-1',
    requestId: 'private-waiver-request',
    ...overrides,
  };
}

test('privacy document identity is deterministic and never exposes a raw transaction ID', () => {
  const rawId = 'owner-a-private-request-123';
  const fingerprint = getTransactionPrivacyFingerprint(rawId);
  const privateId = getPrivateTransactionDocumentId(rawId);
  const publicId = getPublicTransactionResultDocumentId(rawId);

  assert.match(fingerprint, /^[a-f0-9]{40}$/);
  assert.equal(fingerprint, getTransactionPrivacyFingerprint(rawId));
  assert.match(privateId, /^transaction-[a-f0-9]{40}$/);
  assert.match(publicId, /^result-[a-f0-9]{40}$/);
  assert.notEqual(privateId, publicId);
  assert.equal(privateId.includes(rawId), false);
  assert.equal(publicId.includes(rawId), false);
});

test('transaction assets retain useful identity while stripping projection and private payloads', () => {
  const sanitizedSkater = sanitizeTransactionPrivacyAsset(skater('Jack Eichel', 'C'));
  const sanitizedGoalie = sanitizeTransactionPrivacyAsset(goalie());

  assert.deepEqual(sanitizedSkater, {
    assetType: 'skater',
    assetKey: 'skater-1',
    position: 'C',
    player: {
      id: 8478402,
      fullName: 'Jack Eichel',
      firstName: 'Jack',
      lastName: 'Eichel',
      nhlTeamAbbreviation: 'VGK',
      teamAbbrev: 'VGK',
      teamLogoUrl: 'https://assets.nhle.com/logos/nhl/svg/VGK_light.svg',
    },
    eligibleFromCycleNumber: 4,
  });
  assert.deepEqual(sanitizedGoalie, {
    assetType: 'team-goalie-unit',
    assetKey: 'goalie-vgk',
    position: 'G',
    teamName: 'Vegas Golden Knights',
    teamAbbreviation: 'VGK',
    teamLogoUrl: '/assets/team-identity-logos/VGK_light.svg',
    eligibleFromCycleNumber: 2,
  });
  assert.equal(JSON.stringify(sanitizedSkater).includes('must-never-project'), false);
  assert.equal(JSON.stringify(sanitizedSkater).includes('projectedCyclePoints'), false);
  assert.equal(JSON.stringify(sanitizedGoalie).includes('secretDepthChart'), false);
  assert.equal(sanitizeTransactionPrivacyAsset({ ...skater(), assetKey: 'bad/key' }), null);
  assert.equal(sanitizeTransactionPrivacyAsset({ ...skater(), position: 'G' }), null);
  assert.equal(
    sanitizeTransactionPrivacyAsset({ ...goalie(), teamLogoUrl: 'javascript:alert(1)' })?.teamLogoUrl,
    null,
  );
});

test('owner-private transactions preserve only the manager-specific ledger fields', () => {
  const projection = buildPrivateTransactionProjection({
    type: 'queue-add-drop',
    ownerId: 'owner-a',
    addedAsset: skater('Incoming Player', 'LW', 'incoming'),
    droppedAsset: skater('Outgoing Player', 'LW', 'outgoing'),
    sourceRosterArea: 'active',
    dropSlotId: 'LW-1',
    targetSlotId: 'LW-1',
    queuedMoveId: 'queued-123',
    rosterSlotId: 'LW-1',
    effectiveCycleNumber: 5,
    effectiveLabel: 'Matchup 5',
    waiverPriorityAtClaim: 1,
    claims: [{ ownerId: 'other-owner' }],
    reason: 'private commissioner reason',
    requestId: 'private-request-id',
    submissionId: 'private-submission-id',
  });

  assert.ok(projection);
  assert.equal(projection.type, 'queue-add-drop');
  assert.equal(projection.ownerId, 'owner-a');
  assert.equal(projection.addedAsset?.assetKey, 'incoming');
  assert.equal(projection.droppedAsset?.assetKey, 'outgoing');
  assert.equal(projection.sourceRosterArea, 'active');
  assert.equal(projection.effectiveCycleNumber, 5);
  assert.equal(projection.effectiveLabel, 'Cycle 5');
  assert.equal(projection.queuedMoveId, 'queued-123');
  assert.equal(projection.rosterSlotId, 'LW-1');
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes('other-owner'), false);
  assert.equal(serialized.includes('waiverPriorityAtClaim'), false);
  assert.equal(serialized.includes('private commissioner'), false);
  assert.equal(serialized.includes('private-request-id'), false);
  assert.equal(serialized.includes('private-submission-id'), false);

  for (const type of [
    'waiver-claim',
    'waiver-award',
    'waiver-cleared',
    'queue-waiver-award',
    'cancel-queued-move',
    'active-bench-swap-activated',
  ]) {
    assert.equal(buildPrivateTransactionProjection({ type, ownerId: 'owner-a' })?.type, type);
  }

  assert.equal(buildPrivateTransactionProjection({ type: 'unknown', ownerId: 'owner-a' }), null);
  assert.equal(buildPrivateTransactionProjection({ type: 'add-drop' }), null);
});

test('member-public transaction results include completed outcomes only', () => {
  const source = {
    type: 'queue-waiver-award',
    ownerId: 'owner-a',
    winningOwnerId: 'owner-a',
    waiverAsset: skater('Awarded Player', 'RW', 'award'),
    droppedAsset: skater('Dropped Player', 'RW', 'drop'),
    claims: [
      { ownerId: 'owner-a', waiverPriorityAtClaim: 2 },
      { ownerId: 'losing-owner', waiverPriorityAtClaim: 1 },
    ],
    queuedMoveId: 'private-queue-id',
    rosterSlotId: 'RW-2',
    reason: 'private adjudication details',
    effectiveCycleNumber: 6,
    effectiveLabel: 'Cycle 6',
  };
  const projection = buildPublicTransactionResultProjection(source);

  assert.ok(projection);
  assert.equal(projection.eventType, 'waiver-award');
  assert.equal(projection.ownerId, 'owner-a');
  assert.equal(projection.primaryAsset.assetKey, 'award');
  assert.equal(projection.secondaryAsset?.assetKey, 'drop');
  assert.equal(projection.effectiveCycleNumber, 6);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes('losing-owner'), false);
  assert.equal(serialized.includes('queuedMoveId'), false);
  assert.equal(serialized.includes('rosterSlotId'), false);
  assert.equal(serialized.includes('private adjudication'), false);

  for (const privateType of [
    'waiver-claim',
    'queue-add-drop',
    'queue-add-open-slot',
    'queue-active-bench-swap',
    'cancel-queued-move',
  ]) {
    assert.equal(
      buildPublicTransactionResultProjection({
        ...source,
        type: privateType,
      }),
      null,
      privateType,
    );
  }
});

test('public waiver records are claim-free while each claimant receives only their own derived result', () => {
  const active = activeWaiver();
  const publicActive = buildPublicWaiverProjection('skater-1', active);
  const privateActive = buildPrivateWaiverClaimProjections('skater-1', active);

  assert.ok(publicActive);
  assert.equal(publicActive.status, 'active');
  assert.equal(publicActive.awardedToOwnerId, null);
  const publicSerialized = JSON.stringify(publicActive);
  assert.equal(publicSerialized.includes('claims'), false);
  assert.equal(publicSerialized.includes('owner-a'), false);
  assert.equal(publicSerialized.includes('owner-b'), false);
  assert.equal(publicSerialized.includes('waiverPriorityAtClaim'), false);
  assert.equal(publicSerialized.includes('queuedMoveId'), false);
  assert.equal(privateActive.length, 2);
  assert.deepEqual(privateActive.map((claim) => claim.ownerId).sort(), ['owner-a', 'owner-b']);
  assert.equal(privateActive.every((claim) => claim.status === 'pending'), true);
  assert.equal(privateActive[0].waiverAsset.assetKey, 'skater-1');
  assert.equal(JSON.stringify(privateActive).includes('waiverPriorityAtClaim'), false);

  const awarded = activeWaiver({ status: 'claimed', awardedToOwnerId: 'owner-b' });
  const awardedClaims = buildPrivateWaiverClaimProjections('skater-1', awarded);
  assert.equal(awardedClaims.find((claim) => claim.ownerId === 'owner-b')?.status, 'awarded');
  assert.equal(awardedClaims.find((claim) => claim.ownerId === 'owner-a')?.status, 'not-awarded');
  assert.equal(buildPublicWaiverProjection('skater-1', awarded)?.awardedToOwnerId, 'owner-b');

  const clearedClaims = buildPrivateWaiverClaimProjections(
    'skater-1',
    activeWaiver({ status: 'cleared' }),
  );
  assert.equal(clearedClaims.every((claim) => claim.status === 'cleared'), true);
  assert.equal(buildPublicWaiverProjection('different-id', active), null);
  assert.equal(
    buildPublicWaiverProjection('skater-1', activeWaiver({ status: 'invalid-status' })),
    null,
  );
  assert.deepEqual(
    buildPrivateWaiverClaimProjections(
      'skater-1',
      activeWaiver({ status: 'invalid-status' }),
    ),
    [],
  );
});

test('server triggers publish deterministic projections without changing canonical authority', async () => {
  const [triggers, index] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
  ]);

  assert.match(triggers, /publishLeagueTransactionActivity = onDocumentCreated/);
  assert.match(triggers, /publishLeagueWaiverPrivacy = onDocumentWritten/);
  assert.match(triggers, /leagues\/\{leagueId\}\/transactions\/\{transactionId\}/);
  assert.match(triggers, /leagues\/\{leagueId\}\/waivers\/\{waiverId\}/);
  assert.match(triggers, /members\/\$\{ownerId\}\/transactions/);
  assert.match(triggers, /members\/\$\{ownerId\}\/waiverClaims/);
  assert.match(triggers, /transactionResults/);
  assert.match(triggers, /waiverPool/);
  assert.match(triggers, /authority:\s*'transaction-privacy-authority'/);
  assert.match(triggers, /release:\s*'Social Batch C1B'/);
  assert.match(triggers, /FieldValue\.serverTimestamp\(\)/);
  assert.match(triggers, /afterSource && afterPublicProjection/);
  assert.match(triggers, /batch\.delete\(publicReference\)/);
  assert.match(triggers, /await Promise\.all\(writes\)/);
  assert.match(triggers, /await batch\.commit\(\)/);
  assert.doesNotMatch(triggers, /batch\.(?:set|update|delete)\([^\n]*\/transactions\/\$\{sourceDocumentId\}/);
  assert.doesNotMatch(triggers, /batch\.(?:set|update|delete)\([^\n]*\/waivers\/\$\{waiverId\}/);
  assert.match(index, /publishLeagueWaiverPrivacy/);
});

test('the browser reads public waivers plus only the signed-in manager private records', async () => {
  const [draftService, freeAgents, template, resolution] = await Promise.all([
    read('src/app/core/draft/draft.service.ts'),
    read('src/app/features/free-agents/free-agents.ts'),
    read('src/app/features/free-agents/free-agents.html'),
    read('src/app/features/free-agents/free-agent-operation-resolution.util.ts'),
  ]);

  assert.match(draftService, /members', ownerId, 'transactions'/);
  assert.match(draftService, /'waiverPool'/);
  assert.match(draftService, /members', ownerId, 'waiverClaims'/);
  assert.match(draftService, /where\('status', '==', 'pending'\)/);
  assert.match(draftService, /limit\(50\)/);
  assert.match(draftService, /limit\(100\)/);
  assert.doesNotMatch(
    draftService.match(/export function listenToLeagueWaivers[\s\S]*?\n\}/)?.[0] ?? '',
    /collection\(db, 'leagues', leagueId, 'waivers'\)/,
  );
  assert.match(freeAgents, /listenToLeagueWaivers\(leagueId, this\.userId/);
  assert.match(freeAgents, /hasOwnerClaim:\s*waiver\.myClaim\?\.status === 'pending'/);
  assert.doesNotMatch(freeAgents, /waiver\.claims|getWaiverClaimCount/);
  assert.doesNotMatch(template, /\b\d+ claims?\b|claim count/i);
  assert.match(template, /getBoardActionLabel\(row\)/);
  assert.match(freeAgents, /Your claim is private/);
  assert.match(freeAgents, /Claim details stay private/);
  assert.match(resolution, /hasOwnerClaim/);
  assert.doesNotMatch(resolution, /claimOwnerIds|ownerId:\s*string;/);
});

test('Firestore Rules make canonical records server-only and projections least-privilege', async () => {
  const [rules, rulesTests] = await Promise.all([
    read('firestore.rules'),
    read('test/firestore-rules/firestore.rules.test.mjs'),
  ]);

  assert.match(
    rules,
    /match \/transactions\/\{transactionId\}[\s\S]*?allow read, create, update, delete: if false;/,
  );
  assert.match(
    rules,
    /match \/waivers\/\{waiverId\}[\s\S]*?allow read, create, update, delete: if false;/,
  );
  assert.match(
    rules,
    /match \/transactions\/\{transactionId\}[\s\S]*?memberId == currentUserId\(\)[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.match(
    rules,
    /match \/waiverClaims\/\{waiverId\}[\s\S]*?memberId == currentUserId\(\)[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.match(
    rules,
    /match \/transactionResults\/\{transactionId\}[\s\S]*?allow read: if isLeagueMember\(leagueId\);[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.match(
    rules,
    /match \/waiverPool\/\{waiverId\}[\s\S]*?allow read: if isLeagueMember\(leagueId\);[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.match(rulesTests, /canonical transaction and waiver records are unreadable by every browser role/);
  assert.match(rulesTests, /a manager can read only their own private transaction and waiver-claim projections/);
  assert.match(rulesTests, /league members can read claim-free public projections while outsiders cannot/);
  assert.match(rulesTests, /no browser can write canonical or projected transaction and waiver data/);
});

test('Firestore denial checks create each rejected write only when its handler is ready', async () => {
  const rulesTests = await read('test/firestore-rules/firestore.rules.test.mjs');
  const start = rulesTests.indexOf(
    "test('no browser can write canonical or projected transaction and waiver data'",
  );
  const end = rulesTests.indexOf("\n  });", start);
  const block = start >= 0 && end >= 0
    ? rulesTests.slice(start, end + "\n  });".length)
    : '';

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(block, /const writeAttempts = \[/);
  const operationsStart = block.indexOf('const writeAttempts = [');
  const operationsEnd = block.indexOf('\n    ];', operationsStart);
  const operationsBlock = operationsStart >= 0 && operationsEnd >= 0
    ? block.slice(operationsStart, operationsEnd)
    : '';
  assert.equal((operationsBlock.match(/\(\) =>/g) ?? []).length, 7);
  assert.match(
    block,
    /for \(const \[index, writeAttempt\] of writeAttempts\.entries\(\)\)/,
  );
  assert.match(
    block,
    /await expectDenied\(writeAttempt\(\), `Transaction privacy browser write \${index \+ 1}`\)/,
  );
  assert.doesNotMatch(block, /const writes = \[\s*setDoc/);
});

test('migration tooling is guarded, projection-only, independently inspectable, and cut over through an audited Rules bridge', async () => {
  const [
    backfill,
    inspector,
    transitionAudit,
    transitionRules,
    transitionConfigSource,
    packageSource,
  ] = await Promise.all([
    read('functions/scripts/transaction-privacy-backfill.cjs'),
    read('functions/scripts/transaction-privacy-inspect.cjs'),
    read('scripts/release/audit-transaction-privacy-transition.mjs'),
    read('firestore.transaction-privacy-transition.rules'),
    read('firebase.transaction-privacy-transition.json'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const transitionConfig = JSON.parse(transitionConfigSource);

  assert.match(backfill, /RINKRAT_APPLY_TRANSACTION_PRIVACY === 'APPLY'/);
  assert.match(backfill, /const writer = apply \? db\.bulkWriter\(\) : null/);
  assert.match(backfill, /--league=/);
  assert.match(backfill, /Unsupported or invalid canonical records/);
  assert.match(backfill, /Canonical transaction and waiver records were not changed/);
  assert.doesNotMatch(backfill, /writer\?\.(?:set|update|delete)\([^\n]*leagues\/\$\{leagueId\}\/(?:transactions|waivers)/);
  assert.match(inspector, /compareProjectionDocument/);
  assert.match(inspector, /compareMapKeys/);
  assert.match(inspector, /PUBLIC_FORBIDDEN_FIELDS/);
  assert.match(inspector, /PRIVATE_FORBIDDEN_FIELDS/);
  assert.match(inspector, /Privacy issues: \$\{issues\.length\}/);
  assert.match(inspector, /Inspection only\. No raw transaction, waiver, league, score, or production setting was changed\./);
  assert.doesNotMatch(inspector, /db\.bulkWriter|db\.batch|FieldValue|writer\?\.|transaction\.(?:set|update|delete)/);
  assert.match(packageJson.scripts['social:backfill-transaction-privacy'], /transaction-privacy-backfill\.cjs/);
  assert.match(packageJson.scripts['social:inspect-transaction-privacy'], /transaction-privacy-inspect\.cjs/);
  assert.match(packageJson.scripts['social:audit-transaction-privacy-transition'], /audit-transaction-privacy-transition\.mjs/);
  assert.match(packageJson.scripts['verify:batchc1b:core'], /social:audit-transaction-privacy-transition/);
  assert.match(transitionAudit, /may differ from final Rules only at the two canonical read gates/);
  assert.match(transitionAudit, /Audit only\. No Firebase project or production setting was changed\./);
  assert.match(
    transitionRules,
    /match \/transactions\/\{transactionId\}[\s\S]*?allow read: if isLeagueMember\(leagueId\);[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.match(
    transitionRules,
    /match \/waivers\/\{waiverId\}[\s\S]*?allow read: if isLeagueMember\(leagueId\);[\s\S]*?allow create, update, delete: if false;/,
  );
  assert.equal(transitionConfig.firestore.rules, 'firestore.transaction-privacy-transition.rules');
  assert.equal('hosting' in transitionConfig, false);
  assert.equal('functions' in transitionConfig, false);
});

test('RC33 preserves the frozen competitive models, six-game contract, and Shadow safety modes', async () => {
  const [
    scoringSource,
    scoringEngineSource,
    projectionSource,
    rulesSource,
    indexesSource,
    runtime,
    productionRuntime,
    freezeSource,
    appCheckSource,
    canarySource,
    cachePolicySource,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('config/app-check-callable-canary.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const appCheck = JSON.parse(appCheckSource);
  const canary = JSON.parse(canarySource);
  const cachePolicy = JSON.parse(cachePolicySource);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringSource).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngineSource).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionSource).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(rulesSource).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(indexesSource).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(runtime, /Release Candidate 41/);
  assert.match(productionRuntime, /Release Candidate 41/);
  assert.equal(freeze.scoringRulesVersion, 3);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcha1c');
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(canary.automaticPromotion, false);
  assert.equal(cachePolicy.mode, 'shadow');
  assert.equal(cachePolicy.authoritativeReadsEnabled, false);
  assert.match(packageJson.scripts['verify:batchc1b:core'], /verify:batchc1a:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcha1c:core/);
});

test('C1B documentation records the staged privacy cutover, rollback unit, and permanent roadmap completion', async () => {
  const [roadmap, docsRoadmap, runbook, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.32/);
  assert.match(roadmap, /# \[x\] C1\.14/);
  assert.match(roadmap, /# \[x\] LOG\.33/);
  assert.match(roadmap, /# \[x\] LOG\.34/);
  assert.match(runbook, /Deploy \*\*Functions only\*\*/);
  assert.match(runbook, /Apply the backfill/);
  assert.match(runbook, /require zero privacy issues/);
  assert.match(runbook, /temporary Rules bridge/i);
  assert.match(runbook, /Deploy \*\*Hosting RC28 only\*\*/);
  assert.match(runbook, /Deploy the default final `firestore\.rules` \*\*Rules only\*\*/);
  assert.match(runbook, /First redeploy the bundled transition Rules bridge/i);
  assert.match(runbook, /No Firestore index deployment is required/);
  assert.match(runbook, /--only functions/);
  assert.match(runbook, /--config firebase\.transaction-privacy-transition\.json/);
  assert.match(runbook, /--only hosting:app/);
  assert.match(runbook, /--only firestore:rules/);
  assert.doesNotMatch(
    runbook,
    /--only[^\n]*(?:functions[^\n]*hosting|hosting[^\n]*functions)/,
  );
  assert.match(runbook, /Your claim is private/);
  assert.match(runbook, /C1B\.1 verification-harness hotfix/);
  assert.match(readme, /Release Candidate 41 \/ Product Batch A1C/);
  assert.match(readme, /RINKRAT_SOCIAL_C1B_TRANSACTION_PRIVACY\.md/);
  assert.match(releaseRunbook, /rinkrat-rc41-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc41-invite-beta/);
});
