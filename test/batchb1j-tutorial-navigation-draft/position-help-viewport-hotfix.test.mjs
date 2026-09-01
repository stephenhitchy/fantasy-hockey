import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const runNode = (args, options) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`node exited ${code}: ${stderr || stdout}`));
  });
});

test('position help portals to the viewport without locking the tutorial page', async () => {
  const [source, template, portal] = await Promise.all([
    read('src/app/shared/hockey-terms/hockey-term-chip.ts'),
    read('src/app/shared/hockey-terms/hockey-term-chip.html'),
    read('src/app/shared/accessibility/viewport-overlay-portal.directive.ts'),
  ]);

  assert.match(source, /imports:\s*\[ViewportOverlayPortalDirective\]/);
  assert.match(source, /this\.hostElement\.nativeElement\.contains\(target\) \|\| panel\?\.contains\(target\)/);
  assert.match(source, /capturePanelVariables\(\)/);
  assert.match(source, /applyPanelVariables\(panel\)/);
  assert.match(template, /#termPanel[\s\S]*appViewportOverlayPortal/);
  assert.match(template, /\[appViewportOverlayPortalLock\]="false"/);
  assert.match(portal, /@Input\(\) appViewportOverlayPortalLock = true/);
  assert.match(portal, /if \(this\.appViewportOverlayPortalLock\)/);
  assert.match(portal, /if \(this\.viewportLockHeld\)/);
});

test('the fixed position panel keeps desktop clamping and the mobile bottom sheet', async () => {
  const [source, styles] = await Promise.all([
    read('src/app/shared/hockey-terms/hockey-term-chip.ts'),
    read('src/app/shared/hockey-terms/hockey-term-chip.css'),
  ]);

  assert.match(source, /Math\.min\(320, viewportWidth - viewportMargin \* 2\)/);
  assert.match(source, /availableBelow/);
  assert.match(source, /availableAbove/);
  assert.match(styles, /\.hockey-term-popover\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*right:\s*12px;[\s\S]*left:\s*12px;/);
});


test('source-only release archives preserve the exact revision despite an unrelated CI commit', async () => {
  const root = new URL('../../', import.meta.url);
  const stage = await mkdtemp(join(tmpdir(), 'rinkrat-packaged-revision-'));
  const revision = '0123456789abcdef0123456789abcdef01234567';
  const unrelatedCiRevision = 'fedcba9876543210fedcba9876543210fedcba98';
  const files = [
    '.gitignore',
    'package.json',
    'scripts/generate-release-manifest.mjs',
    'scripts/release-manifest-gitignore.mjs',
    'src/environments/app-runtime.config.ts',
    'src/environments/app-runtime.config.production.ts',
    'src/app/core/scoring/scoring-rules.ts',
    'src/app/core/projection/projection-snapshot.service.ts',
  ];

  try {
    for (const relativePath of files) {
      const destination = join(stage, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(new URL(relativePath, root), destination);
    }
    await mkdir(join(stage, 'public'), { recursive: true });
    await writeFile(join(stage, '.rinkrat-source-revision'), `${revision}\n`, 'utf8');

    await runNode(['scripts/generate-release-manifest.mjs'], {
      cwd: stage,
      env: {
        ...process.env,
        GITHUB_SHA: unrelatedCiRevision,
      },
    });
    const manifest = JSON.parse(await readFile(join(stage, 'public/release-manifest.json'), 'utf8'));

    assert.equal(manifest.sourceRevision, revision);
    assert.notEqual(manifest.sourceRevision, unrelatedCiRevision);
    assert.notEqual(manifest.sourceRevision, 'unversioned');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
