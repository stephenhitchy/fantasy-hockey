import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  shouldTreatLeagueAutomationDueAgeAsBacklog,
} from '../../functions/src/shared/core/live-scoring/league-automation-season-safety.util.ts';
import {
  getInviteBetaBuildIntegrityBlocker,
} from '../../src/app/core/release/invite-beta-validation.util.ts';
import {
  evaluateCleanDeploySource,
  parseGitStatusPaths,
} from '../../scripts/release/clean-deploy-source.util.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');

async function sha256(relativePath) {
  return createHash('sha256').update(await read(relativePath)).digest('hex');
}

function manifest(sourceRevision) {
  return {
    schemaVersion: 1,
    releaseLabel: 'Release Candidate 65',
    buildId: 'release-candidate-65-test',
    builtAt: '2026-08-27T00:00:00.000Z',
    sourceRevision,
    packageVersion: '0.0.0',
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
}

test('Shadow due schedules are observation evidence rather than queue backlog', () => {
  assert.equal(shouldTreatLeagueAutomationDueAgeAsBacklog('shadow'), false);
  assert.equal(shouldTreatLeagueAutomationDueAgeAsBacklog('canary'), true);
  assert.equal(shouldTreatLeagueAutomationDueAgeAsBacklog('primary'), true);
});

test('the server separates observed due age from eligible queue backlog age', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /const dueAgeRepresentsBacklog =\s*shouldTreatLeagueAutomationDueAgeAsBacklog\(input\.config\.mode\)/);
  assert.match(source, /dueAgeRepresentsBacklog &&\s*oldestDueAge > LEAGUE_AUTOMATION_SEASON_SAFETY_BACKLOG_BLOCKING_MILLISECONDS/);
  assert.match(source, /queueOldestObservedDueAgeMilliseconds/);
  assert.match(source, /const oldestObservedDueAt/);
  assert.match(source, /const oldestEligibleDueAt/);
  assert.match(source, /oldest eligible due league/);
  assert.match(source, /observation evidence, not queued backlog/);
  assert.doesNotMatch(source, /!dueAgeRepresentsBacklog &&\s*oldestDueAge > LEAGUE_AUTOMATION_SEASON_SAFETY_BACKLOG_WARNING_MILLISECONDS/);
});

test('clean deployment evidence accepts one committed revision and rejects dirty source', () => {
  const clean = evaluateCleanDeploySource({
    revision: 'a'.repeat(40),
    statusOutput: '',
  });
  assert.equal(clean.ready, true);
  assert.deepEqual(clean.blockers, []);

  const dirty = evaluateCleanDeploySource({
    revision: 'a'.repeat(40),
    statusOutput: ' M src/app/app.ts\n?? local-notes.txt\n',
  });
  assert.equal(dirty.ready, false);
  assert.deepEqual(dirty.dirtyPaths, ['src/app/app.ts', 'local-notes.txt']);
  assert.match(dirty.blockers.join(' '), /unreproducible/);

  assert.deepEqual(
    parseGitStatusPaths('M  README.md\nR  old.ts -> new.ts\n?? scratch.txt\n'),
    ['README.md', 'old.ts -> new.ts', 'scratch.txt'],
  );
});

test('Firebase Functions and Hosting fail closed around clean builds', async () => {
  const firebase = JSON.parse(await read('firebase.json'));
  const packageJson = JSON.parse(await read('package.json'));

  for (const hooks of [firebase.functions[0].predeploy, firebase.hosting.predeploy]) {
    assert.equal(hooks.length, 3);
    assert.match(hooks[0], /release:verify-clean-deploy-source/);
    assert.match(hooks[1], /run build/);
    assert.match(hooks[2], /release:verify-clean-deploy-source/);
  }

  assert.match(packageJson.scripts['release:verify-clean-deploy-source'], /verify-clean-deploy-source/);
  assert.match(packageJson.scripts['deploy:production'], /refuse-broad-production-deploy/);
  assert.match(packageJson.scripts['deploy:season-ready'], /refuse-broad-production-deploy/);
});



