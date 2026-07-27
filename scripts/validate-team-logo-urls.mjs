import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = resolve(
  process.cwd(),
  'src/app/shared/pixel-theme/pixel-theme.data.ts',
);
const source = await readFile(sourcePath, 'utf8');

const forbiddenHelpers = ['historicalLogo(', 'alternateLogo(', 'commonsFile('];
const staleHelper = forbiddenHelpers.find((helper) => source.includes(helper));
if (staleHelper) {
  console.error(`Unsupported guessed logo helper is still present: ${staleHelper}`);
  process.exit(1);
}

const teamAbbreviations = [
  ...source.matchAll(/\bteam\('([A-Z]{3})',/g),
].map((match) => match[1]);
const archiveFiles = [
  ...source.matchAll(/\barchivedLogo\('([^']+)'\)/g),
].map((match) => match[1]);

if (teamAbbreviations.length !== 32) {
  console.error(`Expected 32 current NHL team entries, found ${teamAbbreviations.length}.`);
  process.exit(1);
}

const baseUrl = 'https://assets.nhle.com/logos/nhl/svg';
const urls = [
  ...teamAbbreviations.map((abbreviation) => `${baseUrl}/${abbreviation}_light.svg`),
  ...archiveFiles.map((fileName) => `${baseUrl}/${fileName}`),
];
const uniqueUrls = [...new Set(urls)].sort();

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function verifyUrl(url) {
  let lastError = 'Unknown request failure';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'image/svg+xml,image/*;q=0.9,*/*;q=0.8',
          Range: 'bytes=0-0',
          'User-Agent': 'RinkRat-Fantasy-Team-Logo-Validator/1.0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      await response.body?.cancel();

      if (response.ok || response.status === 206) {
        return null;
      }

      lastError = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) {
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500 * attempt);
  }

  return { url, error: lastError };
}

const failures = [];
const concurrency = 6;
let nextIndex = 0;

async function worker() {
  while (nextIndex < uniqueUrls.length) {
    const index = nextIndex;
    nextIndex += 1;
    const url = uniqueUrls[index];
    const result = await verifyUrl(url);

    if (result) {
      failures.push(result);
      console.error(`✗ ${result.error} ${url}`);
    } else {
      console.log(`✓ ${url}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

console.log(
  `\nChecked ${uniqueUrls.length} unique logo URLs ` +
    `(${teamAbbreviations.length} current team crests and ${new Set(archiveFiles).size} archived/secondary assets).`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} logo URL(s) failed validation.`);
  process.exit(1);
}

console.log('All team identity logo URLs are reachable.');
