import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const NHL_LOGO_BASE_URL =
  process.env.RINKRAT_NHL_LOGO_BASE_URL ??
  'https://assets.nhle.com/logos/nhl/svg';
const NHL_RECORDS_LOGO_CATALOG_URL =
  process.env.RINKRAT_NHL_LOGO_CATALOG_URL ??
  ('https://records.nhl.com/site/api/franchise?' +
    [
      'include=teams.active',
      'include=teams.commonName',
      'include=teams.fullName',
      'include=teams.id',
      'include=teams.logos',
      'include=teams.triCode',
    ].join('&'));

const projectRoot = process.cwd();
const sourcePath = resolve(
  projectRoot,
  'src/app/shared/pixel-theme/pixel-theme.data.ts',
);
const outputDirectory = resolve(
  projectRoot,
  'public/assets/team-identity-logos',
);
const sourceManifestPath = resolve(outputDirectory, 'source-manifest.json');
const refreshRequested = process.argv.includes('--refresh');
const maxConcurrency = 4;

const source = await readFile(sourcePath, 'utf8');
const currentTeamFiles = [
  ...source.matchAll(/\bteam\('([A-Z]{3})',/g),
].map((match) => `${match[1]}_light.svg`);
const archivedFiles = [
  ...source.matchAll(/\barchivedLogo\('([^']+)'\)/g),
].map((match) => match[1]);
const customFiles = [
  ...source.matchAll(/\bcustomLogo\('([^']+)'\)/g),
].map((match) => `custom/${match[1]}`);
const requestedFiles = [...new Set([...currentTeamFiles, ...archivedFiles])].sort();

if (currentTeamFiles.length !== 32) {
  throw new Error(
    `Expected 32 current NHL teams in pixel-theme.data.ts, found ${currentTeamFiles.length}.`,
  );
}

await mkdir(outputDirectory, { recursive: true });

const missingCustomFiles = [];
for (const customFile of customFiles) {
  if (!(await isUsableImageFile(resolve(outputDirectory, customFile)))) {
    missingCustomFiles.push(customFile);
  }
}

if (missingCustomFiles.length > 0) {
  throw new Error(
    `Missing local custom team logo asset(s): ${missingCustomFiles.join(', ')}`,
  );
}

if (!refreshRequested && (await allAssetsExist(requestedFiles))) {
  console.log(
    `Team identity logo cache is ready (${requestedFiles.length} official SVG assets and ${customFiles.length} custom assets).`,
  );
  process.exit(0);
}

console.log(
  `Preparing ${requestedFiles.length} local team identity logos from official NHL assets...`,
);

let catalogEntries = null;
let catalogPromise = null;
const resolvedSources = [];
const failures = [];
let nextIndex = 0;

async function worker() {
  while (nextIndex < requestedFiles.length) {
    const currentIndex = nextIndex;
    nextIndex += 1;
    const requestedFile = requestedFiles[currentIndex];
    const destinationPath = resolve(outputDirectory, requestedFile);

    if (!refreshRequested && (await isUsableSvgFile(destinationPath))) {
      resolvedSources.push({
        requestedFile,
        sourceUrl: 'existing-local-asset',
        resolvedFileName: requestedFile,
        resolution: 'cached',
      });
      console.log(`✓ cached ${requestedFile}`);
      continue;
    }

    try {
      const result = await resolveAndDownloadLogo(requestedFile, destinationPath);
      resolvedSources.push(result);
      console.log(
        `✓ ${requestedFile}` +
          (result.resolution === 'exact'
            ? ''
            : ` ← ${result.resolvedFileName}`),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ requestedFile, error: message });
      console.error(`✗ ${requestedFile}: ${message}`);
    }
  }
}

await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));

if (failures.length > 0) {
  console.error(
    `\nUnable to prepare ${failures.length} team identity logo asset(s). ` +
      'The previous local copies, when present, were left untouched.',
  );
  process.exit(1);
}

resolvedSources.sort((first, second) =>
  first.requestedFile.localeCompare(second.requestedFile),
);

