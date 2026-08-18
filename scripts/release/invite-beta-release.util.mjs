import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeTagName(value) {
  const normalized = String(value ?? '').trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,80}$/.test(normalized) ||
    normalized.includes('..') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/')
  ) {
    throw new Error('Provide a safe Git tag through --tag=...');
  }
  return normalized;
}

export function tagSlug(value) {
  return safeTagName(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function fullCommit(value) {
  return /^[0-9a-f]{40}$/i.test(String(value ?? '').trim());
}

export function validateInviteBetaValidationReport(report, liveManifest) {
  const issues = [];
  const gate = report?.launchGate;
  const reportBuild = report?.build;

  if (report?.schemaVersion !== 2 || report?.reportType !== 'rinkrat-invite-beta-validation') {
    issues.push('The file is not a supported RinkRat invite-beta validation report.');
  }

  if (!gate || gate.status !== 'ready') {
    issues.push('The Release Readiness launch gate is not ready.');
  }
  if (Array.isArray(gate?.blockers) && gate.blockers.length > 0) {
    issues.push(`The report still contains ${gate.blockers.length} launch blocker(s).`);
  }
  if (
    !Number.isInteger(gate?.automatedRequiredCount) ||
    gate.automatedRequiredCount <= 0 ||
    gate.automatedPassedCount !== gate.automatedRequiredCount
  ) {
    issues.push('Not every required automated safeguard passed.');
  }
  if (
    !Number.isInteger(gate?.manualRequiredCount) ||
    gate.manualRequiredCount <= 0 ||
    gate.manualPassedCount !== gate.manualRequiredCount ||
    gate.manualAttentionCount !== 0 ||
    gate.manualUntestedCount !== 0
  ) {
    issues.push('Not every required manual validation workflow passed.');
  }
  if (gate?.simulationStatus !== 'passed' || report?.lifecycleSimulation?.passed !== true) {
    issues.push('The deterministic full-season simulator did not pass in this report.');
  }

  if (!reportBuild || !liveManifest) {
    issues.push('The report or live release manifest is missing build identity.');
  } else {
    for (const field of [
      'releaseLabel',
      'buildId',
      'sourceRevision',
      'scoringRulesVersion',
      'projectionVersion',
    ]) {
      if (reportBuild[field] !== liveManifest[field]) {
        issues.push(`The validation report ${field} does not match the live release.`);
      }
    }
  }

  if (!fullCommit(liveManifest?.sourceRevision)) {
    issues.push('The live release manifest does not contain one clean 40-character Git revision.');
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      gateStatus: gate?.status ?? 'missing',
      automatedPassedCount: Number(gate?.automatedPassedCount ?? 0),
      automatedRequiredCount: Number(gate?.automatedRequiredCount ?? 0),
      manualPassedCount: Number(gate?.manualPassedCount ?? 0),
      manualRequiredCount: Number(gate?.manualRequiredCount ?? 0),
      simulationStatus: gate?.simulationStatus ?? 'not-run',
    },
  };
}

export function formatRollbackPlan(record) {
  const tag = record?.git?.tag ?? 'rinkrat-rc41-invite-beta';
  const projectId = record?.firebase?.projectId ?? 'nhl-fantasy-app-ab673';
  const hostingTarget = record?.firebase?.hostingTarget ?? 'app';
  const releaseLabel = record?.release?.releaseLabel ?? 'Release Candidate 41';

  return `# RinkRat Invite-Beta Rollback Plan\n\n` +
    `**Frozen release:** ${releaseLabel}\n\n` +
    `**Build ID:** \`${record?.release?.buildId ?? 'unknown'}\`\n\n` +
    `**Deployed source commit:** \`${record?.release?.sourceRevision ?? 'unknown'}\`\n\n` +
    `**Git tag:** \`${tag}\`\n\n` +
    `**Firebase project:** \`${projectId}\`\n\n` +
    `## Default incident order\n\n` +
    `1. Stop adding new variables: preserve logs, action evidence, and the exact affected release.\n` +
    `2. Return queued league scoring to **Shadow** in Release Readiness when the incident could involve queued scoring.\n` +
    `3. Confirm whether the problem is Hosting-only, Functions, Firestore Rules, indexes, or data-specific.\n` +
    `4. Use the smallest rollback that restores safety. Routine application rollbacks normally deploy Functions first, then Hosting.\n` +
    `5. Deploy prior Firestore Rules or indexes only when the incident specifically involves those resources and the approved prior files were reviewed.\n` +
    `6. Refresh Release Readiness, verify the deployed manifest, and inspect Draft, scoring, roster, queue, App Check, and action health.\n\n` +
    `## Verified-source rollback commands\n\n` +
    '```bash\n' +
    `git checkout ${tag}\n` +
    `nvm use ${record?.toolchain?.node ?? '22.23.1'}\n` +
    `npm install -g npm@${record?.toolchain?.npm ?? '11.17.0'}\n` +
    `npm ci\n` +
    `npm --prefix functions ci\n` +
    `npm run verify:batchs3e\n` +
    `npm run build:all\n` +
    `firebase use ${projectId}\n` +
    `firebase deploy --only functions -m "Rollback to ${releaseLabel}"\n` +
    `firebase deploy --only hosting:${hostingTarget} -m "Rollback to ${releaseLabel}"\n` +
    '```\n\n' +
    `Do not use \`npm audit fix --force\` or a major package-manager update as part of an emergency rollback. Reproduce the frozen toolchain and lockfiles first.\n`;
}
