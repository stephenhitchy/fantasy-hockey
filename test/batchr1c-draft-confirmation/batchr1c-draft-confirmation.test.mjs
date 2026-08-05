import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  draftPickMatchesPending,
  draftStateShowsPendingPickCommitted,
  mergeConfirmedDraftPick,
} from '../../src/app/features/draft/draft-room/draft-pick-confirmation.util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

const pending = {
  overallPick: 3,
  assetKey: 'player:8478402',
  ownerId: 'manager-a',
};

function pick(overrides = {}) {
  return {
    overallPick: 3,
    round: 1,
    pickInRound: 3,
    ownerId: 'manager-a',
    asset: { assetKey: 'player:8478402' },
    ...overrides,
  };
}

test('an exact pick can be confirmed from ownerId or selectedByUserId without accepting the wrong asset', () => {
  assert.equal(draftPickMatchesPending(pick(), pending), true);
  assert.equal(
    draftPickMatchesPending(
      pick({ ownerId: 'legacy-team-id', selectedByUserId: 'manager-a' }),
      pending,
    ),
    true,
  );
  assert.equal(
    draftPickMatchesPending(pick({ asset: { assetKey: 'player:wrong' } }), pending),
    false,
  );
  assert.equal(draftPickMatchesPending(pick({ overallPick: 4 }), pending), false);
});

test('the authoritative draft document independently proves a committed pick', () => {
  assert.equal(
    draftStateShowsPendingPickCommitted(
      {
        status: 'live',
        nextOverallPick: 4,
        draftedAssetKeys: ['player:8478402'],
        lastPickId: '003',
      },
      pending,
    ),
    true,
  );
  assert.equal(
    draftStateShowsPendingPickCommitted(
      {
        status: 'live',
        nextOverallPick: 3,
        draftedAssetKeys: ['player:8478402'],
        lastPickId: '003',
      },
      pending,
    ),
    false,
  );
  assert.equal(
    draftStateShowsPendingPickCommitted(
      {
        status: 'complete',
        nextOverallPick: 4,
        draftedAssetKeys: ['player:8478402'],
        lastPickId: '003',
      },
      pending,
    ),
    true,
  );
  assert.equal(
    draftStateShowsPendingPickCommitted(
      {
        status: 'live',
        nextOverallPick: 5,
        draftedAssetKeys: ['player:8478402'],
        lastPickId: '004',
      },
      pending,
    ),
    false,
    'a cumulative draftedAssetKeys match must not confirm the wrong overall pick',
  );
});

test('server-confirmed picks merge without duplicate overall selections', () => {
  const merged = mergeConfirmedDraftPick(
    [pick({ overallPick: 1, asset: { assetKey: 'player:first' } }), pick({ overallPick: 3 })],
    pick({ overallPick: 2, asset: { assetKey: 'player:second' } }),
  );

  assert.deepEqual(merged.map((entry) => entry.overallPick), [1, 2, 3]);
  assert.equal(
    mergeConfirmedDraftPick(merged, pick({ overallPick: 2, asset: { assetKey: 'player:new-second' } }))
      .filter((entry) => entry.overallPick === 2).length,
    1,
  );
});

test('Draft Room reconciles from both live listeners and direct server reads', async () => {
  const [room, service, authority] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/core/draft/draft.service.ts'),
    read('src/app/core/draft/draft-authority.service.ts'),
  ]);

  assert.match(room, /draftStateShowsPendingPickCommitted\(\s*this\.draft\(\),\s*pending/);
  assert.match(room, /getFantasyDraftFromServer\(this\.leagueId\)/);
  assert.match(room, /getDraftPickFromServer\(this\.leagueId, pending\.overallPick\)/);
  assert.match(room, /A mobile or browser transport can fail after Firestore committed/);
  assert.match(service, /getDocFromServer/);
  assert.match(service, /export async function getDraftPickFromServer/);
  assert.match(authority, /makeSecureDraftPick[")',\s\{[\s\S]*timeout:\s*65_000/);

  const watchdogIndex = room.indexOf('this.armPickSubmissionOverlayWatchdog(requestId);');
  const deadlineIndex = room.indexOf('this.armPendingPickConfirmationTimeout(requestId);');
  const callableIndex = room.indexOf('await makeDraftPick(this.leagueId, this.userId, asset);');
  assert.ok(watchdogIndex >= 0 && watchdogIndex < callableIndex);
  assert.ok(deadlineIndex >= 0 && deadlineIndex < callableIndex);
  assert.match(room, /68_000/);
  assert.match(room, /this\.pickSubmissionPhase\(\) !== 'idle'[\s\S]*previous pick/);
});

test('a delayed board sync never keeps the fuzzy full-screen shield indefinitely', async () => {
  const [room, template, styles, componentStyles] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/draft/draft-room/draft-room.html'),
    read('src/rinkrat-arena-phase3.css'),
    read('src/app/features/draft/draft-room/draft-room.css'),
  ]);

  assert.match(room, /armPickSubmissionOverlayWatchdog\(requestId\)/);
  assert.match(room, /this\.pickSubmissionOverlayVisible\.set\(false\);[\s\S]*8_000/);
  assert.match(template, /@if \(pickSubmissionOverlayVisible\(\)\)/);
  assert.match(template, /pickSubmissionPhase\(\) !== 'idle' && !pickSubmissionOverlayVisible\(\)/);
  assert.match(template, /Pick accepted — syncing the board/);
  assert.match(styles, /\.draft-pick-sync-dock/);
  assert.match(styles, /pointer-events:\s*auto/);
  assert.match(template, /Check Now/);
  assert.doesNotMatch(
    componentStyles.match(/\.draft-pick-submission-shield\s*\{[\s\S]*?\}/)?.[0] ?? '',
    /backdrop-filter/,
  );
});

test('navigation remains protected only while the secure pick submission is unresolved', async () => {
  const room = await read('src/app/features/draft/draft-room/draft-room.ts');

  assert.match(
    room,
    /canLeaveDraftRoom\(\): boolean \{[\s\S]*return this\.pickSubmissionPhase\(\) !== 'submitting';/,
  );
  assert.match(room, /successful callable response is authoritative:[\s\S]*transaction committed/);
});

test('Coach clipboard trigger and panel move to the left side on desktop and mobile', async () => {
  const styles = await read('src/app/shared/coach-help/coach-help.css');

  assert.match(styles, /\.coach-help-trigger \{[\s\S]*right:\s*auto;[\s\S]*left:\s*20px;/);
  assert.match(styles, /\.coach-help-backdrop \{[\s\S]*justify-content:\s*flex-start;/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*\.coach-help-trigger \{[\s\S]*left:\s*(?:10px|max\(10px,\s*env\(safe-area-inset-left\)\));/);
});

test('R1C verification and documentation are included', async () => {
  const [packageJson, docs] = await Promise.all([
    read('package.json'),
    read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
  ]);

  assert.match(packageJson, /"test:batchr1c:run"/);
  assert.match(packageJson, /"verify:batchr1c"/);
  assert.match(docs, /Batch R1C — Draft Pick Confirmation Recovery and Coach Placement/);
});
