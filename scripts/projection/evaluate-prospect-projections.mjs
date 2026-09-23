import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EVALUATION_SCHEMA_VERSION = 1;
const MIN_HELD_OUT_OBSERVATIONS = 100;
const MIN_HELD_OUT_COHORT = 25;
const MAX_ACCEPTABLE_APPEARANCE_BRIER = 0.25;

function finite(value, label, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
  }

  return value;
}

function isoDate(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T12:00:00Z`))
  ) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }

  return value;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

const arguments_ = process.argv.slice(2);
const allowSmallSyntheticFixture = arguments_.includes(
  '--allow-small-synthetic-fixture',
);
const inputPath = arguments_.find((argument) => !argument.startsWith('--'));

if (!inputPath) {
  throw new Error(
    'Usage: npm run prospects:evaluate -- path/to/historical-evaluation.json ' +
      '[--allow-small-synthetic-fixture]',
  );
}

const absolutePath = resolve(process.cwd(), inputPath);
const input = JSON.parse(await readFile(absolutePath, 'utf8'));

if (!input || typeof input !== 'object' || !Array.isArray(input.observations)) {
  throw new Error('Historical evaluation input must contain an observations array.');
}

if (input.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
  throw new Error(
    `Historical evaluation schemaVersion must be ${EVALUATION_SCHEMA_VERSION}.`,
  );
}

if (typeof input.datasetId !== 'string' || input.datasetId.trim().length < 3) {
  throw new Error('Historical evaluation datasetId must identify the frozen dataset.');
}

if (typeof input.source !== 'string' || input.source.trim().length < 3) {
  throw new Error('Historical evaluation source must describe the dataset provenance.');
}

if (input.split !== 'held-out' && input.split !== 'synthetic-fixture') {
  throw new Error(
    'Historical evaluation split must be "held-out" or "synthetic-fixture".',
  );
}

if (allowSmallSyntheticFixture && input.split !== 'synthetic-fixture') {
  throw new Error(
    '--allow-small-synthetic-fixture may only be used with split "synthetic-fixture".',
  );
}

if (!allowSmallSyntheticFixture && input.split !== 'held-out') {
  throw new Error(
    'Synthetic fixtures are test-only. Pass --allow-small-synthetic-fixture explicitly.',
  );
}

const minimumObservationCount = allowSmallSyntheticFixture
  ? 2
  : MIN_HELD_OUT_OBSERVATIONS;

if (input.observations.length < minimumObservationCount) {
  throw new Error(
    allowSmallSyntheticFixture
      ? 'Synthetic evaluation requires at least two observations.'
      : `Held-out evaluation requires at least ${MIN_HELD_OUT_OBSERVATIONS} observations.`,
  );
}

const observations = input.observations.map((value, index) => {
  const label = `observations[${index}]`;

  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must be an object.`);
  }

  const forecastDate = isoDate(value.forecastDate, `${label}.forecastDate`);
  const evidenceAsOf = isoDate(value.evidenceAsOf, `${label}.evidenceAsOf`);
  const outcomeThrough = isoDate(value.outcomeThrough, `${label}.outcomeThrough`);

  if (evidenceAsOf > forecastDate) {
    throw new Error(`${label} leaks evidence observed after the forecast date.`);
  }

  if (outcomeThrough <= forecastDate) {
    throw new Error(`${label}.outcomeThrough must be after the forecast date.`);
  }

  if (typeof value.madeNhl !== 'boolean') {
    throw new Error(`${label}.madeNhl must be boolean.`);
  }

  const assignedGames = finite(value.assignedGames, `${label}.assignedGames`, 1, 20);
  const actualAppearances = finite(
    value.actualAppearances,
    `${label}.actualAppearances`,
    0,
    assignedGames,
  );

  return {
    madeNhl: value.madeNhl,
    assignedGames,
    actualAppearances,
    projectedAppearanceProbability: finite(
      value.projectedAppearanceProbability,
      `${label}.projectedAppearanceProbability`,
      0,
      1,
    ),
    projectedWindowPoints: finite(
      value.projectedWindowPoints,
      `${label}.projectedWindowPoints`,
      0,
    ),
    baselineWindowPoints: finite(
      value.baselineWindowPoints,
      `${label}.baselineWindowPoints`,
      0,
    ),
    actualWindowPoints: finite(
      value.actualWindowPoints,
      `${label}.actualWindowPoints`,
      0,
    ),
  };
});

const nhlEntrantCount = observations.filter((entry) => entry.madeNhl).length;
const nonEntrantCount = observations.length - nhlEntrantCount;

if (nhlEntrantCount === 0 || nonEntrantCount === 0) {
  throw new Error(
    'Evaluation must include both NHL entrants and prospects who did not make or remain in the NHL.',
  );
}

if (
  !allowSmallSyntheticFixture &&
  (nhlEntrantCount < MIN_HELD_OUT_COHORT ||
    nonEntrantCount < MIN_HELD_OUT_COHORT)
) {
  throw new Error(
    'Held-out evaluation requires at least ' +
      `${MIN_HELD_OUT_COHORT} NHL entrants and ${MIN_HELD_OUT_COHORT} non-entrants.`,
  );
}

const prospectAbsoluteErrors = observations.map((entry) =>
  Math.abs(entry.projectedWindowPoints - entry.actualWindowPoints)
);
const baselineAbsoluteErrors = observations.map((entry) =>
  Math.abs(entry.baselineWindowPoints - entry.actualWindowPoints)
);
const appearanceBrierScores = observations.map((entry) => {
  const actualRate = entry.actualAppearances / entry.assignedGames;
  return (entry.projectedAppearanceProbability - actualRate) ** 2;
});
const prospectWindowMae = mean(prospectAbsoluteErrors);
const baselineWindowMae = mean(baselineAbsoluteErrors);
const appearanceBrierScore = mean(appearanceBrierScores);
const candidateImprovedOnBaseline = prospectWindowMae < baselineWindowMae;
const releaseGateEligible = input.split === 'held-out';
const output = {
  schemaVersion: EVALUATION_SCHEMA_VERSION,
  datasetId: input.datasetId.trim(),
  source: input.source.trim(),
  split: input.split,
  evaluationStatus: releaseGateEligible
    ? 'held-out-evaluation'
    : 'fixture-only',
  observationCount: observations.length,
  nhlEntrantCount,
  nonEntrantCount,
  prospectWindowMae: Number(prospectWindowMae.toFixed(4)),
  baselineWindowMae: Number(baselineWindowMae.toFixed(4)),
  appearanceBrierScore: Number(appearanceBrierScore.toFixed(4)),
  candidateImprovedOnBaseline,
  releaseGateEligible,
  calibrationGatePassed:
    releaseGateEligible &&
    candidateImprovedOnBaseline &&
    appearanceBrierScore <= MAX_ACCEPTABLE_APPEARANCE_BRIER,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
