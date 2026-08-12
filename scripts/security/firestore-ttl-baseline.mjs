import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const APPLY_CONFIRMATION = 'APPLY';
const gcloudCommand = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

function runGcloud(argumentsList) {
  const result = spawnSync(gcloudCommand, argumentsList, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error?.code === 'ENOENT') {
    throw new Error('gcloud is not installed or is not available on PATH. Install Google Cloud CLI or use Google Cloud Console → Firestore → Time-to-live.');
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || 'gcloud command failed').trim());
  }

  return (result.stdout || '').trim();
}

function parseResourceName(name) {
  if (typeof name !== 'string') {
    return { collectionGroup: '', field: '' };
  }

  const segments = name.split('/');
  const collectionIndex = segments.lastIndexOf('collectionGroups');
  const fieldIndex = segments.lastIndexOf('fields');

  return {
    collectionGroup: collectionIndex >= 0 ? decodeURIComponent(segments[collectionIndex + 1] ?? '') : '',
    field: fieldIndex >= 0 ? decodeURIComponent(segments[fieldIndex + 1] ?? '') : '',
  };
}

function normalizedTtlPolicies(rawPolicies) {
  if (!Array.isArray(rawPolicies)) {
    return [];
  }

  return rawPolicies.map((entry) => {
    const resource = parseResourceName(entry?.name);
    return {
      collectionGroup:
        typeof entry?.collectionGroup === 'string'
          ? entry.collectionGroup
          : resource.collectionGroup,
      field:
        typeof entry?.field === 'string'
          ? entry.field
          : resource.field,
      state:
        typeof entry?.ttlConfig?.state === 'string'
          ? entry.ttlConfig.state.toUpperCase()
          : typeof entry?.state === 'string'
            ? entry.state.toUpperCase()
            : 'UNKNOWN',
    };
  });
}

async function loadBaseline() {
  const configPath = path.resolve(process.cwd(), 'config/firestore-ttl-baseline.json');
  const baseline = JSON.parse(await readFile(configPath, 'utf8'));

  if (
    baseline?.schemaVersion !== 1 ||
    typeof baseline?.field !== 'string' ||
    !Array.isArray(baseline?.policies) ||
    baseline.policies.length === 0
  ) {
    throw new Error('config/firestore-ttl-baseline.json is missing the expected schema.');
  }

  return baseline;
}

function listPolicies(projectId, database) {
  const output = runGcloud([
    'firestore',
    'fields',
    'ttls',
    'list',
    `--project=${projectId}`,
    `--database=${database}`,
    '--format=json',
  ]);

  return normalizedTtlPolicies(output ? JSON.parse(output) : []);
}

function policyKey(collectionGroup, field) {
  return `${collectionGroup}/${field}`;
}

async function main() {
  const baseline = await loadBaseline();
  const projectId = argumentValue('project') || 'nhl-fantasy-app-ab673';
  const database = argumentValue('database') || baseline.database || '(default)';
  const apply = process.argv.includes('--apply');

  if (apply && process.env.RINKRAT_APPLY_TTL_SECURITY !== APPLY_CONFIRMATION) {
    throw new Error('TTL changes require RINKRAT_APPLY_TTL_SECURITY=APPLY. Inspection never mutates production.');
  }

  const currentPolicies = listPolicies(projectId, database);
  const currentByKey = new Map(
    currentPolicies.map((policy) => [policyKey(policy.collectionGroup, policy.field), policy]),
  );

  const missing = [];
  const pending = [];
  const active = [];

  for (const expected of baseline.policies) {
    const key = policyKey(expected.collectionGroup, baseline.field);
    const current = currentByKey.get(key);

    if (current?.state === 'ACTIVE') {
      active.push(expected);
    } else if (current?.state === 'CREATING') {
      pending.push(expected);
    } else {
      missing.push(expected);
    }
  }

  console.log(`Firestore TTL baseline for ${projectId} / ${database}:`);
  for (const expected of baseline.policies) {
    const current = currentByKey.get(policyKey(expected.collectionGroup, baseline.field));
    console.log(
      `- ${expected.collectionGroup}.${baseline.field}: ${current?.state ?? 'MISSING'} · ${expected.retention} · ${expected.reason}`,
    );
  }

  if (apply) {
    for (const expected of missing) {
      console.log(`Enabling TTL for ${expected.collectionGroup}.${baseline.field}…`);
      runGcloud([
        'firestore',
        'fields',
        'ttls',
        'update',
        baseline.field,
        `--collection-group=${expected.collectionGroup}`,
        `--database=${database}`,
        `--project=${projectId}`,
        '--enable-ttl',
        '--async',
        '--quiet',
      ]);
    }

    if (missing.length === 0) {
      console.log('No missing TTL policy needed to be created.');
    } else {
      console.log(`Started ${missing.length} TTL enablement operation(s). Run the inspection command again after Google Cloud reports ACTIVE.`);
    }
    return;
  }

  if (missing.length > 0 || pending.length > 0) {
    const summary = [
      missing.length > 0 ? `${missing.length} missing or unhealthy` : '',
      pending.length > 0 ? `${pending.length} still creating` : '',
    ].filter(Boolean).join('; ');
    console.error(`TTL baseline is not fully active: ${summary}.`);
    console.error('Apply with: RINKRAT_APPLY_TTL_SECURITY=APPLY npm run security:apply-ttl-baseline -- --project=nhl-fantasy-app-ab673');
    process.exitCode = 1;
    return;
  }

  console.log(`TTL baseline passed: ${active.length}/${baseline.policies.length} expected policies are ACTIVE.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