await writeFile(
  sourceManifestPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      catalogUrl: NHL_RECORDS_LOGO_CATALOG_URL,
      assetCount: resolvedSources.length,
      assets: resolvedSources,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(
  `\nSaved ${resolvedSources.length} local NHL identity logos to ` +
    'public/assets/team-identity-logos/.',
);

async function resolveAndDownloadLogo(requestedFile, destinationPath) {
  const exactUrl = `${NHL_LOGO_BASE_URL}/${encodeURIComponent(requestedFile)}`;
  const exactSvg = await tryFetchSvg(exactUrl);

  if (exactSvg) {
    await writeSvgAtomically(destinationPath, exactSvg);
    return {
      requestedFile,
      sourceUrl: exactUrl,
      resolvedFileName: requestedFile,
      resolution: 'exact',
    };
  }

  const officialCatalogEntries = await getOfficialLogoCatalog();

  const replacement = resolveClosestOfficialLogo(requestedFile, officialCatalogEntries);
  if (!replacement) {
    throw new Error('No matching logo was found in the NHL franchise logo catalog.');
  }

  const replacementSvg = await tryFetchSvg(replacement.secureUrl);
  if (!replacementSvg) {
    throw new Error(
      `The catalog replacement ${replacement.fileName} could not be downloaded.`,
    );
  }

  await writeSvgAtomically(destinationPath, replacementSvg);
  return {
    requestedFile,
    sourceUrl: replacement.secureUrl,
    resolvedFileName: replacement.fileName,
    resolution: 'catalog-fallback',
  };
}


async function getOfficialLogoCatalog() {
  if (catalogEntries) {
    return catalogEntries;
  }

  catalogPromise ??= loadOfficialLogoCatalog();
  catalogEntries = await catalogPromise;
  return catalogEntries;
}

async function loadOfficialLogoCatalog() {
  const response = await fetchWithRetries(NHL_RECORDS_LOGO_CATALOG_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RinkRat-Fantasy-Team-Logo-Sync/2.0',
    },
  });

  if (!response.ok) {
    throw new Error(`NHL logo catalog returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const entries = [];

  for (const franchise of payload?.data ?? []) {
    for (const team of franchise?.teams ?? []) {
      const triCode = String(team?.triCode ?? '').trim().toUpperCase();
      if (!triCode) {
        continue;
      }

      for (const logo of team?.logos ?? []) {
        const secureUrl = String(logo?.secureUrl ?? '').trim();
        if (!secureUrl) {
          continue;
        }

        entries.push({
          triCode,
          background: String(logo?.background ?? '').trim().toLowerCase(),
          startSeason: Number(logo?.startSeason ?? 0) || null,
          endSeason: Number(logo?.endSeason ?? 0) || null,
          secureUrl,
          fileName: basename(new URL(secureUrl).pathname),
        });
      }
    }
  }

  if (entries.length < 100) {
    throw new Error(
      `The NHL logo catalog returned only ${entries.length} usable entries.`,
    );
  }

  return entries;
}

function resolveClosestOfficialLogo(requestedFile, entries) {
  const exact = entries.find((entry) => entry.fileName === requestedFile);
  if (exact) {
    return exact;
  }

  const datedMatch = requestedFile.match(
    /^([A-Z]{2,3})_(\d{8})(?:-(\d{8}))?_(light|dark|alt)\.svg$/,
  );

  if (datedMatch) {
    const [, triCode, startSeasonText, endSeasonText, background] = datedMatch;
    const targetStart = seasonStartYear(Number(startSeasonText));
    const targetEnd = seasonStartYear(Number(endSeasonText ?? startSeasonText));
    const candidates = entries.filter(
      (entry) =>
        entry.triCode === triCode &&
        (entry.background === background ||
          (background === 'light' && entry.background === 'dark')),
    );

    return candidates
      .map((entry) => ({ entry, score: scoreDatedLogo(entry, targetStart, targetEnd, background) }))
      .sort((first, second) => first.score - second.score)[0]?.entry;
  }

  const namedMatch = requestedFile.match(/^([A-Z]{2,3})_.+_(light|dark|alt)\.svg$/);
  if (namedMatch) {
    const [, triCode, background] = namedMatch;
    const candidates = entries.filter((entry) => entry.triCode === triCode);
    return (
      candidates.find((entry) => entry.background === background) ??
      candidates.find((entry) => entry.background === 'alt') ??
      candidates.find((entry) => entry.background === 'light') ??
      candidates[0]
    );
  }

  const currentMatch = requestedFile.match(/^([A-Z]{2,3})_(light|dark|alt)\.svg$/);
  if (currentMatch) {
    const [, triCode, background] = currentMatch;
    const candidates = entries.filter((entry) => entry.triCode === triCode);
    return (
      candidates.find(
        (entry) => entry.background === background && !entry.endSeason,
      ) ??
      candidates
        .filter((entry) => entry.background === background)
        .sort((first, second) =>
          seasonStartYear(second.startSeason) - seasonStartYear(first.startSeason),
        )[0] ??
      candidates[0]
    );
  }

  return null;
}

function scoreDatedLogo(entry, targetStart, targetEnd, requestedBackground) {
  const entryStart = seasonStartYear(entry.startSeason);
  const entryEnd = seasonStartYear(entry.endSeason ?? entry.startSeason);
  const overlaps = entryStart <= targetEnd && entryEnd >= targetStart;
  let score = Math.abs(entryStart - targetStart) * 20 + Math.abs(entryEnd - targetEnd);

  if (entryStart === targetStart) {
    score -= 1000;
  }
  if (overlaps) {
    score -= 500;
  }
  if (entry.background === requestedBackground) {
    score -= 100;
  }

  return score;
}

function seasonStartYear(seasonId) {
  const text = String(seasonId ?? '');
  const year = Number.parseInt(text.slice(0, 4), 10);
  return Number.isFinite(year) ? year : 0;
}

async function tryFetchSvg(url) {
  try {
    const response = await fetchWithRetries(url, {
      headers: {
        Accept: 'image/svg+xml,image/*;q=0.9,*/*;q=0.8',
        'User-Agent': 'RinkRat-Fantasy-Team-Logo-Sync/2.0',
      },
    });

    if (!response.ok) {
      return null;
    }

    const content = await response.text();
    return isSvgContent(content) ? content : null;
  } catch {
    return null;
  }
}

async function fetchWithRetries(url, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });

      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(600 * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function writeSvgAtomically(destinationPath, content) {
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isSvgContent(content) {
  const beginning = content.trimStart().slice(0, 500).toLowerCase();
  return beginning.includes('<svg') && !beginning.includes('<html');
}


async function isUsableImageFile(filePath) {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size < 100) {
      return false;
    }

    const extension = filePath.toLowerCase().split('.').pop();
    if (extension === 'svg') {
      const content = await readFile(filePath, 'utf8');
      return isSvgContent(content);
    }

    if (extension === 'png') {
      const buffer = await readFile(filePath);
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );
    }

    return false;
  } catch {
    return false;
  }
}

async function allAssetsExist(fileNames) {
  const results = await Promise.all(
    fileNames.map((fileName) =>
      isUsableSvgFile(resolve(outputDirectory, fileName)),
    ),
  );
  return results.every(Boolean);
}

async function isUsableSvgFile(filePath) {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size < 100) {
      return false;
    }
    const content = await readFile(filePath, 'utf8');
    return isSvgContent(content);
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
