import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const read = (relativePath) => readFile(join(projectRoot, relativePath), 'utf8');

async function loadTypescript() {
  const localRequire = createRequire(join(projectRoot, 'package.json'));

  try {
    return localRequire('typescript');
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
    }).trim();
    return createRequire(join(globalRoot, 'package.json'))('typescript');
  }
}

async function loadStandaloneTypescriptModule(relativePath) {
  const typescript = await loadTypescript();
  const sourcePath = join(projectRoot, relativePath);
  const source = await readFile(sourcePath, 'utf8');
  const result = typescript.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
  );

  assert.deepEqual(
    errors.map((diagnostic) =>
      typescript.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    ),
    [],
  );

  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-beginner-onboarding-'));
  const outputPath = join(directory, 'module.mjs');
  await writeFile(outputPath, result.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Batch M2 neutral RinkRat identity behavior', async (suite) => {
  const theme = await loadStandaloneTypescriptModule(
    'src/app/shared/pixel-theme/pixel-theme.data.ts',
  );

  await suite.test('uses RR as the safe no-favorite identity', () => {
    assert.equal(theme.RINKRAT_NEUTRAL_ABBREVIATION, 'RR');
    assert.equal(theme.RINKRAT_NEUTRAL_THEME.abbreviation, 'RR');
    assert.equal(theme.getPixelTeamTheme(null).abbreviation, 'RR');
    assert.equal(theme.getPixelTeamTheme('UNKNOWN').abbreviation, 'RR');
    assert.equal(
      theme.getNhlLogoUrl('RR'),
      '/assets/branding/rinkrat-headshot.png',
    );
  });

  await suite.test('offers neutral colors without adding RR to the NHL ribbon', () => {
    assert.equal(theme.USER_SELECTABLE_PIXEL_THEMES[0].abbreviation, 'RR');
    assert.equal(
      theme.NHL_PIXEL_TEAMS.some((team) => team.abbreviation === 'RR'),
      false,
    );
    assert.equal(
      theme.buildFullPixelMarquee().some((item) => item.abbreviation === 'RR'),
      false,
    );
  });
});

