import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('project root contains no loose update text files or batch checklist files', async () => {
  const entries = await readdir(root, { withFileTypes: true });
  const competitiveRoadmapPattern = /^RINKRAT_COMPETITIVE_ROADMAP(?:_.*)?\.txt$/i;
  const looseFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        (
          name.endsWith('.txt') ||
          /^BATCH_.*_MANUAL_TEST_CHECKLIST\.md$/i.test(name)
        ) &&
        !competitiveRoadmapPattern.test(name),
    );

  assert.deepEqual(looseFiles, []);
  assert.equal(await exists('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'), true);
});


test('root and canonical competitive roadmaps stay synchronized', async () => {
  assert.equal(await exists('RINKRAT_COMPETITIVE_ROADMAP.txt'), true);
  assert.equal(await exists('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'), true);

  const [rootRoadmap, canonicalRoadmap] = await Promise.all([
    readFile(path.join(root, 'RINKRAT_COMPETITIVE_ROADMAP.txt'), 'utf8'),
    readFile(path.join(root, 'docs/RINKRAT_COMPETITIVE_ROADMAP.txt'), 'utf8'),
  ]);

  assert.equal(rootRoadmap, canonicalRoadmap);
});

test('FF1 keeps invitation authorization separate from Draft authorization', async () => {
  const [runbook, handoff, roadmap] = await Promise.all([
    readFile(path.join(root, 'docs/RINKRAT_FF1_INVITATION_GATE_RUNBOOK.md'), 'utf8'),
    readFile(path.join(root, 'docs/RINKRAT_CODEX_HANDOFF.md'), 'utf8'),
    readFile(path.join(root, 'docs/RINKRAT_COMPETITIVE_ROADMAP.txt'), 'utf8'),
  ]);

  assert.match(runbook, /Passing this gate authorizes invitations only/i);
  assert.match(runbook, /Stephen performs all\s+Production account, league, membership/i);
  assert.match(runbook, /Production Hosting source: 1754f807/);
  assert.match(runbook, /Repository review source: <current clean main revision>/);
  assert.match(runbook, /Only documentation and test paths may appear/i);
  assert.match(runbook, /Do not deploy a documentation-only commit/i);
  assert.match(runbook, /Do not schedule or open a Draft in the reusable invitation\/removal league/i);
  assert.match(runbook, /INV-01 through INV-18 are PASS/i);
  assert.match(runbook, /never use a broad Firebase deployment/i);
  assert.match(handoff, /RINKRAT_FF1_INVITATION_GATE_RUNBOOK\.md/);
  assert.match(roadmap, /# \[x\] FF1\.13[\s\S]*1754f807/);
  assert.match(roadmap, /\[ \] FF1\.9 Authorize real Drafts only after/i);
});

test('combined documentation and root README are present', async () => {
  assert.equal(await exists('docs/RINKRAT_PROJECT_DOCUMENTATION.md'), true);
  assert.equal(await exists('docs/RINKRAT_CODEBASE_GUIDE.md'), true);
  assert.equal(await exists('README.md'), true);

  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /docs\/RINKRAT_CODEBASE_GUIDE\.md/);
  assert.match(readme, /docs\/RINKRAT_PROJECT_DOCUMENTATION\.md/);
});

test('current architecture guide preserves authority and competitive boundaries', async () => {
  const [guide, agents, handoff, projectDocumentation] = await Promise.all([
    readFile(path.join(root, 'docs/RINKRAT_CODEBASE_GUIDE.md'), 'utf8'),
    readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    readFile(path.join(root, 'docs/RINKRAT_CODEX_HANDOFF.md'), 'utf8'),
    readFile(path.join(root, 'docs/RINKRAT_PROJECT_DOCUMENTATION.md'), 'utf8'),
  ]);

  assert.match(guide, /## Protected competitive contracts/);
  assert.match(guide, /Production Scoring V4/);
  assert.match(guide, /Projection V11/);
  assert.match(guide, /seventh eligible NHL game belongs to that slot's next fantasy matchup/i);
  assert.match(guide, /server-authoritative/i);
  assert.match(guide, /Route guards and client-side validation are defense-in-depth/i);
  assert.match(guide, /## Commenting standard/);
  assert.match(guide, /## How to trace an unfamiliar behavior/);
  assert.match(guide, /Codex prepares and reports deployment selectors but does not deploy/i);

  for (const source of [agents, handoff, projectDocumentation]) {
    assert.match(source, /docs\/RINKRAT_CODEBASE_GUIDE\.md/);
  }
});

test('architectural entry points explain browser and server responsibilities', async () => {
  const [routes, authGuard, draftAuthority, rosterAuthority, projectionSnapshots] =
    await Promise.all([
      readFile(path.join(root, 'src/app/app.routes.ts'), 'utf8'),
      readFile(path.join(root, 'src/app/core/guards/auth.guard.ts'), 'utf8'),
      readFile(path.join(root, 'src/app/core/draft/draft-authority.service.ts'), 'utf8'),
      readFile(path.join(root, 'src/app/core/transactions/roster-authority.service.ts'), 'utf8'),
      readFile(path.join(root, 'src/app/core/projection/projection-snapshot.service.ts'), 'utf8'),
    ]);

  assert.match(routes, /Firestore\s+\* Rules and Cloud Functions remain authoritative/s);
  assert.match(
    authGuard,
    /navigation UX; Firebase Auth, Rules, and server checks remain authoritative/,
  );
  assert.match(draftAuthority, /server-authoritative Draft commands/);
  assert.match(rosterAuthority, /server-authoritative roster, waiver, bench, and IR/);
  assert.match(
    projectionSnapshots,
    /must not invent\s+\* a competitive fallback projection in the browser/s,
  );
});

test('documentation consolidation command remains available', async () => {
  assert.equal(await exists('scripts/consolidate-project-docs.mjs'), true);

  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts?.['docs:consolidate'],
    'node scripts/consolidate-project-docs.mjs',
  );
});
