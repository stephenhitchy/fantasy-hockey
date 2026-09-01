#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const STATIC_ROUTE_PROFILES = Object.freeze({
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
    coldStartReads: 85,
    steadyReadsPerMinute: 2,
  },
});

const FREE_AGENTS_LISTENER_MODEL = Object.freeze({
  fixedRouteListeners: 9,
  rosterListenersPerTeam: 1,
  assumedActiveCycles: 1,
  teamWindowListenersPerActiveCycle: 1,
});

function buildRouteProfiles(managersPerLeague) {
  const freeAgentsListenerEvidence = {
    ...FREE_AGENTS_LISTENER_MODEL,
    assumedTeamCount: managersPerLeague,
  };

  return Object.fromEntries(
    Object.entries(STATIC_ROUTE_PROFILES).map(([route, profile]) => [
      route,
      route === 'freeAgents'
        ? {
            ...profile,
            listeners:
              freeAgentsListenerEvidence.fixedRouteListeners +
              freeAgentsListenerEvidence.assumedTeamCount *
                freeAgentsListenerEvidence.rosterListenersPerTeam +
              freeAgentsListenerEvidence.assumedActiveCycles *
                freeAgentsListenerEvidence.teamWindowListenersPerActiveCycle,
            listenerEvidence: freeAgentsListenerEvidence,
          }
        : { ...profile },
    ]),
  );
}

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

