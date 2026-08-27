import {
  safeTagName,
  sha256,
  validateInviteBetaValidationReport,
} from './invite-beta-release.util.mjs';

export { safeTagName, sha256 };

function fullCommit(value) {
  return /^[0-9a-f]{40}$/i.test(String(value ?? '').trim());
}

function finiteInteger(value) {
  return Number.isInteger(value) ? value : 0;
}

function isoMilliseconds(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sameBuild(left, right) {
  if (!left || !right) {
    return false;
  }

  return [
    'releaseLabel',
    'buildId',
    'sourceRevision',
    'scoringRulesVersion',
    'projectionVersion',
  ].every((field) => left[field] === right[field]);
}

export function validatePreseasonCertificationReport(report, policy) {
  const issues = [];
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];

  if (report?.schemaVersion !== policy.preseasonCertificationSchemaVersion) {
    issues.push('The preseason certification report schema is unsupported.');
  }
  if (report?.ready !== true) {
    issues.push('The preseason scoring certification is not ready.');
  }
  if (!Number.isInteger(report?.scenarioCount) || report.scenarioCount <= 0) {
    issues.push('The preseason certification contains no scenarios.');
  }
  if (
    report?.passedScenarioCount !== report?.scenarioCount ||
    report?.failedScenarioCount !== 0
  ) {
    issues.push('Not every preseason scoring scenario passed.');
  }
  if (
    scenarios.length !== report?.scenarioCount ||
    scenarios.some((scenario) => scenario?.passed !== true)
  ) {
    issues.push('The preseason certification scenario detail is incomplete or contains a failure.');
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      scenarioCount: finiteInteger(report?.scenarioCount),
      passedScenarioCount: finiteInteger(report?.passedScenarioCount),
      failedScenarioCount: finiteInteger(report?.failedScenarioCount),
      generatedAt: String(report?.generatedAt ?? ''),
    },
  };
}

