function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((first, second) =>
    first.localeCompare(second),
  );
}

export function collectExpectedFirebaseFunctionNames(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
    throw new Error('The Functions index source is empty.');
  }

  const names = [];

  for (const match of sourceText.matchAll(
    /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm,
  )) {
    names.push(match[1]);
  }

  for (const match of sourceText.matchAll(
    /^export\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]\s*;/gm,
  )) {
    const block = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    for (const rawEntry of block.split(',')) {
      const entry = rawEntry.trim().replace(/^type\s+/, '');
      if (!entry) {
        continue;
      }

      const aliasParts = entry.split(/\s+as\s+/);
      const exportedName = aliasParts[aliasParts.length - 1]?.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exportedName ?? '')) {
        names.push(exportedName);
      }
    }
  }

  const result = uniqueSorted(names);
  if (result.length === 0) {
    throw new Error('No exported Firebase Functions were found in functions/src/index.ts.');
  }
  return result;
}

function getRemoteEntries(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.result)) {
    return payload.result;
  }
  if (Array.isArray(payload?.functions)) {
    return payload.functions;
  }
  if (Array.isArray(payload?.result?.functions)) {
    return payload.result.functions;
  }
  return [];
}

function normalizePathFunctionName(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  const pathMatch = trimmed.match(/\/functions\/([^/]+)$/);
  if (pathMatch) {
    return pathMatch[1];
  }

  const locationQualifiedMatch = trimmed.match(/^[a-z0-9-]+\.([A-Za-z_$][\w$-]*)$/i);
  if (locationQualifiedMatch) {
    return locationQualifiedMatch[1];
  }

  return trimmed.split('/').pop() ?? null;
}

export function normalizeRemoteFirebaseFunction(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const record = entry;
  const candidates = [
    record.id,
    record.functionId,
    record.function,
    record.entryPoint,
    record.name,
  ];

  let name = null;
  for (const candidate of candidates) {
    name = normalizePathFunctionName(candidate);
    if (name) {
      break;
    }
  }

  if (!name) {
    return null;
  }

  let region = null;
  for (const candidate of [record.region, record.location]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      region = candidate.trim();
      break;
    }
  }

  if (!region && typeof record.name === 'string') {
    region = record.name.match(/\/locations\/([^/]+)\//)?.[1] ?? null;
  }

  const platform = typeof record.platform === 'string'
    ? record.platform
    : typeof record.generation === 'string'
      ? record.generation
      : null;

  return { name, region, platform };
}

export function buildFirebaseFunctionsDeploymentAudit({
  expectedNames,
  remotePayload,
  projectId,
  expectedRegion = 'us-central1',
  ignoredRemotePrefixes = ['ext-'],
}) {
  const expected = uniqueSorted(expectedNames);
  const normalizedRemote = getRemoteEntries(remotePayload)
    .map(normalizeRemoteFirebaseFunction)
    .filter(Boolean);

  const ignoredRemote = normalizedRemote.filter((entry) =>
    ignoredRemotePrefixes.some((prefix) => entry.name.startsWith(prefix)),
  );
  const deployedEntries = normalizedRemote.filter((entry) =>
    !ignoredRemote.includes(entry),
  );
  const deployed = uniqueSorted(deployedEntries.map((entry) => entry.name));

  const expectedSet = new Set(expected);
  const deployedSet = new Set(deployed);
  const missing = expected.filter((name) => !deployedSet.has(name));
  const unexpected = deployed.filter((name) => !expectedSet.has(name));
  const regionMismatches = deployedEntries
    .filter((entry) => expectedSet.has(entry.name))
    .filter((entry) => entry.region && entry.region !== expectedRegion)
    .map((entry) => ({
      name: entry.name,
      expectedRegion,
      deployedRegion: entry.region,
    }))
    .sort((first, second) => first.name.localeCompare(second.name));

  const duplicateRemoteNames = deployed
    .filter((name) => deployedEntries.filter((entry) => entry.name === name).length > 1);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectId,
    expectedRegion,
    expectedCount: expected.length,
    deployedCount: deployed.length,
    matchedCount: expected.filter((name) => deployedSet.has(name)).length,
    missing,
    unexpected,
    regionMismatches,
    duplicateRemoteNames: uniqueSorted(duplicateRemoteNames),
    ignoredRemoteFunctions: ignoredRemote
      .map((entry) => entry.name)
      .sort((first, second) => first.localeCompare(second)),
    ready:
      missing.length === 0 &&
      unexpected.length === 0 &&
      regionMismatches.length === 0 &&
      duplicateRemoteNames.length === 0,
  };
}

export function buildFirebaseFunctionDeploySelectors(names, batchSize = 10) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new Error('Function deployment batch size must be an integer from 1 through 20.');
  }

  const sorted = uniqueSorted(names);
  const selectors = [];
  for (let index = 0; index < sorted.length; index += batchSize) {
    selectors.push(
      sorted
        .slice(index, index + batchSize)
        .map((name) => `functions:${name}`)
        .join(','),
    );
  }
  return selectors;
}