function weightedTotal(routeProfiles, routeMix, field) {
  return Object.entries(routeMix).reduce((total, [route, share]) => {
    return total + share * routeProfiles[route][field];
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
      /export const runScheduledLeagueAutomation[\s\S]*?schedule:\s*'every\s+([\d_]+)\s+minutes'/,
      10,
    ),
    leagueAutomationTaskQueuePresent:
      /export const processLeagueAutomationTask = onTaskDispatched/.test(leagueAutomation) &&
      /getFunctions\(\)\.taskQueue<LeagueAutomationTaskPayload>\([\s\S]*?processLeagueAutomationTask/.test(
        leagueAutomation,
      ),
    leagueAutomationDispatcherPresent:
      /export const dispatchDueLeagueAutomation = onSchedule/.test(leagueAutomation) &&
      /leagueAutomationSchedules/.test(leagueAutomation),
    leagueAutomationTaskMaxConcurrentDispatches: extractNumber(
      leagueAutomation,
      /const LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES\s*=\s*([\d_]+)/,
      null,
    ),
    leagueAutomationTaskMaxPendingTasks: extractNumber(
      leagueAutomation,
      /const LEAGUE_AUTOMATION_QUEUE_MAX_PENDING_TASKS\s*=\s*([\d_]+)/,
      null,
    ),
    leagueAutomationTaskDeterministicIds:
      /function buildLeagueAutomationTaskId/.test(leagueAutomation) &&
      /enqueue\(payload,\s*\{[\s\S]*?id:\s*taskId/.test(leagueAutomation),
    leagueAutomationQueueDefaultMode:
      /const LEAGUE_AUTOMATION_QUEUE_DEFAULT_MODE\s*=\s*['"]([^'"]+)['"]/.exec(
        leagueAutomation,
      )?.[1] ?? 'unknown',
    leagueAutomationScheduleBootstrapPresent:
      /export const bootstrapLeagueAutomationSchedules = onSchedule/.test(leagueAutomation),
    leagueAutomationStaleRecoveryPresent:
      /export const recoverStaleLeagueAutomationQueue = onSchedule/.test(leagueAutomation),
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
    draftDeadlineTaskQueuePresent:
      /export const processDraftClockDeadline = onTaskDispatched/.test(draftAutomation) &&
      /getFunctions\(\)\.taskQueue<.*>\(\s*['"]processDraftClockDeadline['"]/.test(draftAutomation),
    draftDeadlineTaskMaxConcurrentDispatches: extractNumber(
      draftAutomation,
      /export const processDraftClockDeadline[\s\S]*?maxConcurrentDispatches:\s*([\d_]+)/,
      null,
    ),
    draftDeadlineTaskMaxAttempts: extractNumber(
      draftAutomation,
      /export const processDraftClockDeadline[\s\S]*?maxAttempts:\s*([\d_]+)/,
      null,
    ),
    draftDeadlineTaskDeterministicIds:
      /function buildDraftClockTaskId/.test(draftAutomation) &&
      /enqueue\(payload,\s*\{[\s\S]*?id:\s*buildDraftClockTaskId\(payload\)/.test(draftAutomation),
    draftDeadlineTaskScheduledDelivery:
      /scheduleTime:\s*new Date/.test(draftAutomation),
  };
}

function classifyCapacity({ activeDraftLeagues, activeScoringLeagues, architecture, scenario }) {
  const warnings = [];

  if (scenario.draftPickSecondsPerLeague && activeDraftLeagues > 0) {
    if (
      architecture.draftDeadlineTaskQueuePresent &&
      architecture.draftDeadlineTaskDeterministicIds &&
      architecture.draftDeadlineTaskScheduledDelivery
    ) {
      warnings.push({
        severity: 'amber',
        area: 'Draft Deadline Task Queue',
        finding:
          `Each live pick already receives an exact Cloud Tasks deadline with deterministic ` +
          `deduplication. The worker currently allows ` +
          `${architecture.draftDeadlineTaskMaxConcurrentDispatches ?? 'an unknown number of'} concurrent dispatches.`,
        consequence:
          'This is the correct primary architecture, but task duration, queue age, and deadline drift still need staged draft-night measurement before claiming 100,000-user capacity.',
      });
    } else {
      warnings.push({
        severity: 'red',
        area: 'Draft Deadline Automation',
        finding: 'The source does not expose a complete exact per-pick task-queue path.',
        consequence:
          'Draft expiration would depend on periodic scanning and could miss or delay turns during a large draft-night spike.',
      });
    }

    if (activeDraftLeagues > architecture.draftAutomationScanLimit) {
      warnings.push({
        severity: 'amber',
        area: 'Draft Recovery Sweeper',
        finding:
          `${activeDraftLeagues.toLocaleString()} active drafts exceed the fallback ` +
          `${architecture.draftAutomationScanLimit.toLocaleString()}-league recovery scan.`,
        consequence:
          'Exact Cloud Tasks remain the primary clock path, but a queue incident could leave some drafts outside the one-minute recovery sweep until the scan is paginated or sharded.',
      });
    }
  }

  if (activeScoringLeagues > architecture.leagueAutomationParallelism * 100) {
    const queueFoundationReady =
      architecture.leagueAutomationTaskQueuePresent &&
      architecture.leagueAutomationDispatcherPresent &&
      architecture.leagueAutomationTaskDeterministicIds &&
      architecture.leagueAutomationScheduleBootstrapPresent &&
      architecture.leagueAutomationStaleRecoveryPresent;

    if (queueFoundationReady) {
      warnings.push({
        severity: 'amber',
        area: 'League Scoring Queue Foundation',
        finding:
          `The source now contains deterministic per-league scoring tasks, due-time schedule documents, ` +
          `a one-minute dispatcher, stale-task recovery, and ` +
          `${architecture.leagueAutomationTaskMaxConcurrentDispatches ?? 'an unknown number of'} concurrent task dispatches.`,
        consequence:
          'The foundation is suitable for staging shadow and canary validation, but throughput, queue age, retry behavior, and cost still require measured load tests.',
      });

      if (architecture.leagueAutomationQueueDefaultMode !== 'primary') {
        warnings.push({
          severity: 'red',
          area: 'League Scoring Queue Cutover',
          finding:
            `The queue defaults to ${architecture.leagueAutomationQueueDefaultMode}; the existing ` +
            `${architecture.leagueAutomationParallelism}-league scheduled sweep remains the production scoring path.`,
          consequence:
            'Large-scale capacity does not improve until schedule coverage reaches 100%, canary results match the legacy worker, and the queue is intentionally promoted to primary mode.',
        });
      }
    } else {
      warnings.push({
        severity: 'red',
        area: 'Scheduled League Scoring',
        finding:
          `${activeScoringLeagues.toLocaleString()} active scoring leagues share a worker that processes only ` +
          `${architecture.leagueAutomationParallelism} leagues concurrently every ` +
          `${architecture.leagueAutomationIntervalMinutes} minutes.`,
        consequence:
          'A large game-night backlog would develop unless scoring work is dispatched as idempotent per-league tasks with bounded queue throughput.',
      });
    }
  }

  if (architecture.nhlProxyMaxInstances <= 10) {
    warnings.push({
      severity: 'amber',
      area: 'NHL API Proxy',
      finding:
        `The NHL proxy is capped at ${architecture.nhlProxyMaxInstances} instances and its fastest cache is process-local.`,
      consequence:
        'A cold-load or reconnect burst could repeat upstream requests across instances. Competitive NHL data should be ingested once into a shared ledger and reused by leagues and browsers.',
    });
  }

  warnings.push({
    severity: 'amber',
    area: 'Firestore Cold Start',
    finding:
      'The estimated opening read burst is measured in millions of document reads.',
    consequence:
      'The database can scale, but route listener counts must be measured, traffic must be ramped gradually, and billing alerts must be active.',
  });

  warnings.push({
    severity: 'green',
    area: 'Static Hosting',
    finding:
      'Angular bundles and local image assets are served through Firebase Hosting/CDN.',
    consequence:
      'Static delivery is not the leading 100,000-user risk; live data fanout and background automation are.',
  });

  return warnings;
}

export async function buildCapacityReport(options) {
  const scenario = SCENARIOS[options.scenario];
  const architecture = await inspectArchitecture();
  const routeProfiles = buildRouteProfiles(options.managersPerLeague);
  const leagues = Math.ceil(options.users / options.managersPerLeague);
  const activeDraftLeagues = Math.round(leagues * scenario.activeDraftLeagueShare);
  const activeScoringLeagues = Math.round(leagues * scenario.activeScoringLeagueShare);
  const listenersPerUser = weightedTotal(routeProfiles, scenario.routeMix, 'listeners');
  const coldStartReadsPerUser = weightedTotal(
    routeProfiles,
    scenario.routeMix,
    'coldStartReads',
  );
  const steadyReadsPerMinutePerUser = weightedTotal(
    routeProfiles,
    scenario.routeMix,
    'steadyReadsPerMinute',
  );
  const draftPickRequestsPerSecond = scenario.draftPickSecondsPerLeague
    ? activeDraftLeagues / scenario.draftPickSecondsPerLeague
    : 0;
  const rosterActionRequestsPerSecond =
    (options.users * scenario.rosterActionsPerUserPerHour) / 3600;
  const scoringIntervalSeconds = architecture.leagueAutomationIntervalMinutes * 60;
  const scoringConcurrencyTargets = Object.fromEntries(
    [5, 10, 30].map((averageLeagueSeconds) => [
      `${averageLeagueSeconds}s`,
      Math.ceil((activeScoringLeagues * averageLeagueSeconds) / scoringIntervalSeconds),
    ]),
  );

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
      scoringConcurrencyTargets,
    },
    assumptions: {
      routeProfiles,
      listenerCounts:
        'source-derived planning estimate; replace with measured route envelopes before scale certification',
      documentReads:
        'planning estimate; initial snapshot document counts are not yet measured by the client monitor',
    },
    architecture,
    findings: classifyCapacity({ activeDraftLeagues, activeScoringLeagues, architecture, scenario }),
    caveats: [
      'This is a deterministic architecture model, not 100,000 real browser sessions.',
      'Real validation must use a separate billed staging project and distributed load generators.',
      'Firestore listener fanout depends on document/query shape and how users are distributed across leagues.',
      'Available Players includes one roster listener per fantasy team and one team-window listener per assumed active cycle.',
      'Cold-start and steady-read profiles remain planning assumptions until first-snapshot read telemetry is implemented.',
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
  console.log(
    `Scoring workers needed:     ${estimates.scoringConcurrencyTargets['5s']} @ 5s/league, ` +
      `${estimates.scoringConcurrencyTargets['10s']} @ 10s, ` +
      `${estimates.scoringConcurrencyTargets['30s']} @ 30s`,
  );
  console.log('');
  console.log('Current architecture signals');
  console.log('-'.repeat(72));
  console.log(
    `League scoring: ${architecture.leagueAutomationParallelism} concurrent leagues / ` +
      `${architecture.leagueAutomationIntervalMinutes}-minute sweep`,
  );
  console.log(
    `League scoring queue: taskQueue=${architecture.leagueAutomationTaskQueuePresent}, ` +
      `dispatcher=${architecture.leagueAutomationDispatcherPresent}, ` +
      `maxConcurrentDispatches=${architecture.leagueAutomationTaskMaxConcurrentDispatches}, ` +
      `maxPendingTasks=${architecture.leagueAutomationTaskMaxPendingTasks}, ` +
      `deterministicIds=${architecture.leagueAutomationTaskDeterministicIds}, ` +
      `defaultMode=${architecture.leagueAutomationQueueDefaultMode}`,
  );
  console.log(
    `Draft deadlines: taskQueue=${architecture.draftDeadlineTaskQueuePresent}, ` +
      `maxConcurrentDispatches=${architecture.draftDeadlineTaskMaxConcurrentDispatches}, ` +
      `deterministicIds=${architecture.draftDeadlineTaskDeterministicIds}`,
  );
  console.log(
    `Draft recovery: scan ${architecture.draftAutomationScanLimit} leagues, ` +
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
