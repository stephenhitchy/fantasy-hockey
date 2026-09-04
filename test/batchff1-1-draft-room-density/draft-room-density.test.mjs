import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  resolveDraftAssetPortrait,
} from '../../src/app/features/draft/draft-room/draft-asset-portrait.util.ts';
import { getDraftPlayerAvailabilityDisplay } from '../../src/app/features/draft/draft-room/draft-player-availability.util.ts';
import { matchesDraftPlayerSearch } from '../../src/app/features/draft/draft-room/draft-player-search.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Draft player search covers player and NHL-team identity without changing ranking', () => {
  const candidateValues = ['Tim Stützle', 'OTT', 'SJS', 'Utah Mammoth'];

  assert.equal(matchesDraftPlayerSearch('', candidateValues), true);
  assert.equal(matchesDraftPlayerSearch('stutzle', candidateValues), true);
  assert.equal(matchesDraftPlayerSearch('OTT', candidateValues), true);
  assert.equal(matchesDraftPlayerSearch('sharks', ['San Jose Sharks']), true);
  assert.equal(matchesDraftPlayerSearch('mammoth', candidateValues), true);
  assert.equal(matchesDraftPlayerSearch('boston', candidateValues), false);
});

test('Draft cards retain only identity, injury, rank, Next 6, Season, queue, and live-pick actions', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
  ]);

  assert.match(template, /class="asset-identity-meta"/);
  assert.match(template, /getDraftPlayerAvailabilityDisplay\(asset\)/);
  assert.match(template, /class="pixel-icon icon-injury icon-sm"/);
  assert.match(template, /<small>Rank<\/small>/);
  assert.match(template, /<small>Next 6<\/small>/);
  assert.match(template, /<small>Season<\/small>/);
  assert.match(template, /class="queue-button rr-button rr-button--secondary"/);
  assert.match(template, /class="draft-button rr-button rr-button--commit"/);

  assert.doesNotMatch(template, /Rating:|Risk:|Form:|expectedGames|active games/i);
  assert.doesNotMatch(template, /draft-watchlist|Watching|watchedAssetKeys/);
  assert.doesNotMatch(template, /drafted-player-projections|asset-draft-news-row/);
  assert.doesNotMatch(component, /getPlayerWatchlist|setPlayerWatchlistEntry|watchlistOnly/);
  assert.doesNotMatch(component, /'RELIABILITY'|'RATING'/);
});

test('Draft availability hides healthy source records and presents bounded injury timing', () => {
  const base = {
    playerId: 1,
    playerName: 'Example Player',
    label: 'Active',
    shortLabel: 'Active',
    irEligible: false,
    note: '',
    updatedAt: '2026-09-03T00:00:00.000Z',
    source: 'firestore',
  };

  assert.equal(getDraftPlayerAvailabilityDisplay({ ...base, status: 'active' }), null);

  assert.deepEqual(getDraftPlayerAvailabilityDisplay({
    ...base,
    status: 'injured-reserve',
    label: 'Injured Reserve',
    shortLabel: 'IR',
    irEligible: true,
    externalReturnDate: '2026-09-15',
  }, new Date('2026-09-03T00:00:00.000Z')), {
    icon: 'injury',
    iconText: '',
    shortLabel: 'IR',
    timingLabel: 'Est. Sep 15',
    ariaLabel: 'Injured Reserve. Est. Sep 15. Injured Reserve eligible.',
    tone: 'danger',
  });

  const unavailableDate = getDraftPlayerAvailabilityDisplay({
    ...base,
    status: 'out',
    label: 'Out',
    shortLabel: 'Out',
    irEligible: true,
    externalReturnDate: 'not-a-date',
  });
  assert.equal(unavailableDate?.timingLabel, 'Return TBD');
  assert.equal(unavailableDate?.ariaLabel, 'Out. Return TBD. Injured Reserve eligible.');
});

