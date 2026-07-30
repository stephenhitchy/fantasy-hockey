import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyDraftAssetToRoster,
  canUseAssetForBench,
  getDraftDestination,
  getDraftPickAtOverall,
  hasExactDraftOwnerSet,
  selectAutomaticDraftCandidate,
} = require('../../functions/lib/draft-pick-engine.js');

const STARTER_POSITIONS = [
  'LW', 'LW', 'LW',
  'C', 'C', 'C',
  'RW', 'RW', 'RW',
  'D', 'D', 'D', 'D',
  'G',
];

function emptyRoster() {
  const counts = new Map();

  return {
    schemaVersion: 2,
    activeSlots: STARTER_POSITIONS.map((position) => {
      const slotNumber = (counts.get(position) ?? 0) + 1;
      counts.set(position, slotNumber);
      return {
        slotId: `${position}-${slotNumber}`,
        position,
        slotNumber,
        asset: null,
        pendingMove: null,
        openFromCycleNumber: null,
      };
    }),
    benchSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `B-${index + 1}`,
      slotNumber: index + 1,
      asset: null,
    })),
    irSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `IR-${index + 1}`,
      slotNumber: index + 1,
      asset: null,
    })),
  };
}

function skater(assetKey, position, draftScore) {
  return {
    assetType: 'skater',
    assetKey,
    position,
    draftScore,
    player: {
      id: Number(assetKey.replace(/\D/g, '')) || 1,
      fullName: assetKey,
      firstName: assetKey,
      lastName: 'Fixture',
      position,
      currentTeamAbbreviation: 'MIN',
    },
  };
}

function goalie(assetKey, draftScore = 50) {
  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    draftScore,
    teamName: assetKey,
    teamAbbreviation: assetKey.slice(-3).toUpperCase(),
  };
}

function draft(order = ['a', 'b']) {
  return {
    schemaVersion: 3,
    status: 'live',
    format: 'snake',
    totalRounds: 17,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: order,
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null,
    pickSeconds: 60,
    clockStatus: 'running',
    pickStartedAt: new Date(),
    currentPickSeconds: 60,
    pausedRemainingSeconds: null,
  };
}

function fillAllStarters(roster) {
  let counter = 1;
  for (const slot of roster.activeSlots) {
    const asset = slot.position === 'G'
      ? goalie(`goalie-unit-fixture-${counter}`)
      : skater(`skater-${counter}`, slot.position, 10);
    slot.asset = {
      ...asset,
      rosterStatus: 'active',
      cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
    };
    counter += 1;
  }
  return roster;
}

