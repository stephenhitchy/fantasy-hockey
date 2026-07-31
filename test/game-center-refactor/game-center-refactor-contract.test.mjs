import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function lineCount(source) {
  return source.trimEnd().split(/\r?\n/).length;
}

describe('Batch 6A Game Center component boundaries', () => {
  test('the route template is a small page composition instead of a 2,600-line monolith', async () => {
    const template = await read('src/app/features/cycles/cycle-one/cycle-one.html');

    assert.ok(
      lineCount(template) < 400,
      `Expected the route template to stay below 400 lines, received ${lineCount(template)}.`,
    );

    for (const selector of [
      'app-cycle-mobile-scorebar',
      'app-cycle-page-header',
      'app-cycle-status-banners',
      'app-cycle-explainer',
      'app-cycle-matchup-toolbar',
      'app-cycle-matchup-card',
    ]) {
      assert.match(template, new RegExp(`<${selector}\\b`));
    }
  });

  test('the matchup card delegates its three largest rendering regions', async () => {
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
    );

    assert.ok(
      lineCount(template) < 150,
      `Expected the matchup card shell to stay below 150 lines, received ${lineCount(template)}.`,
    );
    assert.match(template, /<app-cycle-mobile-head-to-head\b/);
    assert.match(template, /<app-cycle-matchup-team-panel\b/);
    assert.match(template, /<app-cycle-matchup-breakdown\b/);
    assert.match(template, /\[ownerId\]="matchup\.teamAOwnerId"/);
    assert.match(template, /\[ownerId\]="matchup\.teamBOwnerId"/);
  });

  test('one reusable team panel renders both matchup sides', async () => {
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    );

    assert.match(template, /presenter\.getOwnerThemeStyles\(ownerId\)/);
    assert.match(template, /presenter\.getTeamRosterProgressPercent\(ownerId\)/);
    assert.match(template, /presenter\.getTeamPicksByPosition\(ownerId,/);
    assert.match(template, /presenter\.getTeamBenchSlots\(ownerId\)/);
    assert.doesNotMatch(template, /teamAOwnerId|teamBOwnerId/);
  });

  test('the asynchronous six-game window UI remains present after extraction', async () => {
    const teamPanel = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    );
    const mobile = await read(
      'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html',
    );

    for (const requiredCall of [
      'getWindowGameMarkers',
      'getAssetGamesPlayed',
      'getAssetGamesLeft',
      'getPendingWindowCallout',
      'isFutureWindowPending',
    ]) {
      assert.match(teamPanel + mobile, new RegExp(`presenter\\.${requiredCall}\\(`));
    }

    assert.match(teamPanel, /Roster Progress/);
    assert.match(teamPanel, /Does not score while on the bench/);
  });

  test('six-game markers use a full-width three-column two-row grid inside every active player card', async () => {
    const teamPanel = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    );
    const stylesheet = await read('src/app/features/cycles/cycle-one/cycle-one.css');
    const globalStyles = await read('src/styles.css');

    assert.equal(
      (teamPanel.match(/class="window-game-markers"/g) ?? []).length,
      3,
      'Forward, defense, and goalie cards should each render the same marker grid.',
    );
    const playerMainBlocks = [
      ...teamPanel.matchAll(
        /<div class="fantasy-player-main">([\s\S]*?)<\/div>\s*<div class="fantasy-player-score-stack">/g,
      ),
    ];
    assert.ok(playerMainBlocks.length >= 3, 'Expected to find the active player-name columns.');
    for (const [, playerMain] of playerMainBlocks) {
      assert.doesNotMatch(
        playerMain,
        /class="window-game-markers"/,
        'The marker row must not be trapped inside the narrow player-name column.',
      );
    }
    assert.match(stylesheet, /\.g \.window-game-markers \{[\s\S]*?grid-column:\s*1 \/ -1;/);
    assert.match(stylesheet, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(stylesheet, /\.g \.window-game-marker \{[\s\S]*?aspect-ratio:\s*1;/);
    assert.doesNotMatch(
      globalStyles,
      /single-team-view \.window-game-markers,\s*app-cycle-one \.single-team-view \.window-status-copy[\s\S]*?margin-left:\s*-64px/,
      'Single-team mode must not pull the full-width marker row out of alignment.',
    );
  });

  test('the visual stylesheet is globally emitted but scoped to the Game Center host', async () => {
    const component = await read('src/app/features/cycles/cycle-one/cycle-one.ts');
    const stylesheet = await read('src/app/features/cycles/cycle-one/cycle-one.css');

    assert.match(component, /encapsulation:\s*ViewEncapsulation\.None/);
    assert.match(component, /host:\s*\{ class: 'g' \}/);
    assert.match(stylesheet, /^\.g\s*\{/);
    assert.doesNotMatch(stylesheet, /(^|\n)\s*:host\s*\{/);

    const selectorStarts = stylesheet
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('{') && !line.startsWith('@') && !/^\d+%|^(from|to)\s*\{/.test(line));

    const unexpected = selectorStarts.filter(
      (line) =>
        !line.startsWith('.g') &&
        !/^\d+%,?$/.test(line) &&
        line !== 'from {' &&
        line !== 'to {',
    );

    assert.deepEqual(unexpected, []);
  });


  test('expanding the component boundaries reproduces the approved Game Center markup', async () => {
    const componentRoot = 'src/app/features/cycles/cycle-one/components';
    const stripPresenter = (source) => source.replaceAll('presenter.', '');
    const replaceComponent = (source, selector, replacement) =>
      source.replace(new RegExp(`<app-${selector}\\b[\\s\\S]*?</app-${selector}>`, 'g'), replacement);

    let matchupCard = await read(`${componentRoot}/cycle-matchup-card/cycle-matchup-card.html`);
    matchupCard = replaceComponent(
      matchupCard,
      'cycle-mobile-head-to-head',
      stripPresenter(
        await read(`${componentRoot}/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html`),
      ),
    );

    const teamPanel = stripPresenter(
      await read(`${componentRoot}/cycle-matchup-team-panel/cycle-matchup-team-panel.html`),
    );
    matchupCard = matchupCard.replace(
      /<app-cycle-matchup-team-panel\s+[\s\S]*?\[ownerId\]="([^"]+)"[\s\S]*?<\/app-cycle-matchup-team-panel>/g,
      (_match, ownerExpression) => teamPanel.replaceAll('ownerId', ownerExpression),
    );
    matchupCard = replaceComponent(
      matchupCard,
      'cycle-matchup-breakdown',
      stripPresenter(
        await read(`${componentRoot}/cycle-matchup-breakdown/cycle-matchup-breakdown.html`),
      ),
    );
    matchupCard = stripPresenter(matchupCard);

    const replacements = new Map([
      [
        'cycle-mobile-scorebar',
        stripPresenter(
          await read(`${componentRoot}/cycle-mobile-scorebar/cycle-mobile-scorebar.html`),
        ),
      ],
      [
        'cycle-page-header',
        stripPresenter(await read(`${componentRoot}/cycle-page-header/cycle-page-header.html`)),
      ],
      [
        'cycle-status-banners',
        stripPresenter(
          await read(`${componentRoot}/cycle-status-banners/cycle-status-banners.html`),
        ),
      ],
      [
        'cycle-explainer',
        stripPresenter(await read(`${componentRoot}/cycle-explainer/cycle-explainer.html`)),
      ],
      [
        'cycle-matchup-toolbar',
        stripPresenter(
          await read(`${componentRoot}/cycle-matchup-toolbar/cycle-matchup-toolbar.html`),
        ),
      ],
      ['cycle-matchup-card', matchupCard],
    ]);

    let expanded = await read('src/app/features/cycles/cycle-one/cycle-one.html');
    for (const [selector, replacement] of replacements) {
      expanded = replaceComponent(expanded, selector, replacement);
    }

    const withoutSharedPrimitiveClasses = expanded.replace(
      /class="([^"]*)"/g,
      (_match, classValue) => {
        const retained = classValue
          .split(/\s+/)
          .filter((className) => className && !className.startsWith('rr-'));
        return retained.length > 0 ? `class="${retained.join(' ')}"` : '';
      },
    );
    const normalized = withoutSharedPrimitiveClasses.replace(/\s+/g, ' ').trim();
    const digest = createHash('sha256').update(normalized).digest('hex');

    assert.equal(
      digest,
      '2b26fb7750ef33938f05ca98e2af01d215ee1f5c2e5e3e759fbd78c264a9df3e',
      'The component expansion must preserve the approved Game Center markup, including the full-width six-game marker row.',
    );
  });

  test('the route remains the sole state and scoring presenter during the structural pass', async () => {
    const component = await read('src/app/features/cycles/cycle-one/cycle-one.ts');
    const childSources = await Promise.all([
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.ts'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.ts'),
      read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.ts'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-breakdown/cycle-matchup-breakdown.ts'),
    ]);

    assert.match(component, /readonly presenter = this;/);
    assert.match(component, /listenToSharedCycleScoring/);
    assert.match(component, /requestLeagueLiveScoringRefresh/);

    for (const source of childSources) {
      assert.match(source, /import type \{ CycleOne \} from/);
      assert.doesNotMatch(source, /firebase\/|firestore|httpsCallable|setDoc|updateDoc|runTransaction/);
    }
  });
});
