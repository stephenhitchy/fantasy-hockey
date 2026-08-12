import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function sha256(relativePath) {
  const content = await readFile(new URL(relativePath, ROOT));
  return createHash('sha256').update(content).digest('hex');
}

test('B1B exports bounded beta evidence, public issue, triage, and operations callables', async () => {
  const [source, index, service] = await Promise.all([
    read('functions/src/beta-operations.ts'),
    read('functions/src/index.ts'),
    read('src/app/core/beta-operations/beta-operations.service.ts'),
  ]);

  for (const callable of [
    'recordBetaOperationMetric',
    'getPublicBetaKnownIssues',
    'updateBetaFeedbackTriage',
    'getBetaOperationsSnapshot',
  ]) {
    assert.match(source, new RegExp(`export const ${callable} = onCall`));
    assert.match(index, new RegExp(callable));
  }

  assert.match(source, /timeoutSeconds: 15/);
  assert.match(source, /timeoutSeconds: 20/);
  assert.match(source, /timeoutSeconds: 35/);
  assert.match(source, /timeoutSeconds: 60/);
  assert.match(service, /recordBetaOperationMetric/);
  assert.match(service, /getPublicBetaKnownIssues/);
  assert.match(service, /Evidence collection must never block or visually affect a competitive action/);
  assert.match(source, /clientSampleLimitReached/);
  assert.match(source, /BETA_EVIDENCE_ADMIN_LIMIT \+ 1/);
});

test('structured feedback distinguishes integrity, blockers, usability, cosmetics, ideas, and private context', async () => {
  const [component, template, server] = await Promise.all([
    read('src/app/features/support/feedback/feedback.ts'),
    read('src/app/features/support/feedback/feedback.html'),
    read('functions/src/index.ts'),
  ]);

  for (const category of [
    'competition-integrity',
    'blocked-action',
    'serious-usability',
    'cosmetic',
    'feature-idea',
    'account-privacy',
  ]) {
    assert.match(component, new RegExp(category));
    assert.match(server, new RegExp(category));
  }

  assert.match(template, /What happened\?/);
  assert.match(template, /What did you expect\?/);
  assert.match(template, /Steps to reproduce/);
  assert.match(template, /Privacy-limited technical context/);
  assert.match(component, /buildFeedbackContext/);
  assert.match(server, /schemaVersion: 2/);
  assert.match(server, /expectedResult/);
  assert.match(server, /reproductionSteps/);
});

test('feedback league context is verified then stored only as a short private reference', async () => {
  const source = await read('functions/src/index.ts');
  const start = source.indexOf('export const submitFeedback = onCall');
  const end = source.indexOf('const ADMIN_FEEDBACK_STATUSES', start);
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(block, /hasLeagueAccess/);
  assert.match(block, /feedbackLeagueContextReference\(leagueId\)/);
  assert.match(block, /hasLeagueContext: Boolean\(leagueId\)/);
  assert.doesNotMatch(block, /\n\s*leagueId,\s*\n/);
  assert.doesNotMatch(block, /rawLeagueId/);
});

test('known issues are administrator-written, sanitized, and visible on a dedicated public page', async () => {
  const [server, route, component, template] = await Promise.all([
    read('functions/src/beta-operations.ts'),
    read('src/app/app.routes.ts'),
    read('src/app/features/support/known-issues/known-issues.ts'),
    read('src/app/features/support/known-issues/known-issues.html'),
  ]);

  assert.match(server, /publicTitle/);
  assert.match(server, /publicSummary/);
  assert.match(server, /betaKnownIssues/);
  assert.match(server, /A manager report is never published automatically|publishKnownIssue/);
  assert.doesNotMatch(server.slice(server.indexOf('function publicKnownIssue'), server.indexOf('function durationOverview')), /userId|email|leagueId/);
  assert.match(route, /path: 'support\/known-issues'/);
  assert.match(component, /loadPublicKnownIssues/);
  assert.match(template, /No open issue is currently published/);
  assert.match(template, /Recently resolved issues/);
});

test('the Beta Operations Center supports private triage and live evidence in one accessible page', async () => {
  const [component, template, service] = await Promise.all([
    read('src/app/features/admin/admin-center/admin-center.ts'),
    read('src/app/features/admin/admin-center/admin-center.html'),
    read('src/app/core/admin/platform-admin.service.ts'),
  ]);

  assert.match(component, /'feedback' \| 'errors' \| 'evidence'/);
  assert.match(component, /saveFeedback/);
  assert.match(component, /refreshEvidenceWindow/);
  assert.match(template, /Feedback Triage/);
  assert.match(template, /Error Groups/);
  assert.match(template, /Live Evidence/);
  assert.match(template, /Publish a sanitized known issue/);
  assert.match(template, /Competitive action responsiveness/);
  assert.match(template, /Route readiness and Firestore listener load/);
  assert.match(template, /Server scoring worker/);
  assert.match(template, /privacy-limited manager-days/);
  assert.match(service, /getBetaOperationsSnapshot/);
  assert.match(service, /updateBetaFeedbackTriage/);
  assert.match(service, /getBetaOperationsSnapshot/);
});

