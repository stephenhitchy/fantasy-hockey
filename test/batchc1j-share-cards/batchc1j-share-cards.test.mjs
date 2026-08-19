import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  buildLeagueMatchupShareFilename,
  buildLeagueMatchupShareText,
  normalizeLeagueMatchupShareCardData,
} from '../../src/app/core/league/league-matchup-share-card.service.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function sample(overrides = {}) {
  return {
    leagueName: 'Friday Night Rats',
    teamAName: 'Ice Rats',
    teamBName: 'Blue Line Bandits',
    teamAScore: 61.4,
    teamBScore: 58.05,
    winnerTeamName: 'Ice Rats',
    contextLabel: 'Matchup 8',
    championship: false,
    tieBrokenByHigherSeed: false,
    ...overrides,
  };
}

test('share-card data normalizes public display text and finite scores', () => {
  const normalized = normalizeLeagueMatchupShareCardData(sample({
    leagueName: '  Friday\u0000   Night   Rats  ',
    teamAName: 'A'.repeat(100),
    teamAScore: Number.NaN,
    teamBScore: Number.POSITIVE_INFINITY,
  }));

  assert.equal(normalized.leagueName, 'Friday Night Rats');
  assert.equal(normalized.teamAName.length, 56);
  assert.match(normalized.teamAName, /…$/);
  assert.equal(normalized.teamAScore, 0);
  assert.equal(normalized.teamBScore, 0);
});

test('captions preserve regular finals, ties, championships, and higher-seed context', () => {
  assert.equal(
    buildLeagueMatchupShareText(sample()),
    'Ice Rats won Matchup 8.\nIce Rats 61.4–58.05 Blue Line Bandits\nFriday Night Rats\nhttps://rinkratfantasy.com',
  );

  assert.equal(
    buildLeagueMatchupShareText(sample({
      teamAScore: 55,
      teamBScore: 55,
      winnerTeamName: null,
      contextLabel: 'Playoff Round 1',
      tieBrokenByHigherSeed: false,
    })),
    'Playoff Round 1 finished tied.\nIce Rats 55–55 Blue Line Bandits\nFriday Night Rats\nhttps://rinkratfantasy.com',
  );

  const championship = buildLeagueMatchupShareText(sample({
    championship: true,
    contextLabel: 'RinkRat Championship',
    tieBrokenByHigherSeed: true,
  }));
  assert.match(championship, /^Ice Rats won the RinkRat Championship\./);
  assert.match(championship, /Higher seed advanced\./);
});

test('download filenames remain bounded, portable, and result-specific', () => {
  assert.equal(
    buildLeagueMatchupShareFilename(sample()),
    'ice-rats-vs-blue-line-bandits-rinkrat.png',
  );
  assert.equal(
    buildLeagueMatchupShareFilename(sample({
      championship: true,
      winnerTeamName: 'Québec Night Owls',
    })),
    'quebec-night-owls-champion-rinkrat.png',
  );
});

