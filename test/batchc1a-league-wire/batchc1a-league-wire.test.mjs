import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

import {
  buildAuditLeagueActivity,
  buildDraftPickLeagueActivity,
  buildTransactionLeagueActivity,
  getLeagueActivityDocumentId,
  getLeagueActivityFingerprint,
  isPublicLeagueActivityTransactionType,
} from '../../functions/src/shared/core/league/league-activity.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function listExecutableTests(directoryUrl = new URL('../', import.meta.url), prefix = '') {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl);
    if (entry.isDirectory()) {
      files.push(...await listExecutableTests(entryUrl, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(relativePath);
    }
  }

  return files;
}

function skater(name = 'League Wire Player', position = 'C') {
  return {
    assetType: 'skater',
    position,
    assetKey: 'skater-1',
    player: {
      id: 1,
      fullName: name,
      email: 'must-not-copy@rinkrat.test',
    },
    projectedCyclePoints: 99,
  };
}

test('League Wire document identity is deterministic and hides raw source IDs', () => {
  const first = getLeagueActivityDocumentId('transaction', 'private-request-owner-123');
  const second = getLeagueActivityDocumentId('transaction', 'private-request-owner-123');
  const other = getLeagueActivityDocumentId('draft-pick', 'private-request-owner-123');

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^activity-[a-f0-9]{40}$/);
  assert.equal(first.includes('private-request-owner-123'), false);
  assert.match(
    getLeagueActivityFingerprint('audit', 'audit-row'),
    /^[a-f0-9]{40}$/,
  );
});

test('only public league audit outcomes are projected into League Wire', () => {
  assert.deepEqual(
    buildAuditLeagueActivity({ action: 'member-joined', actorId: 'owner-1' }),
    {
      schemaVersion: 1,
      category: 'league',
      eventType: 'member-joined',
      ownerId: 'owner-1',
      primaryAsset: null,
      secondaryAsset: null,
      overallPick: null,
      round: null,
      selectionType: null,
      effectiveCycleNumber: null,
      effectiveLabel: null,
    },
  );
  assert.equal(
    buildAuditLeagueActivity({
      action: 'league-presentation-updated',
      actorId: 'owner-1',
      changed: false,
    }),
    null,
  );
  assert.equal(
    buildAuditLeagueActivity({
      action: 'invite-locked',
      actorId: 'owner-1',
    }),
    null,
  );
  assert.equal(
    buildAuditLeagueActivity({
      action: 'league-authority-migrated',
      actorId: 'platform-admin',
      reason: 'private migration detail',
    }),
    null,
  );
});

test('Draft picks preserve useful public context without copying the raw asset payload', () => {
  const activity = buildDraftPickLeagueActivity({
    ownerId: 'owner-2',
    overallPick: 17,
    round: 3,
    selectionType: 'automatic',
    selectedByUserId: 'private-actor-id',
    submissionId: 'private-request-id',
    asset: skater('Public Skater', 'RW'),
  });

  assert.ok(activity);
  assert.equal(activity.eventType, 'draft-pick');
  assert.equal(activity.ownerId, 'owner-2');
  assert.equal(activity.primaryAsset?.name, 'Public Skater');
  assert.equal(activity.primaryAsset?.position, 'RW');
  assert.equal(activity.overallPick, 17);
  assert.equal(activity.round, 3);
  assert.equal(activity.selectionType, 'automatic');
  assert.equal('submissionId' in activity, false);
  assert.equal('selectedByUserId' in activity, false);
  assert.equal(JSON.stringify(activity).includes('must-not-copy@rinkrat.test'), false);
  assert.equal(
    buildDraftPickLeagueActivity({
      ownerId: 'owner-2',
      overallPick: 18,
      asset: { name: 'Untrusted fallback name', position: 'C' },
    }),
    null,
  );
});

test('pending claims, queued plans, and cancellations never become public activity', () => {
  const privateTypes = [
    'waiver-claim',
    'queue-add-drop',
    'queue-add-open-slot',
    'queue-active-bench-swap',
    'cancel-queued-move',
  ];

  for (const type of privateTypes) {
    assert.equal(isPublicLeagueActivityTransactionType(type), false, type);
    assert.equal(
      buildTransactionLeagueActivity({
        type,
        ownerId: 'owner-1',
        addedAsset: skater('Secret Target'),
        waiverAsset: skater('Secret Target'),
      }),
      null,
      type,
    );
  }
});