export function validateSeasonLaunchScoringEvidence(
  report,
  liveManifest,
  policy,
  nowMilliseconds = Date.now(),
) {
  const issues = [];
  const advisories = [];
  const generatedAtMilliseconds = isoMilliseconds(report?.generatedAt);
  const maximumEvidenceAgeMilliseconds =
    Number(policy.maximumEvidenceAgeMinutes) * 60 * 1000;
  const maximumHeartbeatAgeMilliseconds =
    Number(policy.maximumHeartbeatAgeMinutes) * 60 * 1000;
  const queue = report?.queue ?? {};
  const health = report?.health ?? {};
  const watchdog = report?.watchdog ?? {};
  const capacity = report?.capacity ?? {};
  const gate = report?.gate ?? {};

  if (report?.schemaVersion !== policy.scoringEvidenceSchemaVersion) {
    issues.push('The scoring evidence report schema is unsupported.');
  }
  if (report?.reportType !== 'rinkrat-season-launch-scoring-evidence') {
    issues.push('The file is not a RinkRat season-launch scoring evidence report.');
  }
  if (!sameBuild(report?.build, liveManifest)) {
    issues.push('The scoring evidence build does not match the deployed live release.');
  }
  if (!fullCommit(report?.build?.sourceRevision)) {
    issues.push('The scoring evidence does not contain one clean deployed source revision.');
  }
  if (gate?.readyForFreeze !== true || gate?.status !== 'ready') {
    issues.push('The scoring evidence gate is not ready for the exact-release freeze.');
  }
  if (Array.isArray(gate?.blockers) && gate.blockers.length > 0) {
    issues.push(`The scoring evidence still contains ${gate.blockers.length} blocker(s).`);
  }
  if (Array.isArray(gate?.advisories)) {
    advisories.push(...gate.advisories.map((value) => String(value)).slice(0, 20));
  }

  if (generatedAtMilliseconds === null) {
    issues.push('The scoring evidence generated time is invalid.');
  } else {
    if (generatedAtMilliseconds > nowMilliseconds + 30_000) {
      issues.push('The scoring evidence appears to come from the future.');
    }
    if (nowMilliseconds - generatedAtMilliseconds > maximumEvidenceAgeMilliseconds) {
      issues.push(`The scoring evidence is older than ${policy.maximumEvidenceAgeMinutes} minutes.`);
    }
  }

  if (queue.projectId !== policy.firebaseProjectId) {
    issues.push('The scoring evidence is from the wrong Firebase project.');
  }
  if (queue.environment !== 'production' || queue.production !== true) {
    issues.push('The scoring evidence was not generated from production.');
  }
  if (queue.mode !== policy.requiredQueueMode) {
    issues.push(`Queued scoring must be ${policy.requiredQueueMode} during the season freeze.`);
  }
  if (
    !Array.isArray(queue.canonicalAuthorityLeagueIds) ||
    queue.canonicalAuthorityLeagueIds.length !==
      policy.requiredCanonicalAuthorityLeagueCount
  ) {
    issues.push('Canonical scoring authority must be disabled during the season freeze.');
  }

  if (report?.seasonSafety?.status === 'blocked') {
    issues.push('The season scoring safety summary is blocked.');
  }
  if (
    Array.isArray(report?.seasonSafety?.alerts) &&
    report.seasonSafety.alerts.some((alert) => alert?.severity === 'critical')
  ) {
    issues.push('The season scoring safety summary contains a critical alert.');
  }

  if (!['observing', 'healthy'].includes(watchdog.status)) {
    issues.push(`The scoring watchdog status is ${watchdog.status ?? 'missing'}.`);
  }
  if (
    finiteInteger(watchdog.queueBlockingStreak) !== 0 ||
    finiteInteger(watchdog.canonicalBlockingStreak) !== 0
  ) {
    issues.push('The scoring watchdog still has an active blocker streak.');
  }
  if (
    finiteInteger(watchdog.consecutiveFailureCount) !== 0 ||
    String(watchdog.lastError ?? '').trim()
  ) {
    issues.push('The scoring watchdog has a recorded refresh failure.');
  }

  const watchdogAt = isoMilliseconds(watchdog.lastSuccessfulAt);
  const dispatcherAt = isoMilliseconds(health.dispatcherAt);
  if (generatedAtMilliseconds !== null) {
    if (
      watchdogAt === null ||
      generatedAtMilliseconds - watchdogAt > maximumHeartbeatAgeMilliseconds ||
      watchdogAt > generatedAtMilliseconds + 30_000
    ) {
      issues.push('The scoring watchdog heartbeat is missing or stale.');
    }
    if (
      dispatcherAt === null ||
      generatedAtMilliseconds - dispatcherAt > maximumHeartbeatAgeMilliseconds ||
      dispatcherAt > generatedAtMilliseconds + 30_000
    ) {
      issues.push('The scoring dispatcher heartbeat is missing or stale.');
    }
  }

  if (!['success', 'shadow', 'idle'].includes(String(health.dispatcherStatus))) {
    issues.push(`The scoring dispatcher status is ${health.dispatcherStatus ?? 'missing'}.`);
  }
  if (finiteInteger(health.activePendingTaskCount) !== 0) {
    issues.push('The scoring queue was not drained when the evidence was copied.');
  }
  if (finiteInteger(health.failedEnqueueCount) !== 0) {
    issues.push('The scoring evidence contains task enqueue failures.');
  }
  if (finiteInteger(health.staleRecoveryCount) !== 0) {
    issues.push('The scoring evidence contains stale-task recovery activity.');
  }
  if (
    finiteInteger(health.completedDraftLeagueCount) > 0 &&
    finiteInteger(health.scheduleCoverageCount) <
      finiteInteger(health.completedDraftLeagueCount)
  ) {
    issues.push('Not every completed-Draft league has a scoring schedule.');
  }

  if (capacity.status === 'error' || finiteInteger(capacity.consecutiveFailureCount) > 0) {
    issues.push('The measured-capacity evidence refresher is failing.');
  }
  if (capacity.evidenceLevel === 'insufficient') {
    advisories.push('Live capacity evidence is still limited; keep the initial season cohort capped.');
  }

  return {
    ok: issues.length === 0,
    issues,
    advisories: [...new Set(advisories)],
    summary: {
      generatedAt: String(report?.generatedAt ?? ''),
      queueMode: String(queue.mode ?? ''),
      queueRevision: finiteInteger(queue.revision),
      canaryLeagueCount: Array.isArray(queue.canaryLeagueIds)
        ? queue.canaryLeagueIds.length
        : 0,
      internalTestLeagueCount: Array.isArray(queue.internalTestLeagueIds)
        ? queue.internalTestLeagueIds.length
        : 0,
      canonicalAuthorityLeagueCount: Array.isArray(queue.canonicalAuthorityLeagueIds)
        ? queue.canonicalAuthorityLeagueIds.length
        : 0,
      watchdogStatus: String(watchdog.status ?? ''),
      capacityEvidenceLevel: String(capacity.evidenceLevel ?? ''),
      capacitySafeAffectedLeagueCount: finiteInteger(
        capacity.safeAffectedLeagueCapacity,
      ),
    },
  };
}

