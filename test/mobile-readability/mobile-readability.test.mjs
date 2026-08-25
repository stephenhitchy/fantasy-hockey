import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const navigationUtilityPath = join(
  projectRoot,
  'src/app/shared/navbar/mobile-navigation.util.ts',
);

const read = (path) => readFile(join(projectRoot, path), 'utf8');

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

async function loadNavigationUtility() {
  const typescript = await loadTypescript();
  const source = await readFile(navigationUtilityPath, 'utf8');
  const result = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'rinkrat-mobile-navigation-'));
  const outputPath = join(directory, 'mobile-navigation.mjs');
  await writeFile(outputPath, result.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(outputPath).href}?v=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Batch M1 adaptive mobile navigation behavior', async (suite) => {
  const {
    extractLeagueIdFromUrl,
    resolveMobileLeaguePrimaryDestination,
  } = await loadNavigationUtility();

  await suite.test('does not treat create and join routes as league IDs', () => {
    assert.equal(extractLeagueIdFromUrl('/leagues/create'), '');
    assert.equal(extractLeagueIdFromUrl('/leagues/join?invite=ABC123'), '');
    assert.equal(extractLeagueIdFromUrl('/dashboard'), '');
    assert.equal(
      extractLeagueIdFromUrl('/leagues/my%20league/team#roster'),
      'my league',
    );
  });

  await suite.test('uses League before a draft is scheduled', () => {
    for (const draftStatus of [null, 'setup']) {
      const destination = resolveMobileLeaguePrimaryDestination({
        leagueId: 'league-1',
        draftStatus,
        matchup: null,
      });

      assert.equal(destination.kind, 'league');
      assert.equal(destination.label, 'League');
      assert.deepEqual(destination.route, ['/leagues', 'league-1']);
    }
  });

  await suite.test('uses Draft while the draft is scheduled or live', () => {
    for (const draftStatus of ['scheduled', 'live']) {
      const destination = resolveMobileLeaguePrimaryDestination({
        leagueId: 'league-1',
        draftStatus,
        matchup: null,
      });

      assert.equal(destination.kind, 'draft');
      assert.equal(destination.label, 'Draft');
      assert.deepEqual(destination.route, ['/leagues', 'league-1', 'draft']);
    }
  });

  await suite.test('uses the exact owner matchup after the draft', () => {
    const destination = resolveMobileLeaguePrimaryDestination({
      leagueId: 'league-1',
      draftStatus: 'complete',
      matchup: {
        id: 'matchup-17',
        cycleNumber: 4,
      },
    });

    assert.equal(destination.kind, 'matchup');
    assert.equal(destination.label, 'Matchup');
    assert.deepEqual(destination.route, [
      '/leagues',
      'league-1',
      'cycles',
      4,
      'matchups',
      'matchup-17',
    ]);
  });

  await suite.test('falls back to League until a matchup exists', () => {
    const destination = resolveMobileLeaguePrimaryDestination({
      leagueId: 'league-1',
      draftStatus: 'complete',
      matchup: null,
    });

    assert.equal(destination.kind, 'league');
    assert.deepEqual(destination.route, ['/leagues', 'league-1']);
  });
});

test('Batch M1 navigation source contracts', async (suite) => {
  const [navbar, template] = await Promise.all([
    read('src/app/shared/navbar/navbar.ts'),
    read('src/app/shared/navbar/navbar.html'),
  ]);

  await suite.test('keeps global navigation independent from league and Draft listeners', () => {
    assert.match(navbar, /listenToAuthState/);
    assert.match(navbar, /NavigationEnd/);
    assert.doesNotMatch(navbar, /listenToFantasyDraft/);
    assert.doesNotMatch(navbar, /listenToEarliestUnfinishedOwnerMatchup/);
    assert.doesNotMatch(navbar, /draftStatus|latestCycle|league-wide cycle/i);
  });

  await suite.test('renders durable mobile destinations and keeps Support and Account in More', () => {
    assert.match(template, /routerLink="\/dashboard"[\s\S]*?<span>Dashboard<\/span>/);
    assert.match(template, /routerLink="\/leagues\/create"[\s\S]*?<span>Create<\/span>/);
    assert.match(template, /routerLink="\/leagues\/join"[\s\S]*?<span>Join<\/span>/);
    assert.match(template, /routerLink="\/scoring"[\s\S]*?<span>Scoring<\/span>/);
    assert.match(template, /<strong>Support<\/strong>/);
    assert.match(template, /<strong>Account<\/strong>/);
    assert.doesNotMatch(template, /mobileLeaguePrimary/);
    assert.doesNotMatch(template, /<strong>League HQ<\/strong>/);
  });
});

test('Batch M1 mobile readability contracts', async (suite) => {
  const files = await Promise.all([
    read('src/rinkrat-design-tokens.css'),
    read('src/app/shared/navbar/navbar.css'),
    read('src/app/layouts/main-layout/main-layout.css'),
    read('src/app/features/dashboard/dashboard.css'),
    read('src/app/features/leagues/league-detail/league-detail.css'),
    read('src/app/features/draft/draft-room/draft-room.css'),
    read('src/app/features/cycles/cycle-one/cycle-one.css'),
    read('src/app/features/team/team-settings/team-settings.css'),
    read('src/app/features/free-agents/free-agents.css'),
  ]);

  const [
    tokens,
    navbarCss,
    layoutCss,
    dashboardCss,
    leagueCss,
    draftCss,
    gameCenterCss,
    teamCss,
    freeAgentsCss,
  ] = files;

  await suite.test('defines one shared mobile type and touch-target scale', () => {
    assert.match(tokens, /--rr-text-xs:\s*0\.75rem/);
    assert.match(tokens, /--rr-mobile-text-micro:\s*var\(--rr-text-xs\)/);
    assert.match(tokens, /--rr-mobile-text-label:\s*0\.8125rem/);
    assert.match(tokens, /--rr-mobile-text-player:\s*0\.9375rem/);
    assert.match(tokens, /--rr-mobile-text-score:\s*clamp\(/);
    assert.match(
      tokens,
      /--rr-mobile-control-min-height:\s*var\(--rr-touch-target\)/,
    );
    assert.match(tokens, /--rr-touch-target:\s*44px/);
  });

  await suite.test('keeps bottom navigation labels at the 12px mobile floor', () => {
    assert.match(navbarCss, /--rr-nav-item-font-size:\s*var\(--rr-mobile-text-micro\)/);
    assert.doesNotMatch(navbarCss, /\.mobile-bottom-nav[\s\S]{0,500}font-size:\s*(?:9|10)px/);
  });

  await suite.test('covers every primary mobile league surface', () => {
    const contracts = [
      dashboardCss,
      leagueCss,
      draftCss,
      gameCenterCss,
      teamCss,
      freeAgentsCss,
    ];

    for (const source of contracts) {
      assert.match(source, /--rr-mobile-text-(?:micro|label|player|score)/);
    }
  });

  await suite.test('gives frequent draft, roster, league, and free-agent actions 44px targets', () => {
    for (const source of [leagueCss, draftCss, gameCenterCss, teamCss, freeAgentsCss]) {
      assert.match(source, /min-height:\s*var\(--rr-mobile-control-min-height\)/);
    }
  });

  await suite.test('reduces narrow-phone decoration without changing content', () => {
    assert.match(layoutCss, /Batch M1: quieter decorative ribbon on narrow phones/);
    assert.match(layoutCss, /@media \(max-width: 430px\)/);
    assert.match(layoutCss, /\.global-team-logo-chip small\s*\{\s*display:\s*none/);
  });
});
