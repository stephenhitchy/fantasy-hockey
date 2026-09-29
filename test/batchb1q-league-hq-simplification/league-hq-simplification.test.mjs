import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldShowPreDraftCommissionerManagement } from '../../src/app/features/leagues/league-detail/league-hq-visibility.util.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('League HQ removes the redundant status and injury overview shown in the old mobile layout', async () => {
  const template = await read('src/app/features/leagues/league-detail/league-detail.html');

  for (const removedMarker of [
    'league-overview-section',
    'league-status-title',
    'league-info-grid',
    'cycle-status-card',
    'cycle-matchup-preview',
    'daily-injury-status',
    'Daily Injury Report',
  ]) {
    assert.doesNotMatch(template, new RegExp(removedMarker));
  }

  assert.match(template, /<app-league-wire/);
  assert.match(template, /class="teams-section"/);
  assert.match(template, /class="league-secondary-tools"/);
});

test('league size and member management render only during commissioner pre-draft setup', () => {
  const visible = (draftStatus, hasStartedCompetition = false, isCommissioner = true) =>
    shouldShowPreDraftCommissionerManagement({
      isCommissioner,
      draftStatus,
      hasStartedCompetition,
    });

  assert.equal(visible(undefined), true);
  assert.equal(visible('setup'), true);
  assert.equal(visible('scheduled'), true);
  assert.equal(visible('live'), false);
  assert.equal(visible('complete'), false);
  assert.equal(visible('complete', true), false);
  assert.equal(visible('setup', true), false);
  assert.equal(visible('setup', false, false), false);
});

test('the template gates pre-draft management while retaining commissioner and danger tools', async () => {
  const template = await read('src/app/features/leagues/league-detail/league-detail.html');
  const gateIndex = template.indexOf('@if (showPreDraftCommissionerManagement())');
  const capacityIndex = template.indexOf('league-capacity-disclosure');
  const membersIndex = template.indexOf('commissioner-member-management');
  const dangerIndex = template.indexOf('commissioner-danger-zone');

  assert.ok(gateIndex >= 0, 'Missing the pre-draft commissioner visibility gate.');
  assert.ok(capacityIndex > gateIndex, 'League size must be inside the pre-draft gate.');
  assert.ok(membersIndex > capacityIndex, 'Member management must follow league size inside the gate.');
  assert.ok(dangerIndex > membersIndex, 'The danger zone remains available after the pre-draft controls hide.');
  assert.match(template, /class="league-tools commissioner-tools"/);
  assert.match(template, /<strong>Commissioner tools<\/strong>/);
  assert.match(template, /Commissioner Playbook/);
});

test('the component derives the visibility gate from draft and competition state', async () => {
  const component = await read('src/app/features/leagues/league-detail/league-detail.ts');

  assert.match(component, /readonly showPreDraftCommissionerManagement = computed/);
  assert.match(component, /draftStatus: this\.draft\(\)\?\.status/);
  assert.match(component, /hasStartedCompetition: Boolean\(this\.cycle\(\)\)/);
});

test('Batch B1Q verification inherits the prior release gate', async () => {
  const [packageSource, pageAudit] = await Promise.all([
    read('package.json'),
    read('scripts/audit-page-design-migration.mjs'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts?.['verify:batchb1q:core'] ?? '', /verify:batchb1p:core/);
  assert.match(packageJson.scripts?.['verify:batchb1q:core'] ?? '', /test:batchb1q:run/);
  assert.match(packageJson.scripts?.['verify:batchb1q'] ?? '', /security:dependency-audit/);
  assert.match(pageAudit, /'rr-card', 'rr-section-heading', 'rr-action-tile'/);
});