test('Batch M2 hockey familiarity and glossary behavior', async (suite) => {
  const terms = await loadStandaloneTypescriptModule(
    'src/app/shared/hockey-terms/hockey-terms.data.ts',
  );

  await suite.test('normalizes the three supported familiarity levels', () => {
    assert.equal(terms.normalizeHockeyExperienceLevel('new'), 'new');
    assert.equal(terms.normalizeHockeyExperienceLevel('basic'), 'basic');
    assert.equal(terms.normalizeHockeyExperienceLevel('experienced'), 'experienced');
    assert.equal(terms.normalizeHockeyExperienceLevel('invalid'), 'basic');
  });

  await suite.test('expands terms for new fans and keeps compact labels available', () => {
    assert.equal(
      terms.getHockeyTermDisplayLabel('left-wing', 'new'),
      'Left Wing (LW)',
    );
    assert.equal(terms.getHockeyTermDisplayLabel('left-wing', 'basic'), 'LW');
    assert.equal(
      terms.getHockeyTermDisplayLabel('save-percentage', 'new', true),
      'SV%',
    );
  });

  await suite.test('contains every launch glossary term', () => {
    const abbreviations = new Set(
      terms.HOCKEY_GLOSSARY_TERMS.map((term) => term.abbreviation),
    );

    for (const abbreviation of [
      'LW',
      'C',
      'RW',
      'D',
      'G',
      'SOG',
      'BLK',
      'PPP',
      'SHP',
      'SV%',
      'TOI',
      'GWG',
      'IR',
      'Pts/Game',
    ]) {
      assert.equal(abbreviations.has(abbreviation), true, `${abbreviation} is missing`);
    }
  });

  await suite.test('stores the preference for both UI state and later sessions', () => {
    const values = new Map();
    const previousLocalStorage = globalThis.localStorage;
    const previousDocument = globalThis.document;

    globalThis.localStorage = {
      getItem(key) {
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
    };
    globalThis.document = { documentElement: { dataset: {} } };

    try {
      assert.equal(terms.storeHockeyExperienceLevel('new'), 'new');
      assert.equal(terms.loadStoredHockeyExperienceLevel(), 'new');
      assert.equal(globalThis.document.documentElement.dataset.hockeyExperience, 'new');
    } finally {
      if (previousLocalStorage === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = previousLocalStorage;
      }

      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
    }
  });
});

test('Batch M2 registration and account-setting contracts', async (suite) => {
  const [
    authSource,
    authTemplate,
    authService,
    accountSource,
    accountTemplate,
    userService,
    userThemeService,
  ] = await Promise.all([
    read('src/app/features/auth/auth.ts'),
    read('src/app/features/auth/auth.html'),
    read('src/app/core/auth/auth.service.ts'),
    read('src/app/features/account/account-settings/account-settings.ts'),
    read('src/app/features/account/account-settings/account-settings.html'),
    read('src/app/core/user/user.service.ts'),
    read('src/app/core/user/user-theme.service.ts'),
  ]);

  await suite.test('makes favorite team optional and defaults registration to RR', () => {
    assert.match(authSource, /signal\(RINKRAT_NEUTRAL_ABBREVIATION\)/);
    assert.match(authTemplate, /Favorite NHL Team/);
    assert.match(authTemplate, /Optional · You can choose or change this later/);
    assert.match(authTemplate, /No favorite yet/);
    assert.doesNotMatch(authSource, /Choose your favorite NHL team to finish/);
  });

  await suite.test('asks and saves hockey familiarity during registration', () => {
    assert.match(authTemplate, /How familiar are you with hockey\?/);
    assert.match(authSource, /this\.hockeyExperience\(\)/);
    assert.match(authService, /hockeyExperience: HockeyExperienceLevel/);
    assert.match(authService, /hockeyExperience,/);
  });

  await suite.test('lets managers update both identity and explanation level later', () => {
    assert.match(accountSource, /USER_SELECTABLE_PIXEL_THEMES/);
    assert.match(accountSource, /hockeyExperience: this\.hockeyExperience/);
    assert.match(accountTemplate, /Favorite Team or RinkRat Colors/);
    assert.match(accountTemplate, /Hockey Familiarity/);
    assert.match(accountTemplate, /never changes scoring or league rules/i);
  });

  await suite.test('persists the optional field without exposing it publicly', () => {
    assert.match(userService, /hockeyExperience\?: HockeyExperienceLevel/);
    assert.match(userService, /hockeyExperience: settings\.hockeyExperience/);
    assert.doesNotMatch(
      userService.match(/function getPublicProfileWrite[\s\S]*?\n\}/)?.[0] ?? '',
      /hockeyExperience/,
    );
    assert.match(userThemeService, /storeHockeyExperienceLevel/);
    assert.match(userThemeService, /RINKRAT_NEUTRAL_ABBREVIATION/);
  });
});

