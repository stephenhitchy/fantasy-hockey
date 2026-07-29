import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = resolve(
  process.cwd(),
  'src/app/shared/pixel-theme/pixel-theme.data.ts',
);
const assetDirectory = resolve(
  process.cwd(),
  'public/assets/team-identity-logos',
);
const source = await readFile(sourcePath, 'utf8');

const remoteArchiveHelper = /function archivedLogo\([^)]*\)[\s\S]*?assets\.nhle\.com/;
const remoteCurrentHelper = /function getNhlLogoUrl\([^)]*\)[\s\S]*?assets\.nhle\.com/;
if (remoteArchiveHelper.test(source) || remoteCurrentHelper.test(source)) {
  console.error('Team identity helpers still point directly at remote NHL logo URLs.');
  process.exit(1);
}

const currentTeamFiles = [
  ...source.matchAll(/\bteam\('([A-Z]{3})',/g),
].map((match) => `${match[1]}_light.svg`);
const archiveFiles = [
  ...source.matchAll(/\barchivedLogo\('([^']+)'\)/g),
].map((match) => match[1]);
const customFiles = [
  ...source.matchAll(/\bcustomLogo\('([^']+)'\)/g),
].map((match) => `custom/${match[1]}`);
const expectedFiles = [
  ...new Set([...currentTeamFiles, ...archiveFiles, ...customFiles]),
].sort();

if (currentTeamFiles.length !== 32) {
  console.error(`Expected 32 current NHL team entries, found ${currentTeamFiles.length}.`);
  process.exit(1);
}

const failures = [];
for (const fileName of expectedFiles) {
  const filePath = resolve(assetDirectory, fileName);
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size < 100) {
      failures.push(`${fileName}: missing or empty image file`);
      continue;
    }

    if (fileName.toLowerCase().endsWith('.svg')) {
      const content = await readFile(filePath, 'utf8');
      const beginning = content.trimStart().slice(0, 500).toLowerCase();
      if (!beginning.includes('<svg')) {
        failures.push(`${fileName}: invalid SVG content`);
        continue;
      }
    } else if (fileName.toLowerCase().endsWith('.png')) {
      const buffer = await readFile(filePath);
      if (
        buffer.length < 8 ||
        buffer[0] !== 0x89 ||
        buffer[1] !== 0x50 ||
        buffer[2] !== 0x4e ||
        buffer[3] !== 0x47
      ) {
        failures.push(`${fileName}: invalid PNG content`);
        continue;
      }
    } else {
      failures.push(`${fileName}: unsupported image format`);
      continue;
    }

    console.log(`✓ ${fileName}`);
  } catch (error) {
    failures.push(
      `${fileName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log(
  `\nChecked ${expectedFiles.length} local team identity logo assets ` +
    `(${currentTeamFiles.length} current crests, ${new Set(archiveFiles).size} archived SVG assets, and ${new Set(customFiles).size} custom alternate assets).`,
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`✗ ${failure}`);
  }
  console.error(
    '\nRun "npm run sync:team-identity-logos" while online, then validate again.',
  );
  process.exit(1);
}

console.log('All favorite-team identity logos are present as valid local image assets.');
