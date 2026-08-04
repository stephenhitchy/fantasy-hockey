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

test('free-agent cards lead with three decision metrics instead of every projection value', async () => {
  const html = await source(htmlPath);
  const card = cardSlice(html, '@for (asset of availableAssets()', '</article>');
  const details = card.indexOf('<details class="decision-details');
  const defaultView = card.slice(0, details);

  assert.match(defaultView, /Season points/);
  assert.match(defaultView, /Next 6 games/);
  assert.match(defaultView, /Rest of season/);
  assert.doesNotMatch(defaultView, /Estimated final/);
  assert.equal((defaultView.match(/decision-metric-grid--primary/g) ?? []).length, 1);
});

test('waiver cards use the same compact decision hierarchy', async () => {
  const html = await source(htmlPath);
  const card = cardSlice(html, '@for (waiver of availableWaivers()', '</article>');
  const details = card.indexOf('<details class="decision-details');
  const defaultView = card.slice(0, details);

  for (const label of ['Season points', 'Next 6 games', 'Rest of season']) {
    assert.match(defaultView, new RegExp(label));
  }
  assert.match(defaultView, /selectWaiver\(waiver\)/);
  assert.match(defaultView, /processLeagueWaiver\(waiver\)/);
});

test('six-game markers and estimated final totals remain available after selecting a player', async () => {
  const html = await source(htmlPath);
  const listEnd = html.indexOf('<app-action-sheet');
  const listMarkup = html.slice(0, listEnd);
  const comparisonMarkup = html.slice(listEnd);

  assert.doesNotMatch(listMarkup, /cycle-decision-block--details/);
  assert.equal((comparisonMarkup.match(/cycle-decision-block--details/g) ?? []).length, 1);
  assert.equal((comparisonMarkup.match(/Estimated final total/g) ?? []).length, 1);
  assert.match(comparisonMarkup, /getCurrentCycleMarker\(addAsset, dotIndex\)/);
  assert.match(comparisonMarkup, /Why this projection\?/);
});

test('the full current-season scoring breakdown is preserved in the comparison sheet', async () => {
  const html = await source(htmlPath);

  assert.match(html, /Stat totals → fantasy points/);
  assert.match(html, /getStatBreakdown\(addAsset\)/);
  assert.match(html, /Combined scoring-category contribution/);
});

test('the compact cards retain the primary add and waiver actions', async () => {
  const html = await source(htmlPath);

  assert.match(html, /\(click\)="selectAddAsset\(asset\)"/);
  assert.match(html, /\(click\)="selectWaiver\(waiver\)"/);
  assert.match(html, /class="choose-slot-button rr-button rr-button--primary"/);
  assert.match(html, /class="claim-button rr-button rr-button--primary"/);
});

test('the simplified layout remains responsive and details expand to one column', async () => {
  const css = await source(cssPath);

  assert.match(css, /\.decision-asset-card\s*\{[\s\S]*grid-template-columns:\s*minmax\(230px, 1\.2fr\)[\s\S]*minmax\(330px, 1\.35fr\)[\s\S]*minmax\(170px, 0\.66fr\)/);
  assert.match(css, /\.decision-metric-grid--primary\s*\{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.decision-detail-overview\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.decision-detail-overview,[\s\S]*\.decision-detail-grid[\s\S]*grid-template-columns:\s*1fr/);
});

test('the simplification changes presentation only', async () => {
  const ts = await source(tsPath);

  assert.doesNotMatch(ts, /setDoc\(|updateDoc\(|deleteDoc\(|addDoc\(/);
  assert.doesNotMatch(ts, /makeSecureDraftPick|openNextCompetitionPeriod/);
});
