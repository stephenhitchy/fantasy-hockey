import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const logoIds = [
  'crossed-sticks',
  'rink-rat',
  'goalie-mask',
  'crown-puck',
  'arcade-net',
  'lightning-skate',
  'helmet-stars',
  'rink-badge',
];

const paletteIds = [
  'rink-gold',
  'ice-blue',
  'crimson',
  'emerald',
  'violet',
  'retro-orange',
  'neon-arcade',
  'silver',
];

const expectedSize = 256;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const failures = [];

for (const logoId of logoIds) {
  for (const paletteId of paletteIds) {
    const assetPath = resolve(
      'public',
      'assets',
      'league-logos',
      logoId,
      `${paletteId}.png`,
    );

    try {
      const file = await readFile(assetPath);

      if (file.length < 24 || !file.subarray(0, 8).equals(pngSignature)) {
        failures.push(`${assetPath}: not a valid PNG file`);
        continue;
      }

      const width = file.readUInt32BE(16);
      const height = file.readUInt32BE(20);

      if (width !== expectedSize || height !== expectedSize) {
        failures.push(
          `${assetPath}: expected ${expectedSize}x${expectedSize}, received ${width}x${height}`,
        );
      }
    } catch (error) {
      failures.push(
        `${assetPath}: ${error instanceof Error ? error.message : 'unable to read asset'}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('League logo validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Validated ${logoIds.length * paletteIds.length} league logo assets.`);
}
