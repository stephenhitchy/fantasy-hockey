import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

describe('Batch 5 injury and profile authority contracts', () => {
  test('the shared injury report is server-write-only in Firestore rules', async () => {
    const rules = await read('firestore.rules');
    const match = rules.match(
      /match \/appData\/playerAvailability \{([\s\S]*?)\n    \}/,
    );

    assert.ok(match, 'Expected the global playerAvailability rule block.');
    assert.match(match[1], /allow read: if signedIn\(\);/);
    assert.match(match[1], /allow create, update, delete: if false;/);
  });

  test('private user documents are owner-readable while public profiles are display-safe', async () => {
    const rules = await read('firestore.rules');

    assert.match(
      rules,
      /match \/users\/\{userId\}[\s\S]*?allow get: if signedIn\(\) && userId == currentUserId\(\);/,
    );
    assert.match(rules, /match \/publicProfiles\/\{userId\}/);
    assert.match(rules, /data\.keys\(\)\.hasOnly\(\[[\s\S]*?'username'[\s\S]*?'favoriteTeamAbbreviation'[\s\S]*?'favoriteTeamVariantId'/);
    assert.doesNotMatch(
      rules.match(/match \/publicProfiles\/\{userId\} \{([\s\S]*?)\n    \}/)?.[1] ?? '',
      /'email'/,
    );
  });

  test('the browser requests injury refreshes through the callable and performs no global writes', async () => {
    const service = await read('src/app/core/player/player-availability-sync.service.ts');

    assert.match(service, /httpsCallable<[\s\S]*?'refreshDailyPlayerAvailability'/);
    assert.doesNotMatch(service, /runTransaction\s*\(/);
    assert.doesNotMatch(service, /setDoc\s*\(/);
    assert.doesNotMatch(service, /fetch\s*\(/);
  });

  test('matchup opponent themes use the safe league profile callable', async () => {
    const cycle = await read('src/app/features/cycles/cycle-one/cycle-one.ts');

    assert.match(cycle, /getPublicManagerProfilesForLeague/);
    assert.doesNotMatch(cycle, /getUserProfile\(ownerId\)/);
  });

  test('new registrations create a private profile and repairable public copy', async () => {
    const authService = await read('src/app/core/auth/auth.service.ts');

    assert.match(authService, /doc\(db, 'users', user\.uid\)/);
    assert.match(authService, /doc\(db, 'publicProfiles', user\.uid\)/);
    assert.match(authService, /public manager profile will be repaired after login/);
  });

  test('the backend exports server injury refresh and safe profile lookup callables', async () => {
    const functions = await read('functions/src/index.ts');

    assert.match(functions, /export const refreshDailyPlayerAvailability = onCall/);
    assert.match(functions, /export const getPublicManagerProfiles = onCall/);
    assert.match(functions, /verifyLeagueMembership\(leagueId, request\.auth\.uid\)/);
    assert.match(functions, /Manager identities may only be loaded for teams in this league/);
  });

  test('account deletion removes the public profile copy', async () => {
    const functions = await read('functions/src/index.ts');

    assert.match(functions, /const publicProfileRef = db\.doc\(`publicProfiles\/\$\{userId\}`\)/);
    assert.match(functions, /await publicProfileRef\.delete\(\)/);
  });
});