test('Batch M2 glossary and beginner-language UI contracts', async (suite) => {
  const [
    chipSource,
    chipTemplate,
    trainingSource,
    trainingTemplate,
    scoringSource,
    scoringTemplate,
    coachSource,
    coachTemplate,
  ] = await Promise.all([
    read('src/app/shared/hockey-terms/hockey-term-chip.ts'),
    read('src/app/shared/hockey-terms/hockey-term-chip.html'),
    read('src/app/features/onboarding/training-camp/training-camp.ts'),
    read('src/app/features/onboarding/training-camp/training-camp.html'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.ts'),
    read('src/app/features/scoring/scoring-guide/scoring-guide.html'),
    read('src/app/shared/coach-help/coach-help.ts'),
    read('src/app/shared/coach-help/coach-help.html'),
  ]);

  await suite.test('provides keyboard-accessible tap-to-define controls', () => {
    assert.match(chipTemplate, /type="button"/);
    assert.match(chipTemplate, /aria-expanded/);
    assert.match(chipTemplate, /aria-controls/);
    assert.match(chipTemplate, /role="region"/);
    assert.match(chipSource, /HostListener\('document:keydown\.escape'\)/);
  });

  await suite.test('places definitions in Training Camp and the scoring guide', () => {
    assert.match(trainingSource, /HockeyTermChip/);
    assert.match(trainingTemplate, /term="left-wing"/);
    assert.match(trainingTemplate, /term="team-goalie-unit"/);
    assert.match(scoringSource, /HockeyTermChip/);
    assert.match(scoringTemplate, /<app-hockey-term/);
  });

  await suite.test('keeps the complete glossary available from Coach Help', () => {
    assert.match(coachSource, /HOCKEY_GLOSSARY_TERMS/);
    assert.match(coachTemplate, /<summary>Hockey Terms<\/summary>/);
    assert.match(coachTemplate, /Tap any term for a plain-language definition/);
  });
});

test('Batch M2 backend compatibility contracts', async (suite) => {
  const [rules, functionsIndex, teamSettings, freeAgents, cycleService] =
    await Promise.all([
      read('firestore.rules'),
      read('functions/src/index.ts'),
      read('src/app/features/team/team-settings/team-settings.ts'),
      read('src/app/features/free-agents/free-agents.ts'),
      read('src/app/core/cycle/cycle.service.ts'),
    ]);

  await suite.test('accepts RR and validates only the supported familiarity values', () => {
    assert.match(rules, /'RR'/);
    assert.match(rules, /validHockeyExperience/);
    assert.match(rules, /\['new', 'basic', 'experienced'\]/);
    assert.match(rules, /'hockeyExperience'/);
  });

  await suite.test('normalizes public profile fallback identity to RR on the server', () => {
    assert.match(functionsIndex, /PUBLIC_PROFILE_TEAM_ABBREVIATIONS[\s\S]*?'RR'/);
    assert.match(functionsIndex, /:\s*'RR',/);
  });

  await suite.test('preserves internal cycle labels required by existing transaction data', () => {
    assert.match(teamSettings, /effectiveLabel:\s*`Cycle \$\{effectiveCycleNumber\}`/);
    assert.match(freeAgents, /const effectiveLabel = `Cycle \$\{effectiveCycleNumber\}`/);
    assert.match(cycleService, /function getCycleDocumentId/);
    assert.match(cycleService, /asset-cycle-window/);
  });
});

test('Batch M2 removes planned engineering jargon from primary manager templates', async () => {
  const templatePaths = [
    'src/app/features/auth/auth.html',
    'src/app/features/dashboard/dashboard.html',
    'src/app/features/account/account-settings/account-settings.html',
    'src/app/features/onboarding/training-camp/training-camp.html',
    'src/app/features/scoring/scoring-guide/scoring-guide.html',
    'src/app/features/draft/draft-setup/draft-setup.html',
    'src/app/features/draft/draft-room/draft-room.html',
    'src/app/features/free-agents/free-agents.html',
    'src/app/features/leagues/league-detail/league-detail.html',
    'src/app/features/leagues/league-standings/league-standings.html',
    'src/app/features/cycles/cycle-one/cycle-one.html',
    'src/app/features/cycles/cycle-one/components/cycle-mobile-head-to-head/cycle-mobile-head-to-head.html',
    'src/app/features/cycles/matchup-overview/cycle-matchup-overview.html',
    'src/app/features/cycles/schedule-preview/cycle-schedule-preview.html',
    'src/app/features/team/team-settings/team-settings.html',
    'src/app/features/leaders/point-leaders/point-leaders.html',
    'src/app/features/playoffs/playoff-bracket/playoff-bracket.html',
    'src/app/features/projections/projection-lab/projection-lab.html',
    'src/app/shared/coach-help/coach-help.html',
  ];
  const source = (await Promise.all(templatePaths.map(read))).join('\n');

  for (const expression of [
    /Available Assets/i,
    /Active asset/i,
    /Current asset/i,
    /Incoming asset/i,
    /Asset window/i,
    /Cycle total/i,
    /Next[- ]cycle projection/i,
    /Cycle boundary/i,
    /Current Cycle/i,
    /Cycle Matchups/i,
    /Games Per Cycle/i,
    /Window Progress/i,
    /Bench assets/i,
    /queued move/i,
    /six-game windows/i,
  ]) {
    assert.doesNotMatch(source, expression);
  }

  assert.match(source, /Next 6 Games/);
  assert.match(source, /Six-Game Progress/);
  assert.match(source, /Injured Reserve \(IR\)/);
});
