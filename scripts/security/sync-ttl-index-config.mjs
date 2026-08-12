#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stableJson, ttlFieldOverride } from './firestore-backup-restore.util.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ttlPath = path.join(projectRoot, 'config/firestore-ttl-baseline.json');
const indexesPath = path.join(projectRoot, 'firestore.indexes.json');

function overrideKey(entry) {
  return `${String(entry?.collectionGroup ?? '')}/${String(entry?.fieldPath ?? '')}`;
}

function canonicalIndexConfiguration(current, baseline) {
  const expectedKeys = new Set(
    baseline.policies.map((policy) => `${policy.collectionGroup}/${baseline.field}`),
  );
  const preserved = (Array.isArray(current?.fieldOverrides) ? current.fieldOverrides : [])
    .filter((entry) => !expectedKeys.has(overrideKey(entry)));
  const ttlOverrides = baseline.policies.map((policy) => (
    ttlFieldOverride(policy.collectionGroup, baseline.field)
  ));

  return {
    indexes: Array.isArray(current?.indexes) ? current.indexes : [],
    fieldOverrides: [...preserved, ...ttlOverrides],
  };
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const [baseline, current] = await Promise.all([
    readFile(ttlPath, 'utf8').then(JSON.parse),
    readFile(indexesPath, 'utf8').then(JSON.parse),
  ]);

  if (
    baseline?.schemaVersion !== 1 ||
    typeof baseline?.field !== 'string' ||
    !Array.isArray(baseline?.policies) ||
    baseline.policies.length === 0
  ) {
    throw new Error('config/firestore-ttl-baseline.json is missing the expected schema.');
  }

  const canonical = canonicalIndexConfiguration(current, baseline);
  const expectedSource = stableJson(canonical);
  const currentSource = stableJson(current);

  if (checkOnly) {
    if (currentSource !== expectedSource) {
      throw new Error('firestore.indexes.json does not mirror the source-controlled TTL baseline. Run npm run security:sync-ttl-index-config.');
    }
    console.log(`Firestore index configuration mirrors ${baseline.policies.length} TTL policies; future index deployments will preserve them.`);
    return;
  }

  if (currentSource === expectedSource) {
    console.log(`Firestore index configuration already mirrors ${baseline.policies.length} TTL policies.`);
    return;
  }

  await writeFile(indexesPath, expectedSource, 'utf8');
  console.log(`Updated firestore.indexes.json with ${baseline.policies.length} source-controlled TTL field override(s).`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
