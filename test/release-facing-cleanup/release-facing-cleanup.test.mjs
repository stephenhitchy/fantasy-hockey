import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');

test('Game Center fully retires the embedded cycle explainer and its dead styles', async () => {
  const html = await read('src/app/features/cycles/cycle-one/cycle-one.html');
  const ts = await read('src/app/features/cycles/cycle-one/cycle-one.ts');
  const css = await read('src/app/features/cycles/cycle-one/cycle-one.css');

  assert.doesNotMatch(html, /app-cycle-explainer|How the six-game window works/i);
  assert.doesNotMatch(ts, /CycleExplainer|cycle-explainer/);
  assert.doesNotMatch(
    css,
    /cycle-explainer|cycle-step-grid|cycle-example-card|marker-guide|window-marker-legend/,
  );
  await assert.rejects(
    access('src/app/features/cycles/cycle-one/components/cycle-explainer/cycle-explainer.ts'),
  );
});

test('Game Center testing controls are rendered only for platform admins', async () => {
  const html = await read('src/app/features/cycles/cycle-one/cycle-one.html');
  const controlsStart = html.indexOf('Testing Controls');
  assert.notEqual(controlsStart, -1, 'Testing Controls should remain available to the owner account.');

  const controls = html.slice(Math.max(0, controlsStart - 350), controlsStart + 12_000);
  assert.match(controls, /@if \(isPlatformAdmin\(\)\)/);
  assert.doesNotMatch(controls, /@if \(isCommissioner\(\) \|\| isPlatformAdmin\(\)\)/);
  assert.match(controls, /Advance One NHL Day/);
  assert.match(controls, /Send Test Injury Email/);
  assert.match(controls, /Refresh Shared Scores/);
  assert.match(controls, /Finalize Ready/);
  assert.match(controls, /Open.*Next Period|Open.*Cycle|startNextCycleFromCurrentCycle/);
});

test('explicit simulator and diagnostics routes require platform-admin access', async () => {
  const routes = await read('src/app/app.routes.ts');
  for (const path of [
    "path: 'scoring-test'",
    "path: 'leagues/:leagueId/live-scoring'",
    "path: 'leagues/:leagueId/release-readiness'",
    "path: 'leagues/:leagueId/playoffs/simulator'",
    "path: 'leagues/:leagueId/cycles/simulator'",
  ]) {
    const start = routes.indexOf(path);
    assert.notEqual(start, -1, `Missing route ${path}`);
    const block = routes.slice(start, start + 460);
    assert.match(block, /platformAdminGuard/);
    assert.doesNotMatch(block, /developerToolsGuard/);
  }
});

test('League HQ hides private diagnostics from ordinary commissioners', async () => {
  const html = await read('src/app/features/leagues/league-detail/league-detail.html');
  const ts = await read('src/app/features/leagues/league-detail/league-detail.ts');
  const start = html.indexOf('Owner Tools');
  assert.notEqual(start, -1);
  const preceding = html.slice(Math.max(0, start - 300), start);
  assert.match(preceding, /@if \(isPlatformAdmin\(\)\)/);
  assert.match(html, /Private diagnostics/);
  assert.match(ts, /PlatformAdminService/);
  assert.match(ts, /refreshAccess\(\)/);
});