test('Draft portraits prefer skater headshots, retain team identity, and fail over safely', () => {
  const skater = {
    assetType: 'skater',
    assetKey: 'skater-1',
    position: 'LW',
    player: {
      id: 1,
      fullName: 'Example Skater',
      position: 'LW',
      nhlTeamAbbreviation: 'OTT',
      headshotUrl: ' https://example.test/skater.png ',
      teamLogoUrl: 'https://example.test/ott.svg',
    },
  };
  const goalieUnit = {
    assetType: 'team-goalie-unit',
    assetKey: 'goalie-OTT',
    position: 'G',
    teamName: 'Ottawa Senators',
    teamAbbreviation: 'OTT',
    teamLogoUrl: 'https://example.test/ott.svg',
  };

  assert.deepEqual(resolveDraftAssetPortrait(skater), {
    primaryImageUrl: 'https://example.test/skater.png',
    primaryKind: 'headshot',
    teamBadgeUrl: 'https://example.test/ott.svg',
    fallbackLabel: 'OTT',
  });
  assert.deepEqual(resolveDraftAssetPortrait(skater, {
    currentTeamLogoUrl: 'https://example.test/uta.svg',
    currentTeamLabel: 'UTA',
  }), {
    primaryImageUrl: 'https://example.test/skater.png',
    primaryKind: 'headshot',
    teamBadgeUrl: 'https://example.test/uta.svg',
    fallbackLabel: 'UTA',
  });
  assert.deepEqual(resolveDraftAssetPortrait(skater, {
    failedImageUrls: new Set(['https://example.test/skater.png']),
  }), {
    primaryImageUrl: 'https://example.test/ott.svg',
    primaryKind: 'team-logo',
    teamBadgeUrl: null,
    fallbackLabel: 'OTT',
  });
  assert.deepEqual(resolveDraftAssetPortrait(skater, {
    failedImageUrls: new Set([
      'https://example.test/skater.png',
      'https://example.test/ott.svg',
    ]),
  }), {
    primaryImageUrl: null,
    primaryKind: 'fallback',
    teamBadgeUrl: null,
    fallbackLabel: 'OTT',
  });
  assert.deepEqual(resolveDraftAssetPortrait(goalieUnit), {
    primaryImageUrl: 'https://example.test/ott.svg',
    primaryKind: 'team-logo',
    teamBadgeUrl: null,
    fallbackLabel: 'OTT',
  });
  assert.deepEqual(resolveDraftAssetPortrait({
    ...goalieUnit,
    teamLogoUrl: ' ',
  }), {
    primaryImageUrl: null,
    primaryKind: 'fallback',
    teamBadgeUrl: null,
    fallbackLabel: 'OTT',
  });
});

test('Draft portrait markup is bounded, lazy, decorative, and preserves traded-team text', async () => {
  const [component, template, styles] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/app/features/draft/draft-room/draft-room.css'),
  ]);

  assert.match(template, /class="asset-portrait" aria-hidden="true"/);
  assert.match(template, /class="asset-portrait-image"/);
  assert.match(template, /class="asset-team-badge"/);
  assert.match(template, /class="drafted-asset-portrait" aria-hidden="true"/);
  assert.match(template, /loading="lazy"/);
  assert.match(template, /decoding="async"/);
  assert.match(template, /\(error\)="markDraftImageUnavailable\(/);
  assert.match(template, /getAssetIdentityTeamLabel\(asset\)/);
  assert.match(template, /class="rr-visually-hidden"[\s\S]*?getAssetIdentityAriaLabel\(asset\)/);
  assert.doesNotMatch(template, /class="asset-team-change-logo"/);
  assert.match(component, /failedDraftImageUrls = signal<ReadonlySet<string>>/);
  assert.match(styles, /\.asset-headshot\s*\{[\s\S]*?object-fit:\s*cover/);
  assert.match(styles, /\.asset-team-badge\s*\{[\s\S]*?width:\s*18px/);
  assert.match(styles, /\.drafted-asset-team-badge\s*\{[\s\S]*?width:\s*16px/);
});

test('Draft actions remain gated by the existing authoritative live-turn contract', async () => {
  const [component, template] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
  ]);

  assert.match(template, /@if \(draft\(\)\?\.status === 'live' && isMyTurn\(\)\)/);
  assert.match(template, /!canDraftAsset\(asset\)/);
  assert.match(template, /isMyTurn\(\) \? selectedAsset\(\) : null/);
  assert.match(component, /draft\.status !== 'live'/);
  assert.match(component, /draft\.clockStatus !== 'running'/);
  assert.match(component, /isDraftClockExpired\(draft, new Date\(this\.now\(\)\)\)/);
  assert.match(component, /!this\.isMyTurn\(\)/);
  assert.match(component, /!this\.canUseLiveDraftActions\(\)/);
  assert.match(component, /getDraftDestinationForAsset\(this\.userId, asset\) !== null/);
});

