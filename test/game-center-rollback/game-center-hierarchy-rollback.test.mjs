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
    assert.match(template, /mobile-score-finish.*getMobileMatchupFinishLabel\(\)/s);
    assert.doesNotMatch(template, /role="progressbar"/);
    assert.doesNotMatch(template, /Games Counted|counted starter games/i);
  });

  test('keeps finish timing useful without duplicating it across mobile surfaces', async () => {
    const [
      page,
      matchup,
      teamPanel,
      breakdown,
      mobileLineup,
      mobileStyles,
      finishStyles,
      styles,
      presenter,
    ] = await Promise.all([
      read('src/app/features/cycles/cycle-one/cycle-one.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-card/cycle-matchup-card.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-team-panel/cycle-matchup-team-panel.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-breakdown/cycle-matchup-breakdown.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html'),
      read('src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.css'),
      read('src/app/features/cycles/cycle-one/components/cycle-matchup-finish-card/cycle-matchup-finish-card.css'),
      read('src/app/features/cycles/cycle-one/cycle-one.css'),
      read('src/app/features/cycles/cycle-one/cycle-one.ts'),
    ]);

    assert.match(page, /@if \(getCurrentDisplayedMatchup\(\)\)/);
    assert.doesNotMatch(matchup, /matchup-readiness-badge|getMatchupReadinessLabel/);
    assert.match(breakdown, /shouldShowMatchupProjectionNote\(matchup\)/);
    assert.match(mobileLineup, /hasRosterDisplayMetricForMatchup\(matchup\)/);
    assert.match(mobileLineup, /hasTeamCycleProjection/);
    assert.match(mobileLineup, /Points by position/);
    assert.match(mobileLineup, /presenter\.breakdownPositions/);
    assert.match(mobileLineup, /presenter\.getPositionCurrentTotal/);
    assert.match(mobileStyles, /\.mobile-position-comparison/);
    assert.match(
      mobileStyles,
      /\.mobile-position-comparison thead th:first-child\s*\{[\s\S]*?white-space:\s*nowrap;/,
    );
    assert.match(
      mobileStyles,
      /@media \(max-width: 360px\)[\s\S]*?\.mobile-live-player-statusline-compact\s*\{[\s\S]*?width:\s*100%;/,
    );
    assert.ok(
      mobileLineup.indexOf('@for (section of getPositionSections(); track section.key)') <
        mobileLineup.indexOf('Points by position'),
      'Position totals should follow the active position blocks.',
    );
    assert.ok(
      mobileLineup.indexOf('Points by position') <
        mobileLineup.indexOf('mobile-live-bench-section'),
      'Position totals should appear before the collapsed bench.',
    );
    assert.match(finishStyles, /@media \(max-width: 780px\)[\s\S]*?:host \{\s*display: none;/);
    assert.doesNotMatch(teamPanel + mobileLineup + presenter, /getPendingWindowCallout|getPendingWindowTooltip/);
    assert.doesNotMatch(mobileLineup, /getActiveStatusLine/);
    assert.match(styles, /\.g \.matchup-view-selector \{\s*display: none;/);
    assert.match(presenter, /getMobileMatchupFinishLabel\(\): string/);
    assert.match(presenter, /'End date pending'/);
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
