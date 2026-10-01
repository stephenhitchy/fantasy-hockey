import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);

  return text.slice(start, end);
}

test('My Team uses the live schedule club for a transferred skater label and badge', async () => {
  const [component, template] = await Promise.all([
    source('src/app/features/team/team-settings/team-settings.ts'),
    source('src/app/features/team/team-settings/team-settings.html'),
  ]);
  const teamLabel = section(
    component,
    'getRosterAssetTeamLabel(',
    'getRosterAssetPortrait(',
  );
  const portrait = section(
    component,
    'getRosterAssetPortrait(',
    'getRosterAssetProjection(',
  );

  assert.match(
    teamLabel,
    /getRosterAssetScoreSummary\(asset\)\s*\?\.scheduleTeamAbbreviation/,
  );
  assert.match(portrait, /rosterAsset\.assetType !== 'skater'/);
  assert.match(
    portrait,
    /logos\/nhl\/svg\/\$\{currentTeamAbbreviation\}_light\.svg/,
  );
  assert.match(template, /\[asset\]="getRosterAssetPortrait\(asset\)"/);
});

test('team-goalie units keep their fixed club portrait', async () => {
  const component = await source(
    'src/app/features/team/team-settings/team-settings.ts',
  );
  const portrait = section(
    component,
    'getRosterAssetPortrait(',
    'getRosterAssetProjection(',
  );

  assert.match(
    portrait,
    /if \(rosterAsset\.assetType !== 'skater'\) \{\s*return rosterAsset;/,
  );
});
