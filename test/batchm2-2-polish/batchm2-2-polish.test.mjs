import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const read = (relativePath) => readFile(join(projectRoot, relativePath), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Batch M2.2 neutral manager profile authority', async (suite) => {
  const [authority, functionsIndex, clientAuthority, authService, userService] =
    await Promise.all([
      read('functions/src/manager-profile-authority.ts'),
      read('functions/src/index.ts'),
      read('src/app/core/user/manager-profile-authority.service.ts'),
      read('src/app/core/auth/auth.service.ts'),
      read('src/app/core/user/user.service.ts'),
    ]);

  await suite.test('accepts RR and validates all three profile-save actions on the server', () => {
    assert.match(authority, /SUPPORTED_TEAM_ABBREVIATIONS[\s\S]*?'RR'/);
    assert.match(authority, /action === 'initialize'/);
    assert.match(authority, /action === 'identity'/);
    assert.match(authority, /action === 'settings'/);
    assert.match(authority, /neutral RinkRat color scheme/);
  });

  await suite.test('writes private and public identity copies atomically with Admin SDK authority', () => {
    assert.match(authority, /db\.runTransaction/);
    assert.match(authority, /transaction\.set\(\s*userRef/);
    assert.match(authority, /transaction\.set\(\s*publicProfileRef/);
    assert.match(authority, /favoriteTeamAbbreviation/);
    assert.match(authority, /favoriteTeamVariantId/);
    assert.match(functionsIndex, /export \{ saveManagerProfile \} from '\.\/manager-profile-authority'/);
  });

  await suite.test('uses the callable for registration and both account identity save paths', () => {
    assert.match(clientAuthority, /functions, 'saveManagerProfile'/);
    assert.match(authService, /initializeManagerProfile\(/);
    assert.match(userService, /saveManagerIdentity\(/);
    assert.match(userService, /saveManagerAccountSettings\(/);

    const favoriteTeamUpdate = section(
      userService,
      'export async function updateFavoriteTeam(',
      'export async function updateTeamIdentityUnlocks(',
    );
    assert.doesNotMatch(favoriteTeamUpdate, /writeBatch|batch\.update|batch\.set/);
  });

  await suite.test('retains a staged-deployment fallback without retrying validation failures', () => {
    assert.match(authService, /functions\/not-found/);
    assert.match(authService, /functions\/unavailable/);
    assert.doesNotMatch(
      section(
        authService,
        'function shouldUseLegacyRegistrationWrite(',
        'export async function loginUser(',
      ),
      /permission-denied|invalid-argument/,
    );
  });

  await suite.test('keeps neutral rules compatible and documents a production rule refresh', async () => {
    const [rules, documentation] = await Promise.all([
      read('firestore.rules'),
      read('docs/RINKRAT_PROJECT_DOCUMENTATION.md'),
    ]);

    assert.match(rules, /favoriteTeamAbbreviation in \[[\s\S]*?'RR'/);
    assert.match(documentation, /firestore:rules -m "Batch M2\.2 neutral profile rule refresh"/);
    assert.match(documentation, /stale production ruleset/);
  });
});

test('Batch M2.2 Training Camp position identity and glossary containment', async (suite) => {
  const [trainingTemplate, trainingStyles, termSource, termTemplate, termStyles] =
    await Promise.all([
      read('src/app/features/onboarding/training-camp/training-camp.html'),
      read('src/app/features/onboarding/training-camp/training-camp.css'),
      read('src/app/shared/hockey-terms/hockey-term-chip.ts'),
      read('src/app/shared/hockey-terms/hockey-term-chip.html'),
      read('src/app/shared/hockey-terms/hockey-term-chip.css'),
    ]);

  await suite.test('matches starter slots to forward, defense, and goalie guide accents', () => {
    assert.equal((trainingTemplate.match(/class="roster-position-slot forward-slot"/g) ?? []).length, 3);
    assert.equal((trainingTemplate.match(/class="roster-position-slot defense-slot"/g) ?? []).length, 1);
    assert.equal((trainingTemplate.match(/class="roster-position-slot goalie-slot"/g) ?? []).length, 1);
    assert.match(trainingStyles, /--rr-forward-position-accent:\s*#efb04f/);
    assert.match(trainingStyles, /--rr-defense-position-accent:\s*#64c9db/);
    assert.match(trainingStyles, /--rr-goalie-position-accent:\s*#79a9ff/);
    assert.match(trainingStyles, /\.position-value-card\.forwards[\s\S]*var\(--rr-forward-position-accent\)/);
  });

  await suite.test('right-aligns the goalie definition so the lesson card cannot clip it', () => {
    assert.match(trainingTemplate, /term="team-goalie-unit"[\s\S]*popoverAlign="end"/);
    assert.match(termSource, /popoverAlign: 'start' \| 'center' \| 'end'/);
    assert.match(termTemplate, /\[class\.align-end\]="popoverAlign === 'end'"/);
    assert.match(termStyles, /\.hockey-term-popover\.align-end\s*\{[\s\S]*right:\s*0;[\s\S]*left:\s*auto;/);
    assert.match(termStyles, /\.hockey-term-popover\.align-center/);
  });
});

test('Batch M2.2 draft settings save protection', async (suite) => {
  const [routes, guard, component, template, styles] = await Promise.all([
    read('src/app/app.routes.ts'),
    read('src/app/core/guards/pending-draft-save.guard.ts'),
    read('src/app/features/draft/draft-setup/draft-setup.ts'),
    read('src/app/features/draft/draft-setup/draft-setup.html'),
    read('src/app/features/draft/draft-setup/draft-setup.css'),
  ]);

  await suite.test('blocks Angular navigation while the save promise is active', () => {
    assert.match(routes, /path: 'leagues\/:leagueId\/draft\/setup'[\s\S]*canDeactivate: \[pendingDraftSaveGuard\]/);
    assert.match(guard, /component\.canLeaveDraftSetup\(\)/);
    assert.match(component, /canLeaveDraftSetup\(\): boolean \{[\s\S]*return !this\.saving\(\)/);
    assert.match(component, /async saveDraftOrder\(\): Promise<void> \{[\s\S]*if \(this\.saving\(\)\) \{[\s\S]*return;/);
  });

  await suite.test('warns before refresh, tab close, or browser-level navigation', () => {
    assert.match(component, /@HostListener\('window:beforeunload'/);
    assert.match(component, /event\.preventDefault\(\)/);
    assert.match(component, /event\.returnValue = ''/);
  });

  await suite.test('keeps the page readable and releases the save state through authoritative confirmation', () => {
    assert.match(template, /@if \(saving\(\)\)/);
    assert.match(template, /class="draft-save-status-dock/);
    assert.doesNotMatch(template, /class="draft-save-lock"/);
    assert.match(template, /\[attr\.aria-busy\]="saving\(\)"/);
    assert.match(component, /awaitDraftSettingsConfirmation/);
    assert.match(component, /getFantasyDraftFromServer\(this\.leagueId\)/);
    assert.match(component, /Date\.now\(\) \+ 35_000/);
    assert.match(styles, /\.draft-save-status-dock\s*\{[\s\S]*position:\s*fixed;/);
    assert.doesNotMatch(styles, /\.draft-save-lock\s*\{/);
  });
});