describe('server draft pick engine', () => {
  test('calculates snake order across odd and even rounds', () => {
    const fixture = draft(['a', 'b', 'c']);

    assert.equal(getDraftPickAtOverall(fixture, 1).ownerId, 'a');
    assert.equal(getDraftPickAtOverall(fixture, 3).ownerId, 'c');
    assert.equal(getDraftPickAtOverall(fixture, 4).ownerId, 'c');
    assert.equal(getDraftPickAtOverall(fixture, 6).ownerId, 'a');
    assert.equal(getDraftPickAtOverall(fixture, 7).ownerId, 'a');
  });

  test('requires the live team documents to match the saved draft order', () => {
    const fixture = draft(['a', 'b', 'c']);

    assert.equal(hasExactDraftOwnerSet(fixture, ['c', 'a', 'b']), true);
    assert.equal(hasExactDraftOwnerSet(fixture, ['a', 'b']), false);
    assert.equal(hasExactDraftOwnerSet(fixture, ['a', 'b', 'c', 'd']), false);
    assert.equal(hasExactDraftOwnerSet({ ...fixture, roundOneOrder: ['a', 'a', 'b'] }, ['a', 'b']), false);
  });

  test('automatic selection fills an open starter before considering bench assets', () => {
    const roster = emptyRoster();
    const fixtureDraft = draft();
    const assets = [
      skater('skater-100', 'LW', 50),
      skater('skater-101', 'C', 90),
    ];
    const selection = selectAutomaticDraftCandidate({
      queue: {
        ownerId: 'a',
        assetKeys: ['skater-100'],
        autoDraftEnabled: true,
        consecutiveClockExpirations: 0,
        autoDraftActivatedByTimeout: false,
      },
      draft: fixtureDraft,
      roster,
      rostersByOwnerId: new Map([['a', roster], ['b', emptyRoster()]]),
      assets,
    });

    assert.equal(selection.asset.assetKey, 'skater-100');
    assert.equal(selection.selectionType, 'queue');
    assert.equal(getDraftDestination(roster, selection.asset.position).rosterArea, 'active');
  });

  test('automatic selection skips drafted queue entries and chooses the best legal asset', () => {
    const roster = emptyRoster();
    const fixtureDraft = draft();
    fixtureDraft.draftedAssetKeys = ['skater-200'];
    const selection = selectAutomaticDraftCandidate({
      queue: {
        ownerId: 'a',
        assetKeys: ['skater-200'],
        autoDraftEnabled: true,
        consecutiveClockExpirations: 0,
        autoDraftActivatedByTimeout: false,
      },
      draft: fixtureDraft,
      roster,
      rostersByOwnerId: new Map([['a', roster], ['b', emptyRoster()]]),
      assets: [
        skater('skater-200', 'LW', 999),
        skater('skater-201', 'LW', 50),
        skater('skater-202', 'LW', 75),
      ],
    });

    assert.equal(selection.asset.assetKey, 'skater-202');
    assert.equal(selection.selectionType, 'automatic');
  });

  test('automatic bench selections preserve forward, defense, and goalie role diversity', () => {
    const roster = fillAllStarters(emptyRoster());
    roster.benchSlots[0].asset = {
      ...skater('skater-300', 'LW', 40),
      rosterStatus: 'benched',
      cycleScore: { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 },
    };
    const fixtureDraft = draft();
    const selection = selectAutomaticDraftCandidate({
      queue: {
        ownerId: 'a',
        assetKeys: ['skater-301', 'skater-302'],
        autoDraftEnabled: true,
        consecutiveClockExpirations: 0,
        autoDraftActivatedByTimeout: false,
      },
      draft: fixtureDraft,
      roster,
      rostersByOwnerId: new Map([['a', roster], ['b', fillAllStarters(emptyRoster())]]),
      assets: [
        skater('skater-301', 'C', 95),
        skater('skater-302', 'D', 60),
        goalie('goalie-unit-303', 55),
      ],
    });

    assert.equal(selection.asset.assetKey, 'skater-302');
    assert.equal(selection.selectionType, 'queue');
  });

  test('bench selection cannot consume the last goalie needed for another starting slot', () => {
    const ownerRoster = fillAllStarters(emptyRoster());
    const otherRoster = fillAllStarters(emptyRoster());
    const otherGoalieSlot = otherRoster.activeSlots.find((slot) => slot.position === 'G');
    otherGoalieSlot.asset = null;
    const candidate = goalie('goalie-unit-last');
    const destination = getDraftDestination(ownerRoster, 'G');
    const fixtureDraft = draft();
    const rosters = new Map([['a', ownerRoster], ['b', otherRoster]]);

    assert.equal(destination.rosterArea, 'bench');
    assert.equal(
      canUseAssetForBench(candidate, destination, fixtureDraft, rosters, [candidate]),
      false,
    );
  });

  test('roster placement stores the authoritative asset in the correct slot', () => {
    const roster = emptyRoster();
    const canonical = skater('skater-500', 'D', 88);
    canonical.projectedCyclePoints = 44.25;
    const destination = getDraftDestination(roster, 'D');
    const updated = applyDraftAssetToRoster(roster, canonical, destination);
    const placed = updated.activeSlots.find((slot) => slot.slotId === destination.slotId).asset;

    assert.equal(placed.assetKey, 'skater-500');
    assert.equal(placed.projectedCyclePoints, 44.25);
    assert.equal(placed.rosterStatus, 'active');
    assert.deepEqual(placed.cycleScore, {
      cycleNumber: 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    });
    assert.equal(roster.activeSlots.find((slot) => slot.slotId === destination.slotId).asset, null);
  });
});