test('Firebase CLI and Emulator Suite debug logs cannot dirty a release build', async () => {
  const gitignore = await read('.gitignore');
  const recovery = await read('scripts/security/sync-repository-automation.mjs');

  assert.match(gitignore, /^\/\*-debug\.log$/m);
  assert.match(gitignore, /^\/\*-debug\.\*\.log$/m);
  assert.match(recovery, /FIREBASE_DEBUG_IGNORE_RULES/);
  assert.match(recovery, /Firebase CLI and Emulator Suite debug logs/);
});

test('Release Readiness displays one required clean-source check', async () => {
  const source = await read('src/app/core/release/release-readiness.service.ts');
  assert.match(source, /'clean-source-revision'/);
  assert.match(source, /Deployed source revision is clean and reproducible/);
  assert.match(source, /cleanSourceRevision \? 'pass' : 'fail'/);
  assert.match(source, /oldest observed due age/);
  assert.match(source, /oldest eligible due age/);
});

test('dirty and unversioned deployments cannot pass final invite-beta validation', () => {
  assert.equal(
    getInviteBetaBuildIntegrityBlocker(
      manifest('81e7cae25dc97407ed768dbf42f7e97463ad1579-dirty'),
    ),
    'The deployed build was created from uncommitted source. Commit the release, rebuild it, redeploy Hosting, and repeat validation on the clean build.',
  );
  assert.match(
    getInviteBetaBuildIntegrityBlocker(manifest('unversioned')) ?? '',
    /clean 40-character Git revision/,
  );
  assert.equal(
    getInviteBetaBuildIntegrityBlocker(
      manifest('81e7cae25dc97407ed768dbf42f7e97463ad1579'),
    ),
    null,
  );
});

test('the validation component passes the exact deployed manifest into the launch gate', async () => {
  const source = await read(
    'src/app/features/release/invite-beta-validation/invite-beta-validation.ts',
  );
  const util = await read('src/app/core/release/invite-beta-validation.util.ts');

  assert.match(source, /releaseManifest: this\.releaseManifest/);
  assert.match(util, /releaseManifest: ReleaseManifest \| null/);
  assert.match(util, /const buildIntegrityBlocker = getInviteBetaBuildIntegrityBlocker/);
  assert.match(util, /hasHardFailure = true/);
});

test('the existing freeze validators still reject a dirty source revision independently', async () => {
  const inviteFreeze = await read('scripts/release/invite-beta-release.util.mjs');
  const seasonFreeze = await read('scripts/release/season-freeze.util.mjs');

  assert.match(inviteFreeze, /The live release manifest does not contain one clean 40-character Git revision/);
  assert.match(seasonFreeze, /The scoring evidence does not contain one clean deployed source revision/);
});

test('D1J.2 preserves scoring, Projection V11, Rules, and indexes', async () => {
  const protectedPaths = {
    scoringRules: 'src/app/core/scoring/scoring-rules.ts',
    scoringEngine: 'src/app/core/scoring/scoring-engine.ts',
    projectionV11: 'src/app/core/projection/projection-v11.util.ts',
    firestoreRules: 'firestore.rules',
    firestoreIndexes: 'firestore.indexes.json',
  };

  for (const [key, relativePath] of Object.entries(protectedPaths)) {
    assert.equal(
      await sha256(relativePath),
      PROTECTED_SOURCE_HASHES[key],
      relativePath,
    );
  }
});

test('D1J.2 scripts, documentation, and synchronized roadmaps are present', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  const rootRoadmap = await read('RINKRAT_COMPETITIVE_ROADMAP.txt');
  const docsRoadmap = await read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt');
  const documentation = await read(
    'docs/RINKRAT_OPERATIONS_D1J2_RELEASE_EVIDENCE_REPAIR.md',
  );

  assert.equal(
    packageJson.scripts['test:batchd1j2:run'],
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchd1j2-release-evidence-repair/*.test.mjs',
  );
  assert.match(packageJson.scripts['verify:batchd1j2:core'], /verify:batchd1j1:core/);
  assert.match(documentation, /Shadow due schedules are not a backlog/);
  assert.match(documentation, /functions:dispatchDueLeagueAutomation/);
  assert.match(documentation, /functions:getLeagueAutomationQueueControlCenter/);
  assert.match(documentation, /functions:monitorLeagueAutomationSeasonSafety/);
  assert.match(documentation, /functions:updateLeagueAutomationQueueConfig/);
  assert.match(rootRoadmap, /LOG\.94 2026-08-27/);
  assert.equal(rootRoadmap, docsRoadmap);
});