export function validatePrivateSeasonFreezeEvidence(
  report,
  liveManifest,
  policy,
  nowMilliseconds = Date.now(),
) {
  const issues = [];
  const advisories = [];
  const generatedAtMilliseconds = isoMilliseconds(report?.generatedAt);
  const maximumEvidenceAgeMilliseconds =
    Number(policy.maximumEvidenceAgeMinutes) * 60 * 1000;
  const gate = report?.gate ?? {};
  const season = report?.season ?? {};
  const support = report?.support ?? {};
  const cohort = report?.cohort ?? {};
  const decision = report?.decision ?? null;

  if (report?.schemaVersion !== policy.privateSeasonEvidenceSchemaVersion) {
    issues.push('The private-season evidence report schema is unsupported.');
  }
  if (report?.reportType !== 'rinkrat-private-season-freeze-evidence') {
    issues.push('The file is not a RinkRat private-season freeze evidence report.');
  }
  if (!sameBuild(report?.build, liveManifest)) {
    issues.push('The private-season evidence build does not match the deployed live release.');
  }
  if (gate?.readyForFreeze !== true || gate?.status !== 'ready') {
    issues.push('The private-season evidence gate is not ready.');
  }
  if (Array.isArray(gate?.blockers) && gate.blockers.length > 0) {
    issues.push(`The private-season evidence contains ${gate.blockers.length} blocker(s).`);
  }
  if (Array.isArray(gate?.advisories)) {
    advisories.push(...gate.advisories.map((value) => String(value)).slice(0, 20));
  }

  if (generatedAtMilliseconds === null) {
    issues.push('The private-season evidence generated time is invalid.');
  } else {
    if (generatedAtMilliseconds > nowMilliseconds + 30_000) {
      issues.push('The private-season evidence appears to come from the future.');
    }
    if (nowMilliseconds - generatedAtMilliseconds > maximumEvidenceAgeMilliseconds) {
      issues.push(`The private-season evidence is older than ${policy.maximumEvidenceAgeMinutes} minutes.`);
    }
  }

  if (season.seasonLabel !== policy.seasonLabel) {
    issues.push(`Expected private season ${policy.seasonLabel}.`);
  }
  if (!['approved', 'live'].includes(String(season.planStatus))) {
    issues.push('The private-season plan is not approved or live.');
  }
  if (
    season.featureFreezeConfirmed !== true ||
    season.approvedReleaseLabel !== liveManifest?.releaseLabel ||
    season.approvedBuildId !== liveManifest?.buildId
  ) {
    issues.push('The private-season feature freeze is not bound to the live build.');
  }
  if (!Number.isInteger(season.planRevision) || season.planRevision <= 0) {
    issues.push('The private-season plan revision is missing.');
  }
  if (!Array.isArray(season.nonGoals) || season.nonGoals.length === 0) {
    advisories.push('The private-season evidence contains no explicit non-goals.');
  }

  if (
    decision?.outcome !== 'approved' ||
    decision?.planRevision !== season.planRevision ||
    decision?.releaseLabel !== liveManifest?.releaseLabel ||
    decision?.buildId !== liveManifest?.buildId
  ) {
    issues.push('The formal private-season approval does not match the exact build and plan revision.');
  }

  if (
    support.primaryOwnerConfigured !== true ||
    support.deputyConfigured !== true ||
    support.supportChannelReady !== true ||
    support.knownIssuesReady !== true ||
    support.rollbackRehearsed !== true ||
    support.deputyConfirmed !== true ||
    support.coverageConfirmed !== true
  ) {
    issues.push('Private-season support, deputy, coverage, Known Issues, or rollback evidence is incomplete.');
  }

  if (
    !Number.isInteger(cohort.leagueCount) || cohort.leagueCount < 2 ||
    !Number.isInteger(cohort.testerCount) || cohort.testerCount < 10 ||
    !Number.isInteger(cohort.nonFounderCommissionerCount) ||
      cohort.nonFounderCommissionerCount < 1
  ) {
    issues.push('The private-season cohort does not meet the minimum approved scope.');
  }

  return {
    ok: issues.length === 0,
    issues,
    advisories: [...new Set(advisories)],
    summary: {
      generatedAt: String(report?.generatedAt ?? ''),
      seasonLabel: String(season.seasonLabel ?? ''),
      planRevision: finiteInteger(season.planRevision),
      planStatus: String(season.planStatus ?? ''),
      leagueCount: finiteInteger(cohort.leagueCount),
      testerCount: finiteInteger(cohort.testerCount),
      nonFounderCommissionerCount: finiteInteger(
        cohort.nonFounderCommissionerCount,
      ),
      decisionId: String(decision?.decisionId ?? ''),
    },
  };
}

