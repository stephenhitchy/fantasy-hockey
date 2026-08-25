import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildPublicServiceStatusSnapshot,
  normalizeServiceIncidentAdminRecord,
  publicServiceIncident,
  serviceIncidentResponseTarget,
} from '../../functions/src/shared/core/operations/service-incident.util.ts';
import { normalizePublicServiceStatusSnapshot } from '../../src/app/core/operations/service-status.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function incident(overrides = {}) {
  return publicServiceIncident(normalizeServiceIncidentAdminRecord(
    overrides.incidentId ?? 'incident-a',
    {
      revision: 1,
      severity: 'p1',
      status: 'investigating',
      affectedComponents: ['draft'],
      competitiveImpact: 'unknown',
      dataState: 'live',
      dataMessage: '',
      userAction: 'avoid-draft',
      publicTitle: 'Draft confirmations are delayed',
      publicSummary: 'Some managers are waiting longer than expected for a confirmed Draft result.',
      publicGuidance: 'Do not repeat a pick while RinkRat is still confirming it.',
      internalTitle: 'Draft confirmation latency',
      internalNotes: 'Private evidence',
      nextUpdateAt: '2026-08-20T18:00:00Z',
      publicResolution: '',
      postmortemRequired: true,
      publicUpdates: [{
        updateId: 'update-1',
        status: 'investigating',
        message: 'The Draft remains authoritative while confirmation latency is investigated.',
        createdAt: '2026-08-20T17:00:00Z',
      }],
      startedAt: '2026-08-20T16:45:00Z',
      resolvedAt: null,
      createdAt: '2026-08-20T16:45:00Z',
      updatedAt: '2026-08-20T17:00:00Z',
      updatedBy: 'admin-a',
      ...overrides,
    },
  ));
}

test('public service status stays operational with no active incident', () => {
  const snapshot = buildPublicServiceStatusSnapshot([], '2026-08-20T18:00:00Z');

  assert.equal(snapshot.overallStatus, 'operational');
  assert.equal(snapshot.activeIncidents.length, 0);
  assert.match(snapshot.headline, /operational/i);
});

test('active P0 incident becomes the highest public service state and preserves manager guidance', () => {
  const snapshot = buildPublicServiceStatusSnapshot([
    incident({ incidentId: 'incident-p2', severity: 'p2', updatedAt: '2026-08-20T17:20:00Z' }),
    incident({
      incidentId: 'incident-p0',
      severity: 'p0',
      affectedComponents: ['scoring', 'rosters'],
      competitiveImpact: 'possible',
      userAction: 'read-only',
      publicTitle: 'Scoring publication is paused',
      publicGuidance: 'Use RinkRat as read-only while the scoring evidence is inspected.',
      updatedAt: '2026-08-20T17:10:00Z',
    }),
  ]);

  assert.equal(snapshot.overallStatus, 'major-incident');
  assert.equal(snapshot.activeIncidents[0].incidentId, 'incident-p0');
  assert.equal(snapshot.activeIncidents[0].userAction, 'read-only');
  assert.deepEqual(snapshot.activeIncidents[0].affectedComponents, ['rosters', 'scoring']);
});

test('resolved incidents leave the active banner and remain in recent history', () => {
  const snapshot = buildPublicServiceStatusSnapshot([
    incident({
      incidentId: 'resolved-a',
      status: 'resolved',
      nextUpdateAt: null,
      publicResolution: 'The delayed confirmation queue returned to normal and no duplicate Draft pick was recorded.',
      resolvedAt: '2026-08-20T19:00:00Z',
      updatedAt: '2026-08-20T19:00:00Z',
    }),
  ]);

  assert.equal(snapshot.overallStatus, 'operational');
  assert.equal(snapshot.activeIncidents.length, 0);
  assert.equal(snapshot.recentResolvedIncidents.length, 1);
  assert.equal(snapshot.recentResolvedIncidents[0].incidentId, 'resolved-a');
});

