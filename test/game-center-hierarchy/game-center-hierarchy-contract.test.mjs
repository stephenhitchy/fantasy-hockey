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

describe('Batch 6B Game Center information hierarchy', () => {
  test('the matchup overview is a dedicated presentation-only component', async () => {
    const shell = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
    );
    const component = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.ts',
    );
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.html',
    );

    assert.match(shell, /<app-cycle-matchup-overview\b/);
    assert.ok(lineCount(template) < 190, `Overview template grew to ${lineCount(template)} lines.`);
    assert.match(component, /import type \{ CycleOne \}/);
    assert.doesNotMatch(component, /firebase\/|firestore|httpsCallable|setDoc|updateDoc|runTransaction/);
  });

  test('the first matchup message is user-relative and result-oriented', async () => {
    const presenter = await read('src/app/features/cycles/cycle-one/cycle-matchup-summary.util.ts');
    const overview = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.html',
    );

    for (const phrase of [
      'You lead by',
      'You trail by',
      'You won by',
      'You lost by',
      'Your matchup is tied',
    ]) {
      assert.match(presenter, new RegExp(phrase));
    }

    assert.match(overview, /getMatchupOutcomeHeadline/);
    assert.match(overview, /getMatchupOutcomeDetail/);
    assert.match(overview, /Current matchup/);
    assert.match(overview, /Final result/);
  });

  test('projection wording identifies its stage instead of presenting certainty', async () => {
    const presenter = await read('src/app/features/cycles/cycle-one/cycle-matchup-summary.util.ts');
    const overview = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.html',
    );

    for (const phrase of [
      'Pre-matchup estimate',
      'Early estimate',
      'Developing estimate',
      'Late-matchup estimate',
      'Near-final estimate',
    ]) {
      assert.match(presenter, new RegExp(phrase));
    }

    assert.match(overview, /Projected finish/);
    assert.match(overview, /Projections are estimates/);
    assert.match(overview, /independent six-game window/);
  });

  test('desktop and mobile progress bars expose semantic counted-game values', async () => {
    const overview = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.html',
    );
    const mobile = await read(
      'src/app/features/cycles/cycle-one/components/cycle-mobile-scorebar/cycle-mobile-scorebar.html',
    );
    const teamPanel = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    );

    for (const source of [overview, mobile, teamPanel]) {
      assert.match(source, /role="progressbar"/);
      assert.match(source, /aria-valuemin/);
      assert.match(source, /aria-valuemax/);
      assert.match(source, /aria-valuenow/);
      assert.match(source, /aria-valuetext/);
    }

    assert.match(teamPanel, /Counted Games/);
    assert.doesNotMatch(teamPanel, />Roster Progress</);
  });

  test('the sticky mobile scorebar uses a compact status and per-team progress', async () => {
    const mobile = await read(
      'src/app/features/cycles/cycle-one/components/cycle-mobile-scorebar/cycle-mobile-scorebar.html',
    );

    assert.match(mobile, /getMatchupScoreAriaLabel/);
    assert.match(mobile, /getMatchupMobileStatusLabel/);
    assert.equal((mobile.match(/mobile-score-progress-track/g) ?? []).length, 2);
    assert.equal((mobile.match(/mobile-score-progress-fill/g) ?? []).length, 2);
    assert.match(mobile, /counted/);
  });

  test('the readiness badges no longer lead with system-log language', async () => {
    const presenter = await read('src/app/features/cycles/cycle-one/cycle-one.ts');

    assert.match(presenter, /Starter Games Left/);
    assert.match(presenter, /starter games remain/);
    assert.match(presenter, /across all matchups/);
    assert.doesNotMatch(presenter, /return `Waiting on \$\{gamesLeft\} \$\{gameLabel\}`/);
  });

  test('new hierarchy styles are component-scoped and include mobile and reduced-motion behavior', async () => {
    const overviewStyles = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.css',
    );
    const mobileStyles = await read(
      'src/app/features/cycles/cycle-one/components/cycle-mobile-scorebar/cycle-mobile-scorebar.css',
    );

    for (const selector of [
      '.matchup-overview',
      '.matchup-overview-scoreboard',
      '.matchup-overview-insights',
      '.matchup-overview-progress-grid',
    ]) {
      assert.match(overviewStyles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    assert.match(mobileStyles, /\.mobile-score-progress-track/);
    assert.match(overviewStyles, /@media \(max-width: 780px\)/);
    assert.match(overviewStyles + mobileStyles, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(overviewStyles, /:host \{/);
    assert.match(overviewStyles, /data-background-theme='light-ice'/);
    assert.match(mobileStyles, /:host \{/);
    assert.doesNotMatch(overviewStyles + mobileStyles, /(^|\n)app-cycle-one\s/);
  });
});