export function validateSeasonFreezeEvidence(input) {
  const validation = validateInviteBetaValidationReport(
    input.validationReport,
    input.liveManifest,
  );
  const scoring = validateSeasonLaunchScoringEvidence(
    input.scoringEvidence,
    input.liveManifest,
    input.policy,
    input.nowMilliseconds,
  );
  const certification = validatePreseasonCertificationReport(
    input.preseasonCertification,
    input.policy,
  );
  const privateSeason = validatePrivateSeasonFreezeEvidence(
    input.privateSeasonEvidence,
    input.liveManifest,
    input.policy,
    input.nowMilliseconds,
  );

  return {
    ok: validation.ok && scoring.ok && certification.ok && privateSeason.ok,
    issues: [
      ...validation.issues,
      ...scoring.issues,
      ...certification.issues,
      ...privateSeason.issues,
    ],
    validation: validation.summary,
    scoring: scoring.summary,
    certification: certification.summary,
    privateSeason: privateSeason.summary,
    advisories: [...new Set([
      ...scoring.advisories,
      ...privateSeason.advisories,
    ])],
  };
}

export function functionSelector(deploymentPolicy) {
  const functions = Array.isArray(deploymentPolicy?.affectedFunctions)
    ? deploymentPolicy.affectedFunctions
    : [];
  if (functions.length === 0) {
    throw new Error('The season deployment policy contains no Functions.');
  }
  return functions.map((name) => `functions:${name}`).join(',');
}

export function formatSeasonRollbackPlan(record, deploymentPolicy) {
  const tag = safeTagName(record?.git?.tag ?? 'rinkrat-2026-private-season-baseline');
  const projectId = record?.firebase?.projectId ?? 'nhl-fantasy-app-ab673';
  const hostingTarget = record?.firebase?.hostingTarget ?? 'app';
  const verificationCommand = record?.verification?.command ?? 'npm run verify:batchd1j';
  const selector = functionSelector(deploymentPolicy);

  return `# RinkRat 2026–27 Private-Season Rollback Plan\n\n` +
    `**Frozen release:** ${record?.release?.releaseLabel ?? 'unknown'}\n\n` +
    `**Build ID:** \`${record?.release?.buildId ?? 'unknown'}\`\n\n` +
    `**Source commit:** \`${record?.release?.sourceRevision ?? 'unknown'}\`\n\n` +
    `**Git tag:** \`${tag}\`\n\n` +
    `## First actions\n\n` +
    `1. Stop new deployments and preserve logs, scoring evidence, and the incident timeline.\n` +
    `2. Return queued scoring to **Shadow** in Release Readiness when scoring, the NHL source, queue age, parity, or canonical authority may be involved.\n` +
    `3. Do not edit fantasy scores, six-game windows, Draft picks, transactions, standings, or playoff documents manually.\n` +
    `4. Classify the incident as Functions, Hosting, Rules/indexes, upstream NHL data, or stored-data specific.\n` +
    `5. Use the smallest rollback that restores safety.\n\n` +
    `## Exact frozen-source rollback\n\n` +
    '```bash\n' +
    `git checkout ${tag}\n` +
    `nvm use ${record?.toolchain?.node ?? '22.23.1'}\n` +
    `npm install -g npm@${record?.toolchain?.npm ?? '11.17.0'}\n` +
    `npm ci\n` +
    `npm --prefix functions ci\n` +
    `${verificationCommand}\n` +
    `npm run build:all\n` +
    `firebase use ${projectId}\n` +
    `firebase deploy --only "${selector}" --project ${projectId} -m "Rollback to frozen private-season Functions"\n` +
    `firebase deploy --only hosting:${hostingTarget} --project ${projectId} -m "Rollback to frozen private-season Hosting"\n` +
    `curl -fsSL ${record?.firebase?.publicUrl ?? 'https://rinkratfantasy.com'}/release-manifest.json | python3 -m json.tool\n` +
    '```\n\n' +
    `Deploy Firestore Rules or indexes only when the incident specifically involves them and the reviewed frozen files are the intended recovery. Never run a broad \`firebase deploy\` during an emergency.\n`;
}