test('incident normalization rejects unknown public components and caps public updates', () => {
  const publicUpdates = Array.from({ length: 25 }, (_, index) => ({
    updateId: `update-${index}`,
    status: 'monitoring',
    message: `Public update ${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 20, 18, index)).toISOString(),
  }));
  const normalized = normalizeServiceIncidentAdminRecord('incident-b', {
    severity: 'p1',
    status: 'monitoring',
    affectedComponents: ['draft', 'unknown-component', 'draft'],
    competitiveImpact: 'none',
    userAction: 'continue',
    publicTitle: 'Draft service recovered',
    publicSummary: 'Draft confirmation is operating normally while RinkRat monitors recovery.',
    publicGuidance: 'Managers may continue normally.',
    publicUpdates,
    startedAt: '2026-08-20T17:00:00Z',
    createdAt: '2026-08-20T17:00:00Z',
    updatedAt: '2026-08-20T19:00:00Z',
  });

  assert.deepEqual(normalized.affectedComponents, ['draft']);
  assert.equal(normalized.publicUpdates.length, 20);
  assert.equal(normalized.publicUpdates[0].updateId, 'update-24');
});

test('incident data state distinguishes live authority from stale read-only presentation', () => {
  const stale = normalizeServiceIncidentAdminRecord('incident-stale', {
    severity: 'p1',
    status: 'identified',
    affectedComponents: ['game-center', 'scoring'],
    competitiveImpact: 'possible',
    dataState: 'stale-read-only',
    dataMessage: 'Previously loaded matchups may be viewed, but live totals are not authoritative.',
    userAction: 'read-only',
    publicTitle: 'Live matchup data is delayed',
    publicSummary: 'RinkRat is investigating delayed live matchup publication.',
    publicGuidance: 'Use existing screens as read-only until the next update.',
    createdAt: '2026-08-20T17:00:00Z',
    startedAt: '2026-08-20T17:00:00Z',
    updatedAt: '2026-08-20T17:10:00Z',
  });

  assert.equal(stale.dataState, 'stale-read-only');
  assert.match(stale.dataMessage, /not authoritative/);
  assert.equal(publicServiceIncident(stale).dataState, 'stale-read-only');
});



test('client status cache normalization fails closed on malformed saved data', () => {
  assert.equal(normalizePublicServiceStatusSnapshot({ overallStatus: 'operational' }), null);

  const normalized = normalizePublicServiceStatusSnapshot({
    generatedAt: '2026-08-20T18:00:00Z',
    overallStatus: 'degraded',
    headline: 'Some RinkRat services are degraded',
    detail: 'One active incident is currently posted.',
    activeIncidents: [
      incident({ incidentId: 'cache-valid' }),
      { incidentId: 'cache-invalid', title: '', publicUpdates: null },
    ],
    recentResolvedIncidents: [],
  });

  assert.equal(normalized?.activeIncidents.length, 1);
  assert.equal(normalized?.activeIncidents[0].incidentId, 'cache-valid');
});

test('P0 incidents always require a private post-incident review', () => {
  const normalized = normalizeServiceIncidentAdminRecord('incident-p0-review', {
    severity: 'p0',
    status: 'investigating',
    affectedComponents: ['scoring'],
    competitiveImpact: 'possible',
    dataState: 'delayed',
    dataMessage: 'Live score publication is delayed while authoritative evidence is inspected.',
    userAction: 'read-only',
    publicTitle: 'Scoring publication is delayed',
    publicSummary: 'RinkRat is reviewing delayed authoritative scoring publication.',
    publicGuidance: 'Use RinkRat as read-only until the next update.',
    postmortemRequired: false,
    createdAt: '2026-08-20T17:00:00Z',
    startedAt: '2026-08-20T17:00:00Z',
    updatedAt: '2026-08-20T17:05:00Z',
  });

  assert.equal(normalized.postmortemRequired, true);
});

test('response targets preserve the tester-season P0-P3 operating contract', () => {
  assert.match(serviceIncidentResponseTarget('p0'), /30 minutes/);
  assert.match(serviceIncidentResponseTarget('p1'), /2 hours/);
  assert.match(serviceIncidentResponseTarget('p2'), /one business day/);
  assert.match(serviceIncidentResponseTarget('p3'), /do not destabilize the season/i);
});

test('incident authority separates public projections from private evidence and requires recent admin authentication', async () => {
  const source = await read('functions/src/service-incident-authority.ts');

  assert.match(source, /requireVerifiedRecentAuthentication/);
  assert.match(source, /assessOperationsClientCompatibility/);
  assert.match(source, /normalizeOperationsClientIdentity/);
  assert.doesNotMatch(source, /CURRENT_BUILD_ID_PATTERN/);
  assert.match(source, /buildIdentity\(input\['build'\], true\)/);
  assert.match(source, /platformIncidents/);
  assert.match(source, /publicServiceIncidents/);
  assert.match(source, /internalNote/);
  assert.match(source, /publicUpdate/);
  assert.doesNotMatch(source.match(/function publicStoredData[\s\S]*?\n}/)?.[0] ?? '', /updatedBy/);
  assert.match(source, /Resolved incidents are immutable/);
  assert.doesNotMatch(source, /transaction\.delete\(privateReference\)|transaction\.delete\(publicReference\)/);
});

test('public Status and administrator Incident Center remain separate, accessible, and inline', async () => {
  const [routes, publicPage, publicComponent, adminPage, mainLayout, supportHome, knownIssues, adminCenter] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/features/support/service-status/service-status.html'),
    read('src/app/features/support/service-status/service-status.ts'),
    read('src/app/features/admin/service-incidents/service-incidents.html'),
    read('src/app/layouts/main-layout/main-layout.html'),
    read('src/app/features/support/support-home/support-home.html'),
    read('src/app/features/support/known-issues/known-issues.html'),
    read('src/app/features/admin/admin-center/admin-center.html'),
  ]);

  assert.equal((routes.match(/path: 'status'/g) ?? []).length, 1);
  assert.equal((routes.match(/path: 'admin\/incidents'/g) ?? []).length, 1);
  assert.match(routes, /path: 'admin\/incidents'[\s\S]*platformAdminGuard/);
  assert.match(publicPage, /Service Status/);
  assert.match(publicPage, /Manager guidance/);
  assert.match(publicPage, /Competition data/);
  assert.match(publicPage, /saved public-status copy/i);
  assert.match(publicComponent, /inject\(ServiceStatusService\)/);
  assert.doesNotMatch(publicComponent, /constructor\(private readonly statusService/);
  assert.match(adminPage, /Incident Command Center/);
  assert.match(adminPage, /Private operating note/);
  assert.match(adminPage, /Competition data state/);
  assert.match(mainLayout, /serviceStatus\.bannerIncident/);
  assert.match(mainLayout, /routerLink="\/status"/);
  assert.match(mainLayout, /Saved status · confirm live details/);
  assert.match(adminPage, /Latest private operating note/);
  assert.match(adminPage, /Private post-incident review required for P0/);
  assert.match(supportHome, /Live service status/);
  assert.match(knownIssues, /Live Service Status/);
  assert.match(adminCenter, /Incident Center/);
  assert.doesNotMatch(publicPage + adminPage, /role="dialog"|viewport-overlay|action-sheet/i);
});

test('private-season integrity health counts active P0 incidents without changing scoring or queue authority', async () => {
  const [health, healthUtil, scoring, projection, rules, indexes] = await Promise.all([
    read('functions/src/private-season-health.ts'),
    read('functions/src/shared/core/operations/private-season-health.util.ts'),
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
  ]);

  assert.match(health, /publicServiceIncidents/);
  assert.match(health, /activeP0IncidentCount/);
  assert.match(healthUtil, /active P0 incident/);
  assert.match(scoring, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);
  assert.match(projection, /PROJECTION_MODEL_VERSION\s*=\s*11/);
  assert.doesNotMatch(rules, /publicServiceIncidents|platformIncidents/);
  assert.doesNotMatch(indexes, /publicServiceIncidents|platformIncidents/);
});

test('O1D release records the incident/status milestone and the next open operating gaps', async () => {
  const [roadmap, docsRoadmap, readme, runbook, packageSource, runtime, productionRuntime, freezeSource] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('README.md'),
    read('docs/RINKRAT_OPERATIONS_O1D_INCIDENT_STATUS.md'),
    read('package.json'),
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const freeze = JSON.parse(freezeSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.54/);
  assert.match(roadmap, /Operations Batch O1D/);
  assert.match(roadmap, /LOG\.66/);
  assert.match(readme, /Release Candidate 65 \/ Beta Batch B1J/);
  assert.match(runbook, /public Service Status/i);
  assert.match(runbook, /no silent score edits/i);
  assert.match(runtime, /Release Candidate 65/);
  assert.match(productionRuntime, /Release Candidate 65/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 65');
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.equal(freeze.verificationCommand, 'npm run verify:batchb1j');
  assert.equal(freeze.defaultTag, 'rinkrat-rc65-invite-beta');
  assert.match(packageJson.scripts['verify:batcho1i:core'], /verify:batcho1h:core/);
  assert.match(packageJson.scripts['verify:batcho1f:core'], /verify:batcho1e:core/);
  assert.match(packageJson.scripts['verify:batcho1e:core'], /verify:batcho1d:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batchb1j:core/);
});
