import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlPath = 'src/app/features/free-agents/free-agents.html';
const cssPath = 'src/app/features/free-agents/free-agents.css';
const tsPath = 'src/app/features/free-agents/free-agents.ts';

const source = (path) => readFile(path, 'utf8');

function cardSlice(html, loopMarker, endMarker) {
  const start = html.indexOf(loopMarker);
  assert.ok(start >= 0, `Missing ${loopMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `Missing card end marker after ${loopMarker}`);
  return html.slice(start, end);
}

test('League HQ places team identity before the most-used page grid', async () => {
  const html = await source('src/app/features/leagues/league-detail/league-detail.html');
  const identity = html.indexOf('id="my-league-team-title"');
  const essentials = html.indexOf('id="league-essentials-title"');

  assert.ok(identity > 0);
  assert.ok(essentials > identity);
  assert.ok(html.indexOf('id="invite-code-title"') < identity);
});

test('unified player rows lead with the six-game tracker and four compact decision metrics', async () => {
  const html = await source(htmlPath);
  const start = html.indexOf('@for (row of visibleBoardRows()');
  const end = html.indexOf('</article>', start);
  assert.ok(start >= 0 && end > start);
  const row = html.slice(start, end);

  assert.match(row, /unified-cycle-dots/);
  assert.match(row, />Season<\/small>/);
  assert.match(row, />Overall<\/small>/);
  assert.match(row, /rank<\/small>/);
  assert.match(row, />Next 6<\/small>/);
  assert.doesNotMatch(row, /Estimated final|Rest of season/);
});

test('waiver and free-agent rows use the same compact hierarchy and gated action area', async () => {
  const html = await source(htmlPath);

  assert.match(html, /row\.status === 'free-agent' \|\| row\.status === 'waivers'/);
  assert.match(html, /getBoardActionLabel\(row\)/);
  assert.match(html, /startBoardTransaction\(row\)/);
  assert.match(html, /processLeagueWaiver\(waiver\)/);
  assert.doesNotMatch(html, /claim count|\d+ claims?/i);
});

test('deep schedules, projections, and statistics remain available through Player Intel', async () => {
  const [html, detail] = await Promise.all([
    source(htmlPath),
    source('src/app/features/players/league-player-detail/league-player-detail.html'),
  ]);

  assert.match(html, /\['\/leagues', leagueId, 'players', row\.assetKey\]/);
  assert.match(detail, /Overview/);
  assert.match(detail, /Stats/);
  assert.match(detail, /Projection/);
  assert.match(detail, /Schedule/);
  assert.match(detail, /nextSixProjection/);
  assert.match(detail, /statBreakdown\(\)/);
});

test('the transaction step keeps exact timing and valid outgoing choices without duplicating the full intel page', async () => {
  const html = await source(htmlPath);

  assert.match(html, /transaction-incoming-row/);
  assert.match(html, /RinkRat verifies the exact six-game timeline before confirmation/);
  assert.match(html, /@for \(candidate of dropCandidates\(\)/);
  assert.match(html, /getCandidateActivationLabel\(candidate\)/);
  assert.match(html, /<details class="transaction-timing-details">/);
  assert.doesNotMatch(html, /Raw NHL totals → RinkRat fantasy points/);
});

test('the compact rows retain the primary Add and Claim actions', async () => {
  const html = await source(htmlPath);

  assert.match(html, /\(click\)="startBoardTransaction\(row\)"/);
  assert.match(html, /getBoardActionLabel\(row\)/);
  assert.match(html, /class="rr-button rr-button--primary unified-add-button"/);
  assert.match(html, /getDropCandidateActionLabel\(candidate\)/);
});

test('the unified layout remains responsive and player rows collapse cleanly on phones', async () => {
  const css = await source(cssPath);

  assert.match(css, /\.unified-player-main\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.unified-player-metrics\s*\{[\s\S]*repeat\(4, minmax\(58px, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.unified-player-row\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.unified-player-controls\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});

test('the simplification changes presentation only', async () => {
  const ts = await source(tsPath);

  assert.doesNotMatch(ts, /setDoc\(|updateDoc\(|deleteDoc\(|addDoc\(/);
  assert.doesNotMatch(ts, /makeSecureDraftPick|openNextCompetitionPeriod/);
});
