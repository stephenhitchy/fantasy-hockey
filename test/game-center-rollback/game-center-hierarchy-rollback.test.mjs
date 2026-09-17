import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { describe, test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function pathExists(relativePath) {
  try {
    await access(new URL(relativePath, ROOT), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe('Batch 6B.2 Game Center hierarchy rollback', () => {
  test('removes the duplicate matchup overview from the matchup card', async () => {
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html',
    );

    assert.doesNotMatch(template, /app-cycle-matchup-overview/);
    assert.match(template, /class="matchup-card-heading"/);
    assert.match(template, /app-cycle-mobile-head-to-head/);
    assert.match(template, /app-cycle-matchup-team-panel/);
  });

  test('removes the Batch 6B overview component and summary utility', async () => {
    assert.equal(
      await pathExists(
        'src/app/features/cycles/cycle-one/components/cycle-matchup-overview/cycle-matchup-overview.ts',
      ),
      false,
    );
    assert.equal(
      await pathExists('src/app/features/cycles/cycle-one/cycle-matchup-summary.util.ts'),
      false,
    );
  });

  test('restores the compact mobile scorebar without duplicate progress bars', async () => {
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-mobile-scorebar/cycle-mobile-scorebar.html',
    );

    assert.match(template, /Current matchup score/);
    assert.match(template, /Proj\./);
    assert.doesNotMatch(template, /getMatchupReadinessLabel/);
    assert.match(template, /getMobileMatchupFinishLabel\(\); as finishLabel/);
    assert.doesNotMatch(template, /role="progressbar"/);
    assert.doesNotMatch(template, /Games Counted|counted starter games/i);
  });

  test('keeps pending timing and unavailable projections out of the calm matchup surface', async () => {
    const [page, matchup, breakdown, mobileLineup, styles, presenter] = await Promise.all([
      read('src/app/features/cycles/cycle-one/cycle-one.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-breakdown/cycle-matchup-breakdown.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
      read('src/app/features/cycles/cycle-one/cycle-one.css'),
      read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    ]);

    assert.match(page, /getCurrentDisplayedMatchup\(\) && hasMatchupFinishDate\(\)/);
    assert.doesNotMatch(matchup, /matchup-readiness-badge|getMatchupReadinessLabel/);
    assert.match(breakdown, /shouldShowMatchupProjectionNote\(matchup\)/);
    assert.match(mobileLineup, /hasRosterDisplayMetricForMatchup\(matchup\)/);
    assert.match(mobileLineup, /hasTeamCycleProjection/);
    assert.match(styles, /\.g \.matchup-view-selector \{\s*display: none;/);
    assert.match(presenter, /getMobileMatchupFinishLabel\(\): string \| null/);
    assert.match(presenter, /return null;/);
  });

  test('retains the original per-team roster progress display', async () => {
    const template = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html',
    );

    assert.match(template, /Roster Progress/);
    assert.match(template, /getTeamRosterGamesPlayed\(ownerId\)/);
    assert.match(template, /getTeamRosterGamesLeft\(ownerId\)/);
    assert.match(template, /role="progressbar"/);
  });

  test('retains the Batch 6A reusable component architecture', async () => {
    const routeTemplate = await read('src/app/features/cycles/cycle-one/cycle-one.html');
    const matchupComponent = await read(
      'src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.ts',
    );

    assert.match(routeTemplate, /app-cycle-matchup-card/);
    assert.match(matchupComponent, /CycleMatchupTeamPanel/);
    assert.match(matchupComponent, /CycleMobileHeadToHead/);
    assert.match(matchupComponent, /CycleMatchupBreakdown/);
  });
});
