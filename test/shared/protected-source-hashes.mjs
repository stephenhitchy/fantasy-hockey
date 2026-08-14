import { readFile } from 'node:fs/promises';

const fixtureUrl = new URL(
  '../batchs3c-ci-browser-retention/preserved-source-hashes.json',
  import.meta.url,
);

export const PROTECTED_SOURCE_HASHES = Object.freeze(
  JSON.parse(await readFile(fixtureUrl, 'utf8')),
);
