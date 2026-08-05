#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const ROUTE_PROFILES = Object.freeze({
  dashboard: {
    label: 'Dashboard',
    listeners: 4,
    coldStartReads: 18,
    steadyReadsPerMinute: 1.5,
  },
  gameCenter: {
    label: 'Game Center',
    listeners: 9,
    coldStartReads: 72,
    steadyReadsPerMinute: 7,
  },
  draftRoom: {
    label: 'Draft Room',
    listeners: 5,
    coldStartReads: 115,
    steadyReadsPerMinute: 12,
  },
  myTeam: {
    label: 'My Team',
    listeners: 5,
    coldStartReads: 34,
    steadyReadsPerMinute: 2.5,
  },
  freeAgents: {
    label: 'Available Players',
    listeners: 4,
    coldStartReads: 85,
    steadyReadsPerMinute: 2,
  },
});

const SCENARIOS = Object.freeze({
  balanced: {
    label: 'Balanced beta traffic',
    routeMix: {
      dashboard: 0.2,
      gameCenter: 0.4,
      draftRoom: 0.15,
      myTeam: 0.15,
      freeAgents: 0.1,
    },
    activeDraftLeagueShare: 0.15,
    activeScoringLeagueShare: 0.85,
    draftPickSecondsPerLeague: 60,
    rosterActionsPerUserPerHour: 0.15,
  },
  'draft-night': {
    label: 'All leagues drafting',
    routeMix: {
      dashboard: 0,
      gameCenter: 0,
      draftRoom: 1,
      myTeam: 0,
      freeAgents: 0,
    },
    activeDraftLeagueShare: 1,
    activeScoringLeagueShare: 0,
    draftPickSecondsPerLeague: 45,
    rosterActionsPerUserPerHour: 0,
  },
  'game-night': {
    label: 'Live game-night traffic',
    routeMix: {
      dashboard: 0.1,
      gameCenter: 0.7,
      draftRoom: 0,
      myTeam: 0.12,
      freeAgents: 0.08,
    },
    activeDraftLeagueShare: 0,
    activeScoringLeagueShare: 1,
    draftPickSecondsPerLeague: null,
    rosterActionsPerUserPerHour: 0.25,
  },
});

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    users: 100_000,
    managersPerLeague: 10,
    scenario: 'balanced',
    format: 'text',
  };

  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const [rawKey, rawValue = ''] = argument.slice(2).split('=', 2);

    if (rawKey === 'users') {
      options.users = Math.round(parsePositiveNumber(rawValue, options.users));
    } else if (rawKey === 'managers-per-league') {
      options.managersPerLeague = Math.round(
        parsePositiveNumber(rawValue, options.managersPerLeague),
      );
    } else if (rawKey === 'scenario' && SCENARIOS[rawValue]) {
      options.scenario = rawValue;
    } else if (rawKey === 'format' && ['text', 'json'].includes(rawValue)) {
      options.format = rawValue;
    }
  }

  return options;
}

function weightedTotal(routeMix, field) {
  return Object.entries(routeMix).reduce((total, [route, share]) => {
    return total + share * ROUTE_PROFILES[route][field];
  }, 0);
}

function extractNumber(source, pattern, fallback = null) {
  const match = pattern.exec(source);
  return match ? Number(match[1].replaceAll('_', '')) : fallback;
}