test('icon and stateful Draft controls expose stable player-specific accessible names', async () => {
  const [template, accessibilityAudit] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('scripts/audit-accessibility.mjs'),
  ]);

  assert.match(template, /\[attr\.aria-pressed\]="isAssetQueued\(asset\)"/);
  assert.match(template, /getAssetName\(asset\)[\s\S]*?from your Draft queue/);
  assert.match(template, /Select ' \+ getAssetName\(asset\) \+ ' for Draft confirmation/);
  assert.match(template, /getDraftButtonLabel\(asset\) \+ ' ' \+ getAssetName\(asset\)/);
  assert.match(template, /Move '[\s\S]*?' up in your Draft queue/);
  assert.match(template, /Move '[\s\S]*?' down in your Draft queue/);
  assert.match(template, /Remove '[\s\S]*?' from your Draft queue/);
  assert.match(accessibilityAudit, /aria-label\|\\\[attr\\\.aria-label\\\]/);

  const closeButtons = template.match(/<button[^>]*>\s*×\s*<\/button>/gs) ?? [];
  assert.ok(closeButtons.length > 0);
  for (const button of closeButtons) {
    assert.match(button, /(?:aria-label|\[attr\.aria-label\])=/);
  }
  assert.doesNotMatch('<button type="button">×</button>', /(?:aria-label|\[attr\.aria-label\])=/);
});

test('Draft cards use one compact desktop line and a bounded mobile reflow', async () => {
  const [styles, globalStyles] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.css'),
    read('src/styles.css'),
  ]);
  const playerNameRule = styles.match(/\.asset-name-row > strong\s*\{[\s\S]*?\}/)?.[0] ?? '';

  assert.match(styles, /grid-template-columns:\s*40px minmax\(150px, 1fr\) minmax\(180px, 0\.85fr\) auto/);
  assert.match(styles, /min-height:\s*58px/);
  assert.match(playerNameRule, /color:\s*var\(--rr-color-text\)/);
  assert.doesNotMatch(playerNameRule, /#[0-9a-f]{3,8}\b/i);
  assert.match(styles, /\.asset-metrics\s*\{[\s\S]*?repeat\(3, minmax\(52px, 1fr\)\)/);
  assert.match(styles, /\.asset-actions\s*\{[\s\S]*?display:\s*flex/);
  assert.match(styles, /repeat\(auto-fit, minmax\(104px, 1fr\)\)/);
  assert.match(styles, /\.asset-metrics\s*\{[\s\S]*?grid-column:\s*2/);
  assert.match(styles, /min-height:\s*var\(--rr-mobile-control-min-height\)/);
  assert.doesNotMatch(styles, /\.draft-asset-card button:hover/);
  assert.doesNotMatch(globalStyles, /\.asset-metric strong,[\s\S]*?color:\s*var\(--text-primary\) !important/);
  assert.ok(Buffer.byteLength(styles, 'utf8') < 45_000);
});

test('the density slice adds no Draft write path, image fetch path, or projection/scoring calculation', async () => {
  const [component, searchUtility, availabilityUtility, portraitUtility, playerPoolService] =
    await Promise.all([
      read('src/app/features/draft/draft-room/draft-room.ts'),
      read('src/app/features/draft/draft-room/draft-player-search.util.ts'),
      read('src/app/features/draft/draft-room/draft-player-availability.util.ts'),
      read('src/app/features/draft/draft-room/draft-asset-portrait.util.ts'),
      read('src/app/core/draft/draft-player-pool.service.ts'),
    ]);

  assert.match(component, /makeDraftPick/);
  assert.match(component, /getDraftDestinationForAsset/);
  assert.doesNotMatch(searchUtility, /firebase|firestore|httpsCallable|setDoc|updateDoc|transaction/i);
  assert.doesNotMatch(searchUtility, /projected|scoring|window|game/i);
  assert.doesNotMatch(availabilityUtility, /firebase|firestore|httpsCallable|setDoc|updateDoc|transaction/i);
  assert.doesNotMatch(availabilityUtility, /projected|scoring|window|game/i);
  assert.doesNotMatch(
    portraitUtility,
    /firebase|firestore|httpsCallable|fetch\(|setDoc|updateDoc|transaction/i,
  );
  assert.match(playerPoolService, /headshotUrl:\s*skater\.headshotUrl/);
});

test('the roadmap separates completed source behavior from lobby and start-readiness work', async () => {
  const [roadmap, docsRoadmap, taskDoc, packageSource] = await Promise.all([
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_FF1_1_DRAFT_ROOM_DENSITY.md'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /\[~\] FF1\.17 Reduce Draft Room decision density/);
  assert.match(roadmap, /\[~\] FF1\.18 One-hour pre-Draft lobby is merged and deployed/);
  assert.match(roadmap, /\[~\] FF1\.19 Server-owned pre-start readiness is implemented as a source candidate/);
  assert.match(taskDoc, /source implementation complete; independent review and authenticated visual evidence pending/);
  assert.match(taskDoc, /only changed runtime resource is\s+`hosting:app`/);
  assert.match(taskDoc, /intentionally not implemented in this Hosting-only\s+slice/);
  assert.match(packageJson.scripts['verify:batchff1-1:core'], /verify:batchd1nc:core/);
  assert.match(packageJson.scripts['verify:batchff1-1:core'], /test:batchff1-1:run/);
});