test('completed roster and waiver outcomes are sanitized, including queued awards after adjudication', () => {
  const award = buildTransactionLeagueActivity({
    type: 'queue-waiver-award',
    ownerId: 'owner-3',
    winningOwnerId: 'owner-3',
    waiverAsset: skater('Won Player', 'LW'),
    droppedAsset: skater('Dropped Player', 'LW'),
    claims: [
      { ownerId: 'losing-owner', waiverPriority: 1 },
      { ownerId: 'owner-3', waiverPriority: 2 },
    ],
    effectiveCycleNumber: 4,
    effectiveLabel: 'Cycle 4',
    reason: 'private waiver adjudication detail',
  });

  assert.ok(award);
  assert.equal(award.eventType, 'waiver-award');
  assert.equal(award.ownerId, 'owner-3');
  assert.equal(award.primaryAsset?.name, 'Won Player');
  assert.equal(award.secondaryAsset?.name, 'Dropped Player');
  assert.equal(award.effectiveCycleNumber, 4);
  assert.equal(award.effectiveLabel, 'Cycle 4');
  assert.equal(JSON.stringify(award).includes('losing-owner'), false);
  assert.equal(JSON.stringify(award).includes('private waiver'), false);

  const untrustedLabel = buildTransactionLeagueActivity({
    type: 'add-open-slot',
    ownerId: 'owner-3',
    addedAsset: skater('Another Player', 'C'),
    effectiveCycleNumber: 5,
    effectiveLabel: 'Private commissioner note: reveal this later',
  });

  assert.ok(untrustedLabel);
  assert.equal(untrustedLabel.effectiveCycleNumber, 5);
  assert.equal(untrustedLabel.effectiveLabel, null);
});

test('Functions publish only create events through idempotent server-owned projections', async () => {
  const [triggers, index] = await Promise.all([
    read('functions/src/league-activity.ts'),
    read('functions/src/index.ts'),
  ]);

  assert.match(triggers, /onDocumentCreated/);
  assert.match(triggers, /leagues\/\{leagueId\}\/audit\/\{auditId\}/);
  assert.match(triggers, /leagues\/\{leagueId\}\/draft\/current\/picks\/\{pickId\}/);
  assert.match(triggers, /leagues\/\{leagueId\}\/transactions\/\{transactionId\}/);
  assert.match(triggers, /retry:\s*true/);
  assert.match(triggers, /db\.runTransaction/);
  assert.match(triggers, /if \(existing\.exists\)/);
  assert.match(triggers, /authority:\s*'league-activity-authority'/);
  assert.match(triggers, /sourceFingerprint/);
  const writeBlock = triggers.match(/transaction\.create\(activityReference, \{[\s\S]*?\n    \}\);/)?.[0] ?? '';
  assert.ok(writeBlock);
  assert.doesNotMatch(writeBlock, /sourceDocumentId/);
  assert.match(index, /publishLeagueAuditActivity/);
  assert.match(index, /publishLeagueDraftPickActivity/);
  assert.match(index, /publishLeagueTransactionActivity/);
});

