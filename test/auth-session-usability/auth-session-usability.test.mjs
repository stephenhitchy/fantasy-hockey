import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

async function readAllAppTemplates() {
  const appRoot = new URL('../../src/app/', import.meta.url);
  const entries = await readdir(appRoot, { recursive: true });
  const templatePaths = entries.filter((entry) => entry.endsWith('.html'));

  return Promise.all(
    templatePaths.map((templatePath) => readFile(new URL(templatePath, appRoot), 'utf8')),
  );
}

test('browser authentication retains the Firebase durable browser default', async () => {
  const source = await read('src/app/core/firebase-auth.ts');

  assert.match(source, /getAuth\(firebaseApp\)/);
  assert.doesNotMatch(source, /setPersistence|browserSessionPersistence|inMemoryPersistence/);
  assert.match(source, /prefers durable IndexedDB, then durable localStorage/);
});

test('every real password input keeps its binding and receives the shared reveal control', async () => {
  const templates = await readAllAppTemplates();
  const source = templates.join('\n');
  const passwordInputCount = (source.match(/type="password"/g) ?? []).length;
  const revealControlCount = (source.match(/<app-password-visibility-control/g) ?? []).length;

  assert.equal(passwordInputCount, 8);
  assert.equal(revealControlCount, passwordInputCount);
  assert.equal((source.match(/autocomplete="current-password"/g) ?? []).length, 7);
  assert.match(source, /\[attr\.autocomplete\]="passwordAutocomplete\(\)"/);

  for (const model of [
    'password',
    'verificationPassword',
    'deletePassword',
    'reopenPassword',
    'capacityPasswordDraft',
    'memberRemovalPasswordDraft',
    'deleteLeaguePasswordDraft',
  ]) {
    assert.match(source, new RegExp(`\\[\\(ngModel\\)\\]="${model}"`));
  }
});

test('the reveal control is non-submitting, accessible, and never persists password values', async () => {
  const source = await read(
    'src/app/shared/password-visibility-control/password-visibility-control.ts',
  );

  assert.match(source, /type="button"/);
  assert.match(source, /\[attr\.aria-controls\]="controlledInputId\(\)"/);
  assert.match(source, /\[attr\.aria-label\]="accessibleLabel\(\)"/);
  assert.match(source, /\[attr\.aria-pressed\]="revealed\(\)"/);
  assert.match(source, /nextRevealed \? 'text' : 'password'/);
  assert.doesNotMatch(source, /console\.|localStorage|sessionStorage/);
});
