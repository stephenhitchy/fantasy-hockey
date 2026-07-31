import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('historical replay controls are visible only to a verified platform administrator', async () => {
  const template = await read('src/app/features/cycles/cycle-one/cycle-one.html');

  assert.match(template, /@if \(isCommissioner\(\) \|\| isPlatformAdmin\(\)\)/);
  assert.match(
    template,
    /@if \(isPlatformAdmin\(\)\) \{[\s\S]*?historical-replay-control[\s\S]*?Advance One NHL Day[\s\S]*?\n\s*\}/,
  );
  assert.match(
    template,
    /@if \(isCommissioner\(\)\) \{[\s\S]*?Refresh Shared Scores[\s\S]*?Finalize Ready/,
  );
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