test('client evidence is sampled from completed competitive actions and generalized route readiness', async () => {
  const [monitor, performance, service] = await Promise.all([
    read('src/app/core/observability/competitive-action-monitor.service.ts'),
    read('src/app/core/observability/client-performance-monitor.service.ts'),
    read('src/app/core/beta-operations/beta-operations.service.ts'),
  ]);

  assert.match(monitor, /this\.betaOperations\.recordCompetitiveAction\(record\)/);
  assert.match(performance, /this\.betaOperations\.recordRouteReady/);
  assert.match(service, /ROUTE_SAMPLE_COOLDOWN_MILLISECONDS = 10 \* 60 \* 1_000/);
  assert.match(service, /MAX_ROUTE_SAMPLES_PER_SESSION = 24/);
  assert.match(service, /viewportCategory/);
  assert.match(service, /appCheckClientStatus/);
  assert.match(service, /listenerCount/);
});

test('server scoring duration is aggregated into 16 daily shards without affecting scoring success', async () => {
  const [automation, utility] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/shared/core/observability/beta-operations.util.ts'),
  ]);

  assert.match(utility, /BETA_OPERATION_SHARD_COUNT = 16/);
  assert.match(utility, /BETA_OPERATION_DAILY_RETENTION_MILLISECONDS = 180/);
  assert.match(utility, /betaHistogramPercentile/);
  assert.match(automation, /recordBetaServerScoringMetric/);
  assert.match(automation, /betaOperationsDaily/);
  assert.match(automation, /'success'/);
  assert.match(automation, /'skipped'/);
  assert.match(automation, /'error'/);
  assert.match(automation, /\.catch\(\(\) => undefined\)/);
});

test('B1B evidence collections have source-controlled TTL and scheduled cleanup fallback', async () => {
  const [ttl, retention, cleanup, audit] = await Promise.all([
    read('config/firestore-ttl-baseline.json'),
    read('config/security-retention-policy.json'),
    read('functions/src/security-operations.ts'),
    read('scripts/security/verify-retention.mjs'),
  ]);
  const ttlConfig = JSON.parse(ttl);
  const retentionConfig = JSON.parse(retention);

  assert.equal(ttlConfig.policies.length, 9);
  assert.equal(retentionConfig.collections.length, 9);
  assert.ok(ttlConfig.policies.some((item) => item.collectionGroup === 'betaEvidenceEvents' && item.retention === '90 days'));
  assert.ok(ttlConfig.policies.some((item) => item.collectionGroup === 'betaOperationsDaily' && item.retention === '180 days'));
  assert.match(cleanup, /collection: 'betaEvidenceEvents'/);
  assert.match(cleanup, /collection: 'betaOperationsDaily'/);
  assert.match(audit, /betaEvidenceEvents/);
  assert.match(audit, /betaOperationsDaily/);
});

test('privacy language and the beta operations runbook state the collection limits and triage rules', async () => {
  const [privacy, runbook] = await Promise.all([
    read('src/app/features/legal/privacy/privacy.html'),
    read('docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md'),
  ]);

  assert.match(privacy, /privacy-limited (?:beta|operational) evidence/i);
  assert.match(privacy, /daily rotating/i);
  assert.match(privacy, /90 days/);
  assert.match(privacy, /180 days/);
  assert.match(runbook, /Competition integrity/);
  assert.match(runbook, /Blocked action/);
  assert.match(runbook, /A manager report is never published automatically/);
  assert.match(runbook, /raw manager IDs, raw league IDs, player IDs/);
  assert.match(runbook, /Stop or roll back immediately/);
});

test('B1B release, verification, documentation, and permanent roadmap remain synchronized', async () => {
  const [packageSource, readme, docs, roadmap, docsRoadmap, runtime, productionRuntime] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts['verify:batchb1b'], /verify:batchb1b:core/);
  assert.match(packageJson.scripts['verify:batchb1b:core'], /verify:batchs3c:core/);
  assert.match(packageJson.scripts['verify:batchb1b:core'], /test:batchb1b:run/);
  assert.match(packageJson.scripts['security:ci'], /verify:batch(?:b1b|b1b-1|b1c|s4a|b1d|s3d|s3e|s3e-1|s3e-1-1|s3f):core/);
  assert.match(readme, /RINKRAT_BETA_OPERATIONS_RUNBOOK\.md/);
  assert.match(readme, /verify:batchb1b/);
  assert.match(docs, /Beta Operations Batch B1B/);
  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.\d+(?:\.\d+)?/);
  assert.match(roadmap, /# \[x\] B1\.6/);
  assert.match(roadmap, /# \[x\] B1\.23/);
  assert.match(roadmap, /# \[x\] LOG\.16/);
  const runtimeRelease = Number(runtime.match(/Release Candidate (\d+)/)?.[1] ?? 0);
  const productionRelease = Number(productionRuntime.match(/Release Candidate (\d+)/)?.[1] ?? 0);
  assert.ok(runtimeRelease >= 21);
  assert.ok(productionRelease >= 21);
});

test('B1B preserves Production Scoring V3, Projection V11, Firestore Rules, and indexes', async () => {
  const expected = JSON.parse(await read('test/batchs3c-ci-browser-retention/preserved-source-hashes.json'));

  assert.equal(await sha256('src/app/core/scoring/scoring-rules.ts'), expected.scoringRules);
  assert.equal(await sha256('src/app/core/scoring/scoring-engine.ts'), expected.scoringEngine);
  assert.equal(await sha256('src/app/core/projection/projection-v11.util.ts'), expected.projectionV11);
  assert.equal(await sha256('firestore.rules'), expected.firestoreRules);
  assert.equal(await sha256('firestore.indexes.json'), expected.firestoreIndexes);
});
