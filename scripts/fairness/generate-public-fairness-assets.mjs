import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../../', import.meta.url);
const CHECK_ONLY = process.argv.includes('--check');

const source = JSON.parse(await readFile(new URL('config/public-fairness-report-source.json', ROOT), 'utf8'));
const acceptance = JSON.parse(await readFile(new URL('config/scoring-v4-acceptance.json', ROOT), 'utf8'));
const freeze = JSON.parse(await readFile(new URL('config/release-freeze/beta-freeze-policy.json', ROOT), 'utf8'));
const scoringRules = await readFile(new URL('src/app/core/scoring/scoring-rules.ts', ROOT), 'utf8');
const serverScoringRules = await readFile(new URL('functions/src/shared/core/scoring/scoring-rules.ts', ROOT), 'utf8');

assert.equal(source.schemaVersion, 1);
assert.equal(source.opportunityDesign.scheduledGamesPerActiveSlot, freeze.requiredGamesPerRosterSlot);
assert.equal(freeze.scoringRulesVersion, acceptance.scoringRulesVersion);
assert.equal(freeze.projectionVersion, acceptance.projectionVersion);
assert.equal(scoringRules, serverScoringRules, 'Client and server scoring rules must match before publishing fairness evidence.');
assert.match(scoringRules, /CURRENT_SCORING_RULES_VERSION\s*=\s*4/);

const evidenceFingerprint = createHash('sha256')
  .update(JSON.stringify(source))
  .update(JSON.stringify(acceptance))
  .update(scoringRules)
  .digest('hex');

const report = {
  ...source,
  releaseLabel: source.publishedReleaseLabel,
  scoringRulesVersion: acceptance.scoringRulesVersion,
  projectionVersion: acceptance.projectionVersion,
  evidenceFingerprint,
  downloads: {
    json: '/data/rinkrat-fairness-report-v1.json',
    csv: '/data/rinkrat-fairness-report-v1.csv'
  }
};

function csvCell(value) {
  const text = String(value ?? '');
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

const rows = [[
  'section',
  'metric_id',
  'label',
  'value',
  'unit',
  'evidence_type',
  'notes'
]];

for (const metric of report.headlineMetrics) {
  rows.push(['headline', metric.id, metric.label, metric.value, metric.unit, metric.evidenceType, '']);
}

for (const profile of report.positionProfiles) {
  rows.push(['position', `${profile.position}-mean`, `${profile.label} mean six-game points`, profile.meanSixGamePoints, 'points', profile.evidenceType, profile.role]);
  rows.push(['position', `${profile.position}-cv`, `${profile.label} coefficient of variation`, profile.coefficientOfVariation, 'ratio', profile.evidenceType, profile.role]);
  rows.push(['position', `${profile.position}-p10`, `${profile.label} 10th percentile`, profile.p10, 'points', profile.evidenceType, profile.role]);
  rows.push(['position', `${profile.position}-p90`, `${profile.label} 90th percentile`, profile.p90, 'points', profile.evidenceType, profile.role]);
  rows.push(['position', `${profile.position}-100-plus`, `${profile.label} 100+ frequency`, profile.hundredPlusPercent, 'percent', profile.evidenceType, profile.role]);
}

for (const [metricId, value] of Object.entries(report.leagueSimulation)) {
  if (typeof value !== 'number') {
    continue;
  }
  rows.push(['simulation', metricId, metricId, value, 'percent', 'v4-sensitivity-estimate', report.leagueSimulation.interpretation]);
}

for (const check of report.archetypeChecks) {
  rows.push(['archetype', check.id, check.label, check.status, 'status', 'historical-audit', check.finding]);
}

for (const range of report.acceptanceRanges) {
  rows.push(['acceptance', range.id, range.label, `${range.minimum}-${range.maximum}`, range.unit, range.basis, 'Initial operating range; not an industry guarantee.']);
}

const jsonText = `${JSON.stringify(report, null, 2)}\n`;
const csvText = `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
const jsonUrl = new URL('public/data/rinkrat-fairness-report-v1.json', ROOT);
const csvUrl = new URL('public/data/rinkrat-fairness-report-v1.csv', ROOT);

if (CHECK_ONLY) {
  assert.equal(await readFile(jsonUrl, 'utf8'), jsonText, 'Public fairness JSON is stale.');
  assert.equal(await readFile(csvUrl, 'utf8'), csvText, 'Public fairness CSV is stale.');
  console.log(`Public fairness report assets verified: ${report.releaseLabel} · fingerprint ${evidenceFingerprint.slice(0, 12)}.`);
  process.exit(0);
}

await writeFile(jsonUrl, jsonText);
await writeFile(csvUrl, csvText);
console.log(`Generated public fairness report assets: ${report.releaseLabel} · fingerprint ${evidenceFingerprint.slice(0, 12)}.`);
