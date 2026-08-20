import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildLeagueDraftShareFilename,
  buildLeagueDraftShareText,
  buildLeagueStandingsShareFilename,
  buildLeagueStandingsShareText,
  normalizeLeagueDraftShareCardData,
  normalizeLeagueStandingsShareCardData,
} from '../../src/app/core/league/league-share-card-data.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function draftSample(overrides = {}) {
  return {
    leagueName: 'Friday Night Rats',
    teamName: 'Ice Rats',
    draftSlot: 3,
    totalTeams: 10,
    totalPicks: 17,
    picks: [
      { name: 'Connor McDavid', position: 'C', round: 1, overallPick: 3 },
      { name: 'Cale Makar', position: 'D', round: 2, overallPick: 18 },
      { name: 'Jason Robertson', position: 'LW', round: 3, overallPick: 23 },
    ],
    ...overrides,
  };
}

function standingsSample(overrides = {}) {
  return {
    leagueName: 'Friday Night Rats',
    periodLabel: 'After Matchup 8',
    totalTeams: 10,
    playoffTeamCount: 6,
    rows: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      teamName: `Team ${index + 1}`,
      record: `${8 - Math.min(index, 8)}-${Math.min(index, 8)}-0`,
      pointsFor: 800 - index * 22.5,
      pointDifferential: 90 - index * 20,
      playoffQualifier: index < 6,
      currentManager: index === 3,
    })),
    ...overrides,
  };
}

test('Draft card data is bounded, sanitized, ordered, unique, and scoped to six highlights', () => {
  const normalized = normalizeLeagueDraftShareCardData(draftSample({
    leagueName: '  Friday\u0000  Night   Rats ',
    teamName: 'A'.repeat(100),
    picks: [
      { name: 'Late Pick', position: 'RW', round: 8, overallPick: 80 },
      { name: 'First Pick', position: 'C', round: 1, overallPick: 3 },
      { name: 'Duplicate Pick', position: 'D', round: 2, overallPick: 3 },
      { name: 'Second Pick', position: 'D', round: 2, overallPick: 18 },
      { name: 'Third Pick', position: 'LW', round: 3, overallPick: 23 },
      { name: 'Fourth Pick', position: 'G', round: 4, overallPick: 38 },
      { name: 'Fifth Pick', position: 'C', round: 5, overallPick: 43 },
      { name: 'Sixth Pick', position: 'RW', round: 6, overallPick: 58 },
      { name: 'Seventh Pick', position: 'D', round: 7, overallPick: 63 },
    ],
  }));

  assert.equal(normalized.leagueName, 'Friday Night Rats');
  assert.equal(normalized.teamName.length, 56);
  assert.match(normalized.teamName, /…$/);
  assert.equal(normalized.picks.length, 6);
  assert.deepEqual(normalized.picks.map((pick) => pick.overallPick), [3, 18, 23, 38, 43, 58]);
  assert.equal(new Set(normalized.picks.map((pick) => pick.overallPick)).size, 6);
});

