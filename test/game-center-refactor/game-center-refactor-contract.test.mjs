import assert from 'node:assert/strict';
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
    assert.match(template, /presenter\.getTeamPicksByPositionForDisplay\(ownerId,/);
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
      'getPositionGamesLeft',
      'isFutureWindowPending',
    ]) {
      assert.match(teamPanel + mobile, new RegExp(`presenter\\.${requiredCall}\\(`));
    }

    assert.doesNotMatch(teamPanel + mobile, /getPendingWindowCallout|getPendingWindowTooltip/);
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

  test('desktop player cards reuse the removed status-copy space without changing mobile', async () => {
    const stylesheet = await read('src/app/features/cycles/cycle-one/cycle-one.css');

    assert.match(
      stylesheet,
      /@media \(min-width: 781px\)\s*\{[\s\S]*?\.g \.active-matchup-player-card\s*\{[\s\S]*?grid-template-areas:\s*'logo identity scores'\s*'markers markers scores';/,
    );
    assert.match(
      stylesheet,
      /@media \(min-width: 781px\)[\s\S]*?\.g \.active-matchup-player-card \.window-game-markers\s*\{[\s\S]*?grid-area:\s*markers;/,
    );
    assert.match(
      stylesheet,
      /@media \(min-width: 1181px\) and \(max-width: 1599px\)[\s\S]*?\.teams-comparison:not\(\.single-team-view\) \.active-matchup-player-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 52px;[\s\S]*?grid-template-areas:\s*'identity scores'\s*'markers scores';/,
    );
    assert.match(
      stylesheet,
      /\.teams-comparison:not\(\.single-team-view\) \.active-matchup-player-card \.fantasy-player-logo\s*\{\s*display:\s*none;/,
    );
    assert.match(stylesheet, /@media \(max-width: 780px\)/);
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

  test('expanding the component boundaries preserves the streamlined Game Center structure', async () => {
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

    const normalized = expanded.replace(/\s+/g, ' ').trim();

    assert.doesNotMatch(expanded, /<app-cycle-(?:mobile-scorebar|page-header|status-banners|matchup-toolbar|matchup-card)\b/);
    assert.doesNotMatch(normalized, /app-cycle-explainer|How the Six-Game Cycle Works/);
    assert.match(normalized, /Testing Controls/);
    assert.match(normalized, /Private owner tools for controlled preseason testing/);
    assert.match(normalized, /Advance One NHL Day/);
    assert.match(normalized, /Refresh Shared Scores/);
    assert.match(normalized, /Roster Progress/);
    assert.match(normalized, /window-game-markers/);
    assert.match(normalized, /fantasy-player-card/);
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

  test('the score-first page hides routine refresh telemetry and keeps only a concise finish date', async () => {
    const [route, statusComponent, statusTemplate, finishTemplate, finishStyles] =
      await Promise.all([
        read('src/app/features/cycles/cycle-one/cycle-one.ts'),
        read(
          'src/app/features/cycles/cycle-one/components/cycle-status-banners/cycle-status-banners.ts',
        ),
        read(
          'src/app/features/cycles/cycle-one/components/cycle-status-banners/cycle-status-banners.html',
        ),
        read(
          'src/app/features/cycles/cycle-one/components/cycle-matchup-finish-card/cycle-matchup-finish-card.html',
        ),
        read(
          'src/app/features/cycles/cycle-one/components/cycle-matchup-finish-card/cycle-matchup-finish-card.css',
        ),
      ]);

    assert.doesNotMatch(statusComponent, /LiveScoreFreshness/);
    assert.doesNotMatch(statusTemplate, /app-live-score-freshness|shared-scoring-status-card/);
    assert.match(statusTemplate, /role="status"/);
    assert.match(statusTemplate, /aria-live="polite"/);

    const visibilityMethod = route.match(
      /shouldShowCompactAutoStatus\(\): boolean \{[\s\S]*?\n  \}/,
    )?.[0] ?? '';
    assert.doesNotMatch(visibilityMethod, /scoringLoading/);
    assert.doesNotMatch(route, /Checking Current Scores/);

    assert.match(finishTemplate, /matchup-finish-eyebrow/);
    assert.match(finishTemplate, /matchup-finish-date/);
    assert.doesNotMatch(
      finishTemplate,
      /matchup-finish-icon|matchup-finish-progress|<p>|reaches game 6/,
    );
    assert.match(finishStyles, /font-size: 12px/);
    assert.match(finishStyles, /font-size: 14px/);
    assert.match(finishStyles, /--rr-card-shadow: none/);
  });
});
