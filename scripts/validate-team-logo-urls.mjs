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
const expectedFiles = [...new Set([...currentTeamFiles, ...archiveFiles])].sort();

if (currentTeamFiles.length !== 32) {
  console.error(`Expected 32 current NHL team entries, found ${currentTeamFiles.length}.`);
  process.exit(1);
}

const failures = [];
for (const fileName of expectedFiles) {
  const filePath = resolve(assetDirectory, fileName);
  try {
    const fileStats = await stat(filePath);
    const content = await readFile(filePath, 'utf8');
    const beginning = content.trimStart().slice(0, 500).toLowerCase();

    if (!fileStats.isFile() || fileStats.size < 100 || !beginning.includes('<svg')) {
      failures.push(`${fileName}: missing or invalid SVG content`);
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
    `(${currentTeamFiles.length} current crests and ${new Set(archiveFiles).size} archived/secondary assets).`,
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

console.log('All favorite-team identity logos are present as local SVG assets.');