export function formatSeasonIncidentGuide(record, deploymentPolicy) {
  const selector = functionSelector(deploymentPolicy);
  const projectId = record?.firebase?.projectId ?? 'nhl-fantasy-app-ab673';

  return `# RinkRat Incident Guide — First 15 Minutes\n\n` +
    `**Frozen build:** \`${record?.release?.buildId ?? 'unknown'}\`\n\n` +
    `## Minute 0–3: protect competitive truth\n\n` +
    `- Pause deployments and commissioner recovery experiments.\n` +
    `- Screenshot the Scoring Queue Control Center and copy current rollback configuration.\n` +
    `- Return the queue to Shadow when scoring may be involved.\n` +
    `- Record the first observed time, affected leagues, browsers, and NHL games.\n\n` +
    `## Minute 3–8: determine scope\n\n` +
    `- Check Service Status, known issues, watchdog status, queue backlog, retries, and canonical circuit state.\n` +
    `- Inspect the targeted scoring Functions rather than every unrelated Function.\n\n` +
    '```bash\n' +
    `for fn in ${deploymentPolicy.affectedFunctions.join(' ')}; do\n` +
    `  echo "===== $fn ====="\n` +
    `  firebase functions:log --only "$fn" --project ${projectId}\n` +
    `done\n` +
    '```\n\n' +
    `## Minute 8–15: choose the least-destructive recovery\n\n` +
    `- Canonical-only issue: leave the queue in Canary/direct fallback and disable canonical authority.\n` +
    `- Queue-wide issue: remain in Shadow and let idempotent tasks drain.\n` +
    `- Hosting-only issue: deploy frozen Hosting only.\n` +
    `- Functions issue: deploy only \`${selector}\` from the frozen tag.\n` +
    `- Rules/index issue: use the frozen Rules/index files only after confirming the incident is actually authorization or query related.\n\n` +
    `Never silently alter a score. Preserve the original result, correction source, explanation, and audit trail.\n`;
}

export function formatSeasonLaunchChecklist(record) {
  return `# RinkRat 2026–27 Private-Season Launch Checklist\n\n` +
    `## Exact release\n\n` +
    `- [ ] Live build ID is \`${record?.release?.buildId ?? 'unknown'}\`.\n` +
    `- [ ] Live source revision is \`${record?.release?.sourceRevision ?? 'unknown'}\`.\n` +
    `- [ ] Annotated Git tag points to the live source revision.\n` +
    `- [ ] GitHub Actions and \`${record?.verification?.command ?? 'npm run verify:batchd1j'}\` pass.\n` +
    `- [ ] Full-season simulator and every required manual browser workflow pass.\n` +
    `- [ ] All preseason certification scenarios pass.\n\n` +
    `## Scoring and data\n\n` +
    `- [ ] Production queue is Shadow at freeze time.\n` +
    `- [ ] Canonical authority is disabled at freeze time.\n` +
    `- [ ] Watchdog and dispatcher heartbeats are fresh.\n` +
    `- [ ] Queue is drained with no enqueue failure or stale recovery.\n` +
    `- [ ] Every completed-Draft league has a scoring schedule.\n` +
    `- [ ] Initial active-league cap is documented and capacity evidence is reviewed.\n\n` +
    `## People and recovery\n\n` +
    `- [ ] Private Season Control Center exact-build plan is approved.\n` +
    `- [ ] Primary support owner and deputy are confirmed.\n` +
    `- [ ] Known Issues and Service Status are ready.\n` +
    `- [ ] Rollback rehearsal uses the frozen tag and targeted selectors.\n` +
    `- [ ] No noncritical feature is added after the freeze.\n`;
}

export function buildSeasonKitFiles(record, deploymentPolicy) {
  return {
    'FREEZE_RECORD.json': `${JSON.stringify(record, null, 2)}\n`,
    'ROLLBACK.md': formatSeasonRollbackPlan(record, deploymentPolicy),
    'INCIDENT_FIRST_15_MINUTES.md': formatSeasonIncidentGuide(
      record,
      deploymentPolicy,
    ),
    'SEASON_LAUNCH_CHECKLIST.md': formatSeasonLaunchChecklist(record),
    'FIREBASE_FUNCTION_SELECTOR.txt': `${functionSelector(deploymentPolicy)}\n`,
  };
}
