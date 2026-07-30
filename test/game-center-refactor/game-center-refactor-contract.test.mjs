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
      'app-cycle-explainer',
      'app-cycle-matchup-toolbar',
      'app-cycle-matchup-card',
    ]) {
      assert.match(template, new RegExp(`<${selector}\\b`));
    }
  });

  test('the matchup card delegates its four major rendering regions', async () => {
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
    );

    assert.ok(
      lineCount(template) < 150,
      `Expected the matchup card shell to stay below 150 lines, received ${lineCount(template)}.`,
    );
    assert.match(template, /<app-cycle-matchup-overview\b/);
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

    assert.match(teamPanel, /Counted Games/);
    assert.match(teamPanel, /Does not score while on the bench/);
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


  test('the hierarchy pass keeps the extracted matchup regions and asynchronous window details', async () => {
    const matchupCard = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
    );
    const overview = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.html',
    );
    const teamPanel = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    );

    assert.match(matchupCard, /<app-cycle-matchup-overview\b/);
    assert.match(matchupCard, /<app-cycle-mobile-head-to-head\b/);
    assert.match(matchupCard, /<app-cycle-matchup-team-panel\b/);
    assert.match(matchupCard, /<app-cycle-matchup-breakdown\b/);

    assert.match(overview, /getMatchupOutcomeHeadline/);
    assert.match(overview, /getMatchupProgressSummary/);
    assert.match(overview, /role="progressbar"/);
    assert.match(teamPanel, /getWindowGameMarkers/);
    assert.match(teamPanel, /getPendingWindowCallout/);
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
