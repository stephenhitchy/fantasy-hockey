import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function binary(relativePath) {
  return readFile(path.join(root, relativePath));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pngSize(value) {
  assert.deepEqual(
    [...value.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    'Expected a PNG signature.',
  );
  return {
    width: value.readUInt32BE(16),
    height: value.readUInt32BE(20),
  };
}

function pngColorType(value) {
  pngSize(value);
  return value[25];
}

async function walkTextFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTextFiles(relativePath)));
      continue;
    }
    if (/\.(?:css|html|js|json|ts)$/.test(entry.name)) files.push(relativePath);
  }
  return files;
}

test('Batch B1O preserves the three approved source artworks exactly', async () => {
  const expectedHashes = new Map([
    ['public/assets/branding/rinkrat-colored-mascot.png', '6c419a24929f11a76b8e0419ca8210b4fffda6076b99e754fcd54dc4648bb700'],
    ['public/assets/branding/rinkrat-full-logo.png', '9623a3079af2c053559c45c02179e6d33eea432c9036835ed8cb9f060ba8aa96'],
    ['public/assets/branding/rinkrat-minimalist-icon.png', '96243a15d81e344e078c6611f9d17fd2a63894d317c9448e4eaca7636dc8817f'],
  ]);

  for (const [relativePath, expectedHash] of expectedHashes) {
    assert.equal(sha256(await binary(relativePath)), expectedHash, relativePath);
  }
});

test('normal branding uses the colored mascot while authentication uses the horizontal logo', async () => {
  const navbar = await source('src/app/shared/navbar/navbar.html');
  const auth = await source('src/app/features/auth/auth.html');
  const dashboard = await source('src/app/features/dashboard/dashboard.html');
  const navbarStyles = await source('src/app/shared/navbar/navbar.css');
  const authStyles = await source('src/app/features/auth/auth.css');

  assert.equal((navbar.match(/rinkrat-colored-mascot-512\.png/g) ?? []).length, 2);
  assert.doesNotMatch(navbar, /rinkrat-full-logo/);
  assert.match(auth, /rinkrat-full-logo-1024\.png/);
  assert.doesNotMatch(dashboard, /rinkrat-full-logo/);
  assert.match(navbarStyles, /\.brand-mark-image\s*\{[\s\S]*?object-fit:\s*contain;/);
  assert.match(navbarStyles, /\.brand-mark-image\s*\{[\s\S]*?image-rendering:\s*auto;/);
  assert.match(authStyles, /\.auth-brand-logo\s*\{[\s\S]*?object-fit:\s*contain;/);
  assert.doesNotMatch(authStyles, /\.auth-brand-logo\s*\{[\s\S]*?filter:/);
});

test('favicons use the minimalist art and installed-app icons use padded colored artwork', async () => {
  const iconExpectations = new Map([
    ['public/favicon-32x32.png', { width: 32, height: 32 }],
    ['public/apple-touch-icon.png', { width: 180, height: 180 }],
    ['public/android-chrome-192x192.png', { width: 192, height: 192 }],
    ['public/android-chrome-512x512.png', { width: 512, height: 512 }],
  ]);

  for (const [relativePath, expectedSize] of iconExpectations) {
    assert.deepEqual(pngSize(await binary(relativePath)), expectedSize, relativePath);
  }

  for (const relativePath of [
    'public/assets/branding/rinkrat-favicon.png',
    'public/favicon-32x32.png',
  ]) {
    assert.equal(
      pngColorType(await binary(relativePath)),
      6,
      `${relativePath} must remain RGBA so the favicon background is transparent.`,
    );
  }

  const favicon = await binary('public/favicon.ico');
  assert.deepEqual([...favicon.subarray(0, 4)], [0, 0, 1, 0]);

  const manifest = JSON.parse(await source('public/site.webmanifest'));
  assert.deepEqual(
    manifest.icons.map((icon) => [icon.src, icon.sizes]),
    [
      ['/android-chrome-192x192.png', '192x192'],
      ['/android-chrome-512x512.png', '512x512'],
    ],
  );

  const index = await source('src/index.html');
  assert.match(index, /href="\/favicon-32x32\.png"/);
  assert.match(index, /href="\/apple-touch-icon\.png"/);
});

test('runtime source and the offline cache no longer reference the retired mascot', async () => {
  const retired = /rinkrat-(?:headshot|mascot-crop|mascot-full)\.png/;
  for (const directory of ['src', 'public']) {
    for (const relativePath of await walkTextFiles(directory)) {
      assert.doesNotMatch(await source(relativePath), retired, relativePath);
    }
  }

  for (const retiredPath of [
    'public/assets/branding/rinkrat-headshot.png',
    'public/assets/branding/rinkrat-mascot-crop.png',
    'public/assets/branding/rinkrat-mascot-full.png',
  ]) {
    await assert.rejects(stat(path.join(root, retiredPath)));
  }

  const worker = await source('public/rinkrat-sw.js');
  assert.match(worker, /rc65-brand-v2/);
  assert.match(worker, /rinkrat-colored-mascot-512\.png/);
  assert.match(worker, /rinkrat-full-logo-1024\.png/);
  assert.doesNotMatch(worker, /rinkrat-minimalist-icon\.png/);
});

test('the brand refresh stays in presentation and static-asset boundaries', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.match(packageJson.scripts['verify:batchb1o:core'], /verify:batchb1n:core/);
  assert.match(packageJson.scripts['test:batchb1o:run'], /batchb1o-brand-refresh/);

  const documentation = await source('docs/RINKRAT_PRODUCT_B1O_BRAND_REFRESH.md');
  assert.match(documentation, /Hosting-only/);
  assert.match(documentation, /Scoring V4/);
  assert.match(documentation, /Projection V11/);
  assert.match(documentation, /hosting:app/);
});