async function inspectArchitecture() {
  const [leagueAutomation, draftAutomation, indexSource, draftAuthority] = await Promise.all([
    fs.readFile(path.join(projectRoot, 'functions/src/league-automation.ts'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'functions/src/draft-automation.ts'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'functions/src/index.ts'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'functions/src/draft-authority.ts'), 'utf8'),
  ]);

  return {
    leagueAutomationParallelism: extractNumber(
      leagueAutomation,
      /const MAX_PARALLEL_LEAGUES\s*=\s*([\d_]+)/,
      2,
    ),
    leagueAutomationIntervalMinutes: extractNumber(
      leagueAutomation,
      /schedule:\s*'every\s+([\d_]+)\s+minutes'/,
      10,
    ),
    draftAutomationScanLimit: extractNumber(
      draftAutomation,
      /const DRAFT_AUTOMATION_SCAN_LIMIT\s*=\s*([\d_]+)/,
      250,
    ),
    draftAutomationMaxInstances: extractNumber(
      draftAutomation,
      /runScheduledDraftAutomation[\s\S]*?maxInstances:\s*([\d_]+)/,
      1,
    ),
    nhlProxyMaxInstances: extractNumber(
      indexSource,
      /export const nhlApiProxy[\s\S]*?maxInstances:\s*([\d_]+)/,
      10,
    ),
    publicProfileMaxInstances: extractNumber(
      indexSource,
      /export const getPublicManagerProfiles[\s\S]*?maxInstances:\s*([\d_]+)/,
      20,
    ),
    publicProfileConcurrency: extractNumber(
      indexSource,
      /export const getPublicManagerProfiles[\s\S]*?concurrency:\s*([\d_]+)/,
      40,
    ),
    secureDraftPickMaxInstances: extractNumber(
      draftAuthority,
      /export const makeSecureDraftPick[\s\S]*?maxInstances:\s*([\d_]+)/,
      100,
    ),
    draftAutomationSequentialLoop:
      /for \(const leagueId of leagueIds\) \{\s*results\.push\(await processLeagueDraftAutomation/.test(
        draftAutomation,
      ),
  };
}

function classifyCapacity({ activeDraftLeagues, activeScoringLeagues, architecture, scenario }) {
  const warnings = [];

  const draftScansNeeded = scenario.draftPickSecondsPerLeague
    ? activeDraftLeagues
    : 0;

  if (draftScansNeeded > architecture.draftAutomationScanLimit) {
    warnings.push({
      severity: 'red',
      area: 'Scheduled Draft Automation',
      finding:
        `${draftScansNeeded.toLocaleString()} active drafts exceed the current ` +
        `${architecture.draftAutomationScanLimit.toLocaleString()}-league scan limit.`,
      consequence:
        'Clock-expiry and Auto-Draft recovery would not be checked for every league each minute.',
    });
  }

  if (activeScoringLeagues > architecture.leagueAutomationParallelism * 100) {
    warnings.push({
      severity: 'red',
      area: 'Scheduled League Scoring',
      finding:
        `${activeScoringLeagues.toLocaleString()} active scoring leagues share a worker that processes only ` +
        `${architecture.leagueAutomationParallelism} leagues concurrently every ` +
        `${architecture.leagueAutomationIntervalMinutes} minutes.`,
      consequence:
        'A large game-night backlog would develop unless scoring work is sharded or queued per league.',
    });
  }

  if (architecture.nhlProxyMaxInstances <= 10) {
    warnings.push({
      severity: 'amber',
      area: 'NHL API Proxy',
      finding:
        `The NHL proxy is capped at ${architecture.nhlProxyMaxInstances} instances.`,
      consequence:
        'A 100,000-user cold-load burst could queue or reject uncached NHL requests even when Firestore is healthy.',
    });
  }

  warnings.push({
    severity: 'amber',
    area: 'Firestore Cold Start',
    finding:
      'The estimated opening read burst is measured in millions of document reads.',
    consequence:
      'The database can scale, but traffic must be ramped gradually and billing alerts must be active.',
  });

  warnings.push({
    severity: 'green',
    area: 'Static Hosting',
    finding:
      'Angular bundles and local image assets are served through Firebase Hosting/CDN.',
    consequence:
      'Static delivery is not the leading 100,000-user risk; live data fanout and automation are.',
  });

  return warnings;
}

export async function buildCapacityReport(options) {
  const scenario = SCENARIOS[options.scenario];
  const architecture = await inspectArchitecture();
  const leagues = Math.ceil(options.users / options.managersPerLeague);
  const activeDraftLeagues = Math.round(leagues * scenario.activeDraftLeagueShare);
  const activeScoringLeagues = Math.round(leagues * scenario.activeScoringLeagueShare);
  const listenersPerUser = weightedTotal(scenario.routeMix, 'listeners');
  const coldStartReadsPerUser = weightedTotal(scenario.routeMix, 'coldStartReads');
  const steadyReadsPerMinutePerUser = weightedTotal(
    scenario.routeMix,
    'steadyReadsPerMinute',
  );
  const draftPickRequestsPerSecond = scenario.draftPickSecondsPerLeague
    ? activeDraftLeagues / scenario.draftPickSecondsPerLeague
    : 0;
  const rosterActionRequestsPerSecond =
    (options.users * scenario.rosterActionsPerUserPerHour) / 3600;

  const report = {
    generatedAt: new Date().toISOString(),
    modelType: 'capacity-estimate-not-live-load-test',
    scenario: {
      id: options.scenario,
      label: scenario.label,
      users: options.users,
      managersPerLeague: options.managersPerLeague,
      leagues,
      activeDraftLeagues,
      activeScoringLeagues,
      routeMix: scenario.routeMix,
    },
    estimates: {
      concurrentFirestoreListeners: Math.round(options.users * listenersPerUser),
      listenersPerUser: Number(listenersPerUser.toFixed(2)),
      coldStartDocumentReads: Math.round(options.users * coldStartReadsPerUser),
      coldStartReadsPerUser: Number(coldStartReadsPerUser.toFixed(2)),
      steadyDocumentReadsPerMinute: Math.round(
        options.users * steadyReadsPerMinutePerUser,
      ),
      draftPickRequestsPerSecond: Number(draftPickRequestsPerSecond.toFixed(2)),
      rosterActionRequestsPerSecond: Number(rosterActionRequestsPerSecond.toFixed(2)),
    },
    architecture,
    findings: classifyCapacity({ activeDraftLeagues, activeScoringLeagues, architecture, scenario }),
    caveats: [
      'This is a deterministic architecture model, not 100,000 real browser sessions.',
      'Real validation must use a separate billed staging project and distributed load generators.',
      'Firestore listener fanout depends on document/query shape and how users are distributed across leagues.',
      'Never direct a 100,000-user test at the production Firebase project.',
    ],
  };

  return report;
}

function printText(report) {
  const { scenario, estimates, architecture, findings } = report;

  console.log(`RinkRat 100K Capacity Model — ${scenario.label}`);
  console.log('='.repeat(72));
  console.log(`Virtual users:             ${scenario.users.toLocaleString()}`);
  console.log(`Estimated leagues:         ${scenario.leagues.toLocaleString()}`);
  console.log(`Active draft leagues:      ${scenario.activeDraftLeagues.toLocaleString()}`);
  console.log(`Active scoring leagues:    ${scenario.activeScoringLeagues.toLocaleString()}`);
  console.log(`Listeners per user:        ${estimates.listenersPerUser}`);
  console.log(
    `Concurrent listeners:      ${estimates.concurrentFirestoreListeners.toLocaleString()}`,
  );
  console.log(
    `Cold-start reads:           ${estimates.coldStartDocumentReads.toLocaleString()}`,
  );
  console.log(
    `Steady reads per minute:    ${estimates.steadyDocumentReadsPerMinute.toLocaleString()}`,
  );
  console.log(
    `Draft-pick requests/sec:    ${estimates.draftPickRequestsPerSecond.toLocaleString()}`,
  );
  console.log(
    `Roster actions/sec:         ${estimates.rosterActionRequestsPerSecond.toLocaleString()}`,
  );
  console.log('');
  console.log('Current architecture signals');
  console.log('-'.repeat(72));
  console.log(
    `League scoring: ${architecture.leagueAutomationParallelism} concurrent leagues / ` +
      `${architecture.leagueAutomationIntervalMinutes}-minute sweep`,
  );
  console.log(
    `Draft automation: scan ${architecture.draftAutomationScanLimit} leagues, ` +
      `maxInstances ${architecture.draftAutomationMaxInstances}, ` +
      `sequential=${architecture.draftAutomationSequentialLoop}`,
  );
  console.log(`NHL proxy maxInstances: ${architecture.nhlProxyMaxInstances}`);
  console.log(
    `Public profile callable capacity setting: ` +
      `${architecture.publicProfileMaxInstances} × ` +
      `${architecture.publicProfileConcurrency} concurrency`,
  );
  console.log(`Secure draft pick maxInstances: ${architecture.secureDraftPickMaxInstances}`);
  console.log('');
  console.log('Findings');
  console.log('-'.repeat(72));

  for (const finding of findings) {
    console.log(`[${finding.severity.toUpperCase()}] ${finding.area}`);
    console.log(`  ${finding.finding}`);
    console.log(`  Impact: ${finding.consequence}`);
  }

  console.log('');
  console.log('This report is a capacity estimate, not a live 100,000-user test.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapacityReport(options);

  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
}