test('Draft captions and filenames identify only the manager team and completed picks', () => {
  const caption = buildLeagueDraftShareText(draftSample());
  assert.match(caption, /^Ice Rats' RinkRat draft is complete\./);
  assert.match(caption, /Draft slot #3 of 10 · 17 picks/);
  assert.match(caption, /Connor McDavid \(C\)/);
  assert.match(caption, /Friday Night Rats/);
  assert.match(caption, /https:\/\/rinkratfantasy\.com$/);
  assert.equal(
    buildLeagueDraftShareFilename(draftSample({ teamName: 'Québec Ice Rats' })),
    'quebec-ice-rats-draft-rinkrat.png',
  );
});

test('Standings card data sorts ranks, rejects duplicates, stays finite, and caps display at eight', () => {
  const rows = standingsSample().rows;
  const normalized = normalizeLeagueStandingsShareCardData(standingsSample({
    rows: [
      { ...rows[7], rank: 8 },
      { ...rows[0], rank: 1, pointsFor: Number.NaN },
      { ...rows[1], rank: 2, pointDifferential: Number.POSITIVE_INFINITY },
      { ...rows[2], rank: 3 },
      { ...rows[3], rank: 4 },
      { ...rows[4], rank: 5 },
      { ...rows[5], rank: 6 },
      { ...rows[6], rank: 7 },
      { ...rows[8], rank: 9 },
      { ...rows[9], rank: 10 },
      { ...rows[9], rank: 1, teamName: 'Duplicate leader' },
    ],
  }));

  assert.equal(normalized.rows.length, 8);
  assert.deepEqual(normalized.rows.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(normalized.rows[0].pointsFor, 0);
  assert.equal(normalized.rows[1].pointDifferential, 0);
  assert.equal(normalized.totalTeams, 10);
  assert.equal(normalized.playoffTeamCount, 6);
});

test('Standings captions and filenames present a bounded current league table', () => {
  const caption = buildLeagueStandingsShareText(standingsSample());
  assert.match(caption, /^Friday Night Rats standings — After Matchup 8\./);
  assert.match(caption, /1\. Team 1 \(8-0-0\)/);
  assert.doesNotMatch(caption, /Team 9/);
  assert.match(caption, /https:\/\/rinkratfantasy\.com$/);
  assert.equal(
    buildLeagueStandingsShareFilename(standingsSample({ leagueName: 'Québec Rat League' })),
    'quebec-rat-league-standings-rinkrat.png',
  );
});

test('both renderers create local 1080-square PNGs without remote templates, uploads, or backend calls', async () => {
  const [shared, draft, standings] = await Promise.all([
    read('src/app/core/league/league-share-card-browser.util.ts'),
    read('src/app/core/league/league-draft-share-card.service.ts'),
    read('src/app/core/league/league-standings-share-card.service.ts'),
  ]);

  assert.match(shared, /LEAGUE_SHARE_CARD_SIZE = 1080/);
  for (const source of [draft, standings]) {
    assert.match(source, /document\.createElement\('canvas'\)/);
    assert.match(source, /canvas\.width = LEAGUE_SHARE_CARD_SIZE/);
    assert.match(source, /canvas\.height = LEAGUE_SHARE_CARD_SIZE/);
    assert.match(source, /leagueShareCanvasToPngBlob\(canvas\)/);
    assert.doesNotMatch(source, /fetch\(|httpsCallable|Firestore|uploadBytes|addDoc|setDoc|onSnapshot/);
  }
  assert.match(shared, /canvas\.toDataURL\('image\/png'\)/);
  assert.match(shared, /new Blob\(\[bytes\], \{ type: 'image\/png' \}\)/);
});

test('the shared browser utility prefers native file sharing and treats cancellation normally', async () => {
  const [shared, draft, standings] = await Promise.all([
    read('src/app/core/league/league-share-card-browser.util.ts'),
    read('src/app/core/league/league-draft-share-card.service.ts'),
    read('src/app/core/league/league-standings-share-card.service.ts'),
  ]);

  assert.match(shared, /navigator\.canShare\(\{ files: \[file\] \}\)/);
  assert.match(shared, /files: \[file\]/);
  assert.match(shared, /error instanceof DOMException && error\.name === 'AbortError'/);
  assert.match(shared, /outcome: 'cancelled'/);
  assert.match(shared, /triggerLeagueShareDownload\(options\.blob, options\.filename\)/);
  assert.match(shared, /navigator\.clipboard\.writeText\(options\.text\)/);

  for (const source of [draft, standings]) {
    const functionStart = source.indexOf('export async function shareLeague');
    const functionSource = source.slice(functionStart);
    const blobIndex = functionSource.indexOf('const blob =');
    const firstAwait = functionSource.indexOf('return sharePreparedLeaguePngCard');
    assert.ok(blobIndex >= 0 && firstAwait > blobIndex, 'PNG is prepared before sharing starts');
  }
});

test('the Draft Room exposes a manager-specific card only after authoritative completion', async () => {
  const [component, template, componentStyles, globalStyles] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.css'),
    read('src/styles.css'),
  ]);
  const styles = `${componentStyles}\n${globalStyles}`;

  assert.match(component, /readonly myCompletedDraftPicks = computed/);
  assert.match(component, /filter\(\(pick\) => pick\.ownerId === this\.userId\)/);
  assert.match(component, /this\.draft\(\)\?\.status === 'complete'/);
  assert.match(component, /shareLeagueDraftCard\(\{/);
  assert.match(component, /draft\.roundOneOrder\.indexOf\(this\.userId\)/);
  assert.match(template, /draft\(\)\?\.status === 'complete'/);
  assert.match(template, /Share my draft/);
  assert.doesNotMatch(template, /browser-generated PNG using only your team name and completed picks/);
  assert.match(styles, /\.draft-share-button[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media[\s\S]*?\.draft-share-button[\s\S]*?width:\s*100%/);
  assert.doesNotMatch(template, /share my draft[\s\S]*?role="dialog"|viewport-overlay/i);
});

test('League Standings exports the rendered order and remains touch-safe on phones', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/leagues/league-standings/league-standings.ts'),
    read('src/app/features/leagues/league-standings/league-standings.html'),
    read('src/app/features/leagues/league-standings/league-standings.css'),
  ]);

  assert.match(component, /shareLeagueStandingsCard\(\{/);
  assert.match(component, /rows: rows\.map\(\(row\) => \(\{/);
  assert.match(component, /currentManager: row\.ownerId === this\.userId/);
  assert.match(component, /playoffQualifier: this\.isPlayoffQualifier\(row\)/);
  assert.match(template, /Share standings/);
  assert.match(template, /shareCurrentStandings\(\)/);
  assert.match(styles, /\.standings-share-button,[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.standings-share-button,[\s\S]*?width:\s*100%/);
  assert.doesNotMatch(template, /share standings[\s\S]*?role="dialog"|viewport-overlay/i);
  assert.doesNotMatch(styles, /\.standings-share[\s\S]*?position:\s*(?:fixed|sticky)/i);
});

test('C1L is Hosting-only and preserves protected competitive, Rules, and index source', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(packageJson.scripts['verify:batcha1a:core'], /verify:batchc1l:core/);
  assert.doesNotMatch(packageJson.scripts['verify:batcha1a:core'], /firestore:rules|functions:/);
});

test('C1L advances only the browser release metadata to RC38', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, releaseScript] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('scripts/release/invite-beta-release.mjs'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 53/);
  assert.match(productionRuntime, /Release Candidate 53/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 53');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1c');
  assert.equal(freeze.defaultTag, 'rinkrat-rc53-invite-beta');
  assert.equal(freeze.scoringRulesVersion, 4);
  assert.equal(freeze.projectionVersion, 11);
  assert.equal(freeze.requiredGamesPerRosterSlot, 6);
  assert.equal(freeze.queueMode, 'shadow');
  assert.equal(freeze.appCheckMode, 'monitor');
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1c:core/);
  assert.match(releaseScript, /rinkrat-rc53-invite-beta/);
});

test('documentation and roadmap complete the Draft and standings share-card goal', async () => {
  const [roadmap, docsRoadmap, docs, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1L_DRAFT_STANDINGS_SHARE_CARDS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.44/);
  assert.match(roadmap, /# \[x\] C1\.6 Add shareable matchup/);
  assert.match(roadmap, /# \[x\] C1\.24/);
  assert.match(roadmap, /# \[x\] LOG\.47 2026-08-17/);
  assert.match(docs, /1080×1080 PNG/);
  assert.match(docs, /top eight ranked teams/);
  assert.match(docs, /C1L is Hosting-only/);
  assert.doesNotMatch(docs, /--only functions|--only firestore:rules/);
  assert.match(readme, /Release Candidate 53 \/ Operations Batch O1C/);
  assert.match(readme, /RINKRAT_SOCIAL_C1L_DRAFT_STANDINGS_SHARE_CARDS\.md/);
  assert.match(releaseRunbook, /npm run verify:batcho1c/);
  assert.match(releaseRunbook, /rinkrat-rc53-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc53-invite-beta/);
});
