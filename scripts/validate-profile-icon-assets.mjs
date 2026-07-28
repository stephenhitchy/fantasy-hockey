import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const profileIconRoot = resolve('public', 'assets', 'profile-icons');
const expectedAssetCount = 35;
const minimumBytes = 15_000;
const maximumBytes = 250_000;
const failures = [];

async function collectWebpAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...(await collectWebpAssets(entryPath)));
    } else if (extname(entry.name).toLowerCase() === '.webp') {
      assets.push(entryPath);
    }
  }

  return assets;
}

const assets = await collectWebpAssets(profileIconRoot);

if (assets.length !== expectedAssetCount) {
  failures.push(
    `Expected ${expectedAssetCount} profile icon assets, found ${assets.length}.`,
  );
}

for (const assetPath of assets) {
  try {
    const file = await readFile(assetPath);
    const isWebp =
      file.length >= 12 &&
      file.subarray(0, 4).toString('ascii') === 'RIFF' &&
      file.subarray(8, 12).toString('ascii') === 'WEBP';

    if (!isWebp) {
      failures.push(`${relative(process.cwd(), assetPath)}: not a valid WebP file`);
      continue;
    }

    if (file.length < minimumBytes) {
      failures.push(
        `${relative(process.cwd(), assetPath)}: unexpectedly small (${file.length} bytes)`,
      );
    }

    if (file.length > maximumBytes) {
      failures.push(
        `${relative(process.cwd(), assetPath)}: too large for a profile icon (${file.length} bytes)`,
      );
    }
  } catch (error) {
    failures.push(
      `${relative(process.cwd(), assetPath)}: ${
        error instanceof Error ? error.message : 'unable to read asset'
      }`,
    );
  }
}

if (failures.length > 0) {
  console.error('Profile icon validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Validated ${assets.length} categorized RinkRat profile icon assets.`);
}
