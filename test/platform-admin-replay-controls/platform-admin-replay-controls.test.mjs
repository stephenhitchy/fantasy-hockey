import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('all Game Center testing controls are visible only to a verified platform administrator', async () => {
  const template = await read('src/app/features/cycles/cycle-one/cycle-one.html');
  const start = template.indexOf('Testing Controls');
  const end = template.indexOf('<app-cycle-matchup-toolbar', start);

  assert.notEqual(start, -1, 'Testing Controls summary is missing.');
  assert.notEqual(end, -1, 'Unable to isolate the Testing Controls block.');

  const controls = template.slice(Math.max(0, start - 300), end);

  assert.match(controls, /@if \(isPlatformAdmin\(\)\)/);
  assert.doesNotMatch(controls, /isCommissioner\(\)/);
  assert.match(controls, /Advance One NHL Day/);
  assert.match(controls, /Send Test Injury Email/);
  assert.match(controls, /Refresh Shared Scores/);
  assert.match(controls, /Finalize Ready/);
  assert.match(controls, /Open .*getNextCycleLabel/);
});

test('Game Center verifies platform-admin access through the shared authority service', async () => {
  const source = await read('src/app/features/cycles/cycle-one/cycle-one.ts');

  assert.match(source, /inject\(PlatformAdminService\)/);
  assert.match(source, /readonly isPlatformAdmin = this\.platformAdminService\.isAdmin/);
  assert.match(source, /platformAdminService\.refreshAccess\(true\)/);
});

test('the historical replay callable enforces platform-admin authority on the server', async () => {
  const source = await read('functions/src/league-automation.ts');
  const start = source.indexOf('export const advanceHistoricalReplayDay = onCall(');
  const end = source.indexOf('\nexport const ', start + 1);
  const callable = source.slice(start, end > start ? end : source.length);

  assert.match(source, /request\.auth\?\.token\?\.\['platformAdmin'\] === true/);
  assert.match(source, /db\.doc\(`platformAdmins\/\$\{userId\}`\)\.get\(\)/);
  assert.match(source, /Only a RinkRat platform administrator can advance historical replay time/);
  assert.match(callable, /requireHistoricalReplayPlatformAdmin\(request\)/);
  assert.doesNotMatch(callable, /league\.commissionerId !== userId/);
});
