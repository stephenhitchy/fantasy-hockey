import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function componentInstances(template) {
  return [...template.matchAll(/<app-injury-replacement-score-breakdown[\s\S]*?\/>/g)]
    .map((match) => match[0]);
}

function section(template, startMarker, endMarker) {
  const start = template.indexOf(startMarker);
  const end = template.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return template.slice(start, end);
}

describe('B2B matchup injury-replacement presentation', () => {
  test('every desktop and mobile matchup path renders the validated compact split', async () => {
    const [desktop, mobile] = await Promise.all([
      source(
        'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
      ),
      source(
        'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html',
      ),
    ]);

    const desktopBreakdowns = componentInstances(desktop);
    const mobileBreakdowns = componentInstances(mobile);

    assert.equal(desktopBreakdowns.length, 3, 'forward, defense, and goalie cards must retain the split');
    assert.equal(mobileBreakdowns.length, 3, 'team A, team B, and single-team cards must retain the split');

    const desktopPaths = [
      section(
        desktop,
        '@for (position of presenter.forwardPositions',
        '@for (position of presenter.defensePositions',
      ),
      section(
        desktop,
        '@for (position of presenter.defensePositions',
        '@for (position of presenter.goaliePositions',
      ),
      section(
        desktop,
        '@for (position of presenter.goaliePositions',
        '<section class="matchup-bench-section"',
      ),
    ];
    const mobilePaths = [
      section(
        mobile,
        'class="mobile-live-player mobile-live-player-team-a"',
        '<div class="mobile-live-slot-badge"',
      ),
      section(
        mobile,
        'class="mobile-live-player mobile-live-player-team-b"',
        '} @else if (getSingleOwnerId(); as ownerId)',
      ),
      section(
        mobile,
        'class="mobile-live-player mobile-live-player-single"',
        '@if (isHeadToHeadView() && matchup.teamBOwnerId)',
      ),
    ];

    for (const path of [...desktopPaths, ...mobilePaths]) {
      assert.equal(componentInstances(path).length, 1, 'each matchup path must own one split');
      assert.match(path, /getPickInjuryReplacementPresentation\(pick\)/);
    }
    assert.equal(
      [...desktop.matchAll(/presenter\.getPickInjuryReplacementPresentation\(pick\)/g)].length,
      3,
      'each desktop position path must use validated mixed-player evidence',
    );
    assert.equal(
      [...mobile.matchAll(/presenter\.getPickInjuryReplacementPresentation\(pick\)/g)].length,
      3,
      'both head-to-head sides and the single-team path must use validated evidence',
    );

    for (const breakdown of [...desktopBreakdowns, ...mobileBreakdowns]) {
      assert.match(breakdown, /\[presentation\]="replacement"/);
      assert.match(breakdown, /\[compact\]="true"/);
      assert.match(breakdown, /\[showTotal\]="false"/);
    }

    assert.equal(
      [...mobile.matchAll(/presenter\.getPickScoreAccessibilityLabel\(pick\)/g)].length,
      3,
      'both head-to-head sides and the single-team view must announce the full split',
    );
    assert.equal(
      [...mobile.matchAll(/\[attr\.aria-label\]="marker\.ariaLabel"/g)].length,
      3,
      'all mobile paths must retain per-game ownership labels',
    );
  });

  test('the shared split responds to card width instead of viewport width', async () => {
    const [styles, mobileStyles, globalStyles] = await Promise.all([
      source(
        'src/app/shared/injury-replacement-score-breakdown/injury-replacement-score-breakdown.css',
      ),
      source(
        'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css',
      ),
      source('src/styles.css'),
    ]);

    assert.match(styles, /:host\s*\{[\s\S]*container-type:\s*inline-size/);
    assert.match(styles, /@container\s*\(max-width:\s*260px\)/);
    assert.doesNotMatch(styles, /@media\s*\(max-width:\s*420px\)/);
    assert.match(
      styles,
      /@container[\s\S]*\.injury-score-segments\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    assert.match(styles, /@container[\s\S]*\.injury-score-plus\s*\{[\s\S]*display:\s*none/);
    assert.match(mobileStyles, /'breakdown breakdown'/);
    assert.match(
      mobileStyles,
      /\.mobile-injury-score-breakdown\s*\{[\s\S]*?grid-area:\s*breakdown;[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/,
    );
    assert.match(
      mobileStyles,
      /\.mobile-live-player-single\s+\.mobile-injury-score-breakdown[\s\S]*grid-column:\s*1\s*\/\s*-1/,
    );
    assert.match(
      globalStyles,
      /app-cycle-one\s+\.fantasy-player-injury-breakdown\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/,
    );
  });
});