test('member-only rules and the compact client listener keep League Wire bounded', async () => {
  const [rules, service, component, template, styles, leagueDetail] = await Promise.all([
    read('firestore.rules'),
    read('src/app/core/league/league-activity.service.ts'),
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
  ]);

  assert.match(
    rules,
    /match \/activity\/\{activityId\}[\s\S]*allow read: if isLeagueMember\(leagueId\);[\s\S]*allow create, update, delete: if false;/,
  );
  assert.match(service, /orderBy\('occurredAt', 'desc'\)/);
  assert.match(service, /limit\(LEAGUE_ACTIVITY_LIMIT\)/);
  assert.match(service, /monitorFirestoreListener\('league:activity'/);
  assert.match(component, /COLLAPSED_ACTIVITY_COUNT = 5/);
  assert.doesNotMatch(component, /case 'invite-locked'/);
  assert.match(component, /league membership is locked/);
  assert.match(template, /pending claims, queued plans, invite codes, and admin details stay off the wire/i);
  assert.match(leagueDetail, /<app-league-wire/);
  assert.doesNotMatch(template, /role="dialog"|viewport-overlay|action-sheet/i);
  assert.doesNotMatch(styles, /position:\s*(?:fixed|sticky)|backdrop-filter/i);
  assert.match(styles, /var\(--rr-color-text\)/);
  assert.match(styles, /var\(--rr-color-surface/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i);
});

test('C1A remains intact under RC34 while preserving competitive models and safety modes', async () => {
  const [
    runtime,
    productionRuntime,
    scoring,
    projection,
    freezeSource,
    cachePolicySource,
    appCheckSource,
    packageSource,
  ] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-snapshot.service.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('config/nhl-shared-cache-policy.json'),
    read('config/app-check-enforcement-readiness.json'),
    read('package.json'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const cachePolicy = JSON.parse(cachePolicySource);
  const appCheck = JSON.parse(appCheckSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 35/);
  assert.match(productionRuntime, /Release Candidate 35/);
  assert.match(scoring, /CURRENT_SCORING_RULES_VERSION\s*=\s*3/);
  assert.match(projection, /SHARED_PROJECTION_VERSION\s*=\s*11/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 35');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchc1i');
  assert.equal(cachePolicy.mode, 'shadow');
  assert.equal(cachePolicy.authoritativeReadsEnabled, false);
  assert.equal(appCheck.mode, 'monitor');
  assert.equal(freeze.queueMode, 'shadow');
  assert.match(packageJson.scripts['verify:batchc1a:core'], /verify:batchd1c:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchc1i:core/);
});

test('active integrity tests share one approved current Firestore Rules baseline', async () => {
  const rulesSource = await read('firestore.rules');
  const currentHash = createHash('sha256').update(rulesSource).digest('hex');
  const historical = JSON.parse(
    await read('test/batchb1c-invite-beta-freeze/preserved-runtime-hashes.json'),
  );
  const historicalHash = historical['firestore.rules'];

  assert.equal(currentHash, PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.notEqual(historicalHash, PROTECTED_SOURCE_HASHES.firestoreRules);

  const executableTests = await listExecutableTests();
  const duplicatedCurrentHashes = [];
  const staleHistoricalHashes = [];
  for (const relativePath of executableTests) {
    const source = await read(`test/${relativePath}`);
    if (source.includes(PROTECTED_SOURCE_HASHES.firestoreRules)) {
      duplicatedCurrentHashes.push(relativePath);
    }
    if (source.includes(historicalHash)) {
      staleHistoricalHashes.push(relativePath);
    }
  }

  assert.deepEqual(duplicatedCurrentHashes, []);
  assert.deepEqual(staleHistoricalHashes, []);
});

test('legacy release and Functions-tree guards recognize the isolated C1A through C1G additions', async () => {
  const executableTests = await listExecutableTests();
  const missingFunctionTreeExclusions = [];
  const staleReleaseFamilyAllowlists = [];

  for (const relativePath of executableTests) {
    const source = await read(`test/${relativePath}`);
    const hashesFunctionsTree =
      source.includes("hashTree('functions'") ||
      (source.includes('hashTree(') && source.includes("'functions',"));
    const hashesFunctionsSourceTree =
      source.includes('hashFunctionTreeExcept(') && source.includes('unchangedFunctions');

    if (
      hashesFunctionsTree &&
      (!source.includes("'src/league-activity.ts'") ||
        !source.includes("'src/shared/core/league/league-activity.util.ts'") ||
        !source.includes("'src/shared/core/league/league-activity-reaction.util.ts'") ||
        !source.includes("'scripts/transaction-privacy-backfill.cjs'") ||
        !source.includes("'scripts/transaction-privacy-inspect.cjs'"))
    ) {
      missingFunctionTreeExclusions.push(relativePath);
    }

    if (
      hashesFunctionsSourceTree &&
      (!source.includes("'league-activity.ts'") ||
        !source.includes("'shared/core/league/league-activity.util.ts'") ||
        !source.includes("'shared/core/league/league-activity-reaction.util.ts'"))
    ) {
      missingFunctionTreeExclusions.push(relativePath);
    }

    if (
      source.includes('Release Candidate \d+ \/') &&
      source.includes('Data Quality Batch D1B') &&
      !source.includes('Social Batch C1G')
    ) {
      staleReleaseFamilyAllowlists.push(relativePath);
    }
  }

  assert.deepEqual(missingFunctionTreeExclusions, []);
  assert.deepEqual(staleReleaseFamilyAllowlists, []);
});

test('C1A documentation and permanent roadmap record the bounded foundation and privacy follow-up', async () => {
  const [roadmap, docsRoadmap, runbook, readme, freezeRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1A_LEAGUE_WIRE.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.26/);
  assert.match(roadmap, /\[~\] C1\.1/);
  assert.match(roadmap, /# \[x\] C1\.13/);
  assert.match(roadmap, /# \[x\] C1\.14/);
  assert.match(roadmap, /# \[x\] LOG\.30/);
  assert.match(roadmap, /# \[x\] LOG\.32/);
  assert.match(roadmap, /# \[x\] LOG\.33/);
  assert.match(roadmap, /inherited-integrity-baseline hotfix/i);
  assert.match(runbook, /pending waiver claims/i);
  assert.match(runbook, /Existing leagues are not backfilled/i);
  assert.match(runbook, /firestore:rules,functions,hosting:app/);
  assert.match(runbook, /single active source-controlled Firestore Rules hash baseline/i);
  assert.match(runbook, /whole-Functions-tree guards/i);
  assert.match(runbook, /release-family allowlists/i);
  assert.match(readme, /Release Candidate 35 \/ Social Batch C1I/);
  assert.match(readme, /RINKRAT_SOCIAL_C1A_LEAGUE_WIRE\.md/);
  assert.match(freezeRunbook, /rinkrat-rc35-validation\.json/);
  assert.match(freezeRunbook, /rinkrat-rc35-invite-beta/);
});