test('the browser renderer creates a local 1080-square PNG without remote templates or uploads', async () => {
  const source = await read('src/app/core/league/league-matchup-share-card.service.ts');

  assert.match(source, /const SHARE_CARD_SIZE = 1080;/);
  assert.match(source, /document\.createElement\('canvas'\)/);
  assert.match(source, /canvas\.width = SHARE_CARD_SIZE/);
  assert.match(source, /canvas\.height = SHARE_CARD_SIZE/);
  assert.match(source, /canvas\.toDataURL\('image\/png'\)/);
  assert.match(source, /new Blob\(\[bytes\], \{ type: 'image\/png' \}\)/);
  assert.match(source, /'image\/png'/);
  assert.match(source, /drawRinkBackground/);
  assert.match(source, /RINKRAT CHAMPION/);
  assert.doesNotMatch(source, /fetch\(|httpsCallable|Firestore|uploadBytes|addDoc|setDoc|onSnapshot/);
});

test('native file sharing is preferred and cancellation falls through quietly to no error', async () => {
  const source = await read('src/app/core/league/league-matchup-share-card.service.ts');

  assert.match(source, /navigator\.canShare\(\{ files: \[file\] \}\)/);
  assert.match(source, /navigator\.share\(\{ title, text, files: \[file\] \}\)/);
  const shareFunction = source.slice(source.indexOf('export async function shareLeagueMatchupCard'));
  const firstShareAwait = shareFunction.indexOf('await navigator.share');
  assert.ok(firstShareAwait > 0);
  assert.doesNotMatch(shareFunction.slice(0, firstShareAwait), /\bawait\b/);
  assert.match(source, /navigator\.share\(\{ title, text, url: SHARE_SITE_URL \}\)/);
  assert.match(source, /error\.name === 'AbortError'/);
  assert.match(source, /outcome: 'cancelled'/);
  assert.match(source, /triggerDownload\(blob, filename\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
});

test('League Wire exposes share cards only for final matchup activity with complete scores', async () => {
  const [component, template, detailTemplate] = await Promise.all([
    read('src/app/features/leagues/league-wire/league-wire.ts'),
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-detail/league-detail.html'),
  ]);

  const matchupStart = component.indexOf("case 'matchup-result':");
  const matchupEnd = component.indexOf('\n      }\n    }\n\n    return {', matchupStart);
  const matchupSource = component.slice(matchupStart, matchupEnd);

  assert.ok(matchupStart >= 0);
  assert.match(component, /readonly leagueName = input\('RinkRat League'\)/);
  assert.match(matchupSource, /const hasShareableScores = Number\.isFinite\(activity\.teamAScore\)/);
  assert.match(matchupSource, /shareCard = \{/);
  assert.match(matchupSource, /championship: activity\.winnerPlace === 1/);
  assert.match(matchupSource, /tieBrokenByHigherSeed: activity\.tieBrokenByHigherSeed/);
  assert.equal(component.slice(0, matchupStart).includes('shareCard = {'), false);
  assert.match(template, /shareMatchupResult\(item\)/);
  assert.match(template, /shareCardButtonLabel\(item\)/);
  assert.doesNotMatch(template, /A member-triggered share card intentionally exports only the final team names/);
  assert.match(detailTemplate, /\[leagueName\]="league\(\)\?\.name \?\? 'RinkRat League'"/);
});

test('share controls stay inline, touch-safe, and non-blocking on phones', async () => {
  const [template, styles] = await Promise.all([
    read('src/app/features/leagues/league-wire/league-wire.html'),
    read('src/app/features/leagues/league-wire/league-wire.css'),
  ]);

  assert.match(styles, /\.league-wire-share-button[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.league-wire-share-button[\s\S]*?width:\s*100%/);
  assert.match(template, /class="league-wire-share-button rr-button rr-button--quiet"/);
  assert.doesNotMatch(template, /share-card[\s\S]*?role="dialog"|share-card[\s\S]*?viewport-overlay/i);
  assert.doesNotMatch(styles, /\.league-wire-share[\s\S]*?position:\s*(?:fixed|sticky)/i);
});

test('C1J adds no backend authority and preserves protected competitive source', async () => {
  const [
    scoringRules,
    scoringEngine,
    projectionV11,
    firestoreRules,
    firestoreIndexes,
    functionsPublisher,
    packageSource,
  ] = await Promise.all([
    read('src/app/core/scoring/scoring-rules.ts'),
    read('src/app/core/scoring/scoring-engine.ts'),
    read('src/app/core/projection/projection-v11.util.ts'),
    read('firestore.rules'),
    read('firestore.indexes.json'),
    read('functions/src/league-activity.ts'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(createHash('sha256').update(scoringRules).digest('hex'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(createHash('sha256').update(scoringEngine).digest('hex'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(createHash('sha256').update(projectionV11).digest('hex'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(createHash('sha256').update(firestoreRules).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(createHash('sha256').update(firestoreIndexes).digest('hex'), PROTECTED_SOURCE_HASHES.firestoreIndexes);
  assert.match(functionsPublisher, /release: 'Social Batch C1I'/);
  assert.doesNotMatch(packageJson.scripts['verify:batcha1a:core'], /firestore:rules|functions:/);
});

test('C1J remains intact under RC38 while C1L inherits the C1K verification chain', async () => {
  const [runtime, productionRuntime, freezeSource, packageSource, releaseScript] = await Promise.all([
    read('src/environments/app-runtime.config.ts'),
    read('src/environments/app-runtime.config.production.ts'),
    read('config/release-freeze/beta-freeze-policy.json'),
    read('package.json'),
    read('scripts/release/invite-beta-release.mjs'),
  ]);
  const freeze = JSON.parse(freezeSource);
  const packageJson = JSON.parse(packageSource);

  assert.match(runtime, /Release Candidate 51/);
  assert.match(productionRuntime, /Release Candidate 51/);
  assert.equal(freeze.releaseLabel, 'Release Candidate 51');
  assert.equal(freeze.verificationCommand, 'npm run verify:batcho1a');
  assert.equal(freeze.defaultTag, 'rinkrat-rc51-invite-beta');
  assert.match(packageJson.scripts['verify:batcha1a:core'], /verify:batchc1l:core/);
  assert.match(packageJson.scripts['security:ci'], /verify:batcho1a:core/);
  assert.match(releaseScript, /rinkrat-rc51-invite-beta/);
});

test('documentation and permanent roadmap record the bounded share-card foundation', async () => {
  const [roadmap, docsRoadmap, docs, readme, releaseRunbook] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_SOCIAL_C1J_MATCHUP_SHARE_CARDS.md'),
    read('README.md'),
    read('docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md'),
  ]);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /Version 1\.42/);
  assert.match(roadmap, /# \[x\] C1\.6 Add shareable matchup/);
  assert.match(roadmap, /# \[x\] C1\.23/);
  assert.match(roadmap, /# \[x\] LOG\.45 2026-08-17/);
  assert.match(docs, /1080×1080 PNG/);
  assert.match(docs, /Hosting-only/);
  assert.match(docs, /Canceling the native share sheet is treated as a normal cancellation/);
  assert.match(docs, /before the first asynchronous boundary/);
  assert.doesNotMatch(docs, /--only functions|--only firestore:rules/);
  assert.match(readme, /Release Candidate 51 \/ Operations Batch O1A/);
  assert.match(readme, /RINKRAT_SOCIAL_C1J_MATCHUP_SHARE_CARDS\.md/);
  assert.match(releaseRunbook, /npm run verify:batcho1a/);
  assert.match(releaseRunbook, /rinkrat-rc51-validation\.json/);
  assert.match(releaseRunbook, /rinkrat-rc51-invite-beta/);
});
