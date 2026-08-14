#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const reportDirectory = path.join(projectRoot, '.security-reports');
const strict = process.argv.includes('--strict');
const reportOnly = process.argv.includes('--report-only');
const failLevels = new Set(['high', 'critical']);

function runAudit(label, cwd) {
  const result = spawnSync(
    'npm',
    ['audit', '--omit=dev', '--json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_fund: 'false',
        npm_config_audit_level: 'none',
      },
    },
  );

  const output = result.stdout?.trim() || result.stderr?.trim() || '';
  let parsed = null;

  try {
    parsed = output ? JSON.parse(output) : null;
  } catch {
    parsed = null;
  }

  const vulnerabilities = parsed?.metadata?.vulnerabilities ?? null;
  const unavailable = !parsed || !vulnerabilities;
  const high = Number(vulnerabilities?.high ?? 0);
  const critical = Number(vulnerabilities?.critical ?? 0);
  const moderate = Number(vulnerabilities?.moderate ?? 0);
  const low = Number(vulnerabilities?.low ?? 0);
  const total = Number(vulnerabilities?.total ?? high + critical + moderate + low);

  return {
    label,
    cwd: path.relative(projectRoot, cwd) || '.',
    commandExitCode: result.status,
    unavailable,
    vulnerabilities: { low, moderate, high, critical, total },
    raw: parsed,
    diagnostic: unavailable
      ? output.slice(0, 2_000)
      : '',
  };
}

const reports = [
  runAudit('Angular client', projectRoot),
  runAudit('Cloud Functions', path.join(projectRoot, 'functions')),
];

await mkdir(reportDirectory, { recursive: true });
await writeFile(
  path.join(reportDirectory, 'dependency-audit.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), strict, reportOnly, reports }, null, 2)}\n`,
  'utf8',
);

let failed = false;

for (const report of reports) {
  if (report.unavailable) {
    const message = `${report.label}: npm advisory data was unavailable.`;
    if (strict && !reportOnly) {
      console.error(message);
      failed = true;
    } else {
      console.warn(`${message} The local audit is advisory; CI uses strict mode.`);
    }
    continue;
  }

  const { low, moderate, high, critical, total } = report.vulnerabilities;
  console.log(
    `${report.label}: ${total} production vulnerability finding(s) ` +
    `(critical ${critical}, high ${high}, moderate ${moderate}, low ${low}).`,
  );

  if ([['high', high], ['critical', critical]].some(([level, count]) => (
    failLevels.has(String(level)) && Number(count) > 0
  ))) {
    if (!reportOnly) {
      failed = true;
    }
  }
}

if (failed) {
  console.error('Dependency security audit failed. Review .security-reports/dependency-audit.json.');
  process.exitCode = 1;
} else {
  console.log('Dependency security audit passed at the high/critical production threshold.');
}
