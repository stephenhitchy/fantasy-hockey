import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BROWSER_FIRESTORE_REACHABILITY_PROFILE,
  REQUIRED_BROWSER_FIRESTORE_CHECKS,
  evaluateDependencyAuditPolicy,
} from '../../scripts/security/dependency-audit-policy.mjs';

const ROOT = new URL('../../', import.meta.url);
const NOW = new Date('2026-09-30T19:00:00.000Z');

function grpcAdvisory({
  source = 1240623,
  ghsa = 'GHSA-m9gg-hp2v-232j',
  severity = 'high',
  title = 'grpc auth context test advisory',
} = {}) {
  return {
    source,
    name: '@grpc/grpc-js',
    dependency: '@grpc/grpc-js',
    title,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '<1.13.6',
  };
}

function angularClientReport(advisories = [grpcAdvisory()]) {
  return {
    label: 'Angular client',
    cwd: '.',
    unavailable: false,
    raw: {
      vulnerabilities: {
        firebase: {
          name: 'firebase',
          severity: 'high',
          via: ['@firebase/firestore', '@firebase/firestore-compat'],
        },
        '@firebase/firestore': {
          name: '@firebase/firestore',
          severity: 'high',
          via: ['@grpc/grpc-js'],
        },
        '@firebase/firestore-compat': {
          name: '@firebase/firestore-compat',
          severity: 'high',
          via: ['@firebase/firestore'],
        },
        '@grpc/grpc-js': {
          name: '@grpc/grpc-js',
          severity: 'high',
          via: advisories,
        },
      },
    },
  };
}

function rootLock() {
  return {
    packages: {
      'node_modules/firebase': {
        version: '12.16.0',
        dependencies: { '@firebase/firestore': '4.16.0' },
      },
      'node_modules/@firebase/firestore': {
        version: '4.16.0',
        dependencies: { '@grpc/grpc-js': '~1.9.0' },
      },
      'node_modules/@grpc/grpc-js': { version: '1.9.16' },
    },
  };
}

function reachabilityEvidence() {
  return {
    [BROWSER_FIRESTORE_REACHABILITY_PROFILE]: Object.fromEntries(
      REQUIRED_BROWSER_FIRESTORE_CHECKS.map((check) => [check, true]),
    ),
  };
}

async function exceptionConfig() {
  return JSON.parse(await readFile(
    new URL('../../config/security/dependency-advisory-exceptions.json', import.meta.url),
    'utf8',
  ));
}

async function evaluate(overrides = {}) {
  return evaluateDependencyAuditPolicy({
    reports: [angularClientReport()],
    exceptionConfig: await exceptionConfig(),
    rootLock: rootLock(),
    reachabilityEvidence: reachabilityEvidence(),
    now: NOW,
    ...overrides,
  });
}

test('the exact browser-only Firestore grpc advisory is excepted while raw findings remain visible', async () => {
  const result = await evaluate();

  assert.equal(result.rawBlockers.length, 1);
  assert.equal(result.rawBlockers[0].ghsa, 'GHSA-M9GG-HP2V-232J');
  assert.deepEqual(result.rawBlockers[0].affectedPackages, [
    '@firebase/firestore',
    '@firebase/firestore-compat',
    '@grpc/grpc-js',
    'firebase',
  ]);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.exceptionErrors.length, 0);
  assert.equal(result.appliedExceptions.length, 1);
  assert.equal(
    result.appliedExceptions[0].id,
    'angular-client-firestore-node-grpc-auth-context-2026-09-30',
  );
});

test('a second high advisory on the same package is never covered by the exact exception', async () => {
  const result = await evaluate({
    reports: [angularClientReport([
      grpcAdvisory(),
      grpcAdvisory({
        source: 9999999,
        ghsa: 'GHSA-9999-8888-7777',
        title: 'unrelated future high advisory',
      }),
    ])],
  });

  assert.equal(result.appliedExceptions.length, 1);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].ghsa, 'GHSA-9999-8888-7777');
});

test('the exception rejects the same advisory when a new affected-package path appears', async () => {
  const report = angularClientReport();
  report.raw.vulnerabilities['reachable-node-server-wrapper'] = {
    name: 'reachable-node-server-wrapper',
    severity: 'high',
    via: ['@grpc/grpc-js'],
  };
  const result = await evaluate({ reports: [report] });

  assert.deepEqual(result.rawBlockers[0].affectedPackages, [
    '@firebase/firestore',
    '@firebase/firestore-compat',
    '@grpc/grpc-js',
    'firebase',
    'reachable-node-server-wrapper',
  ]);
  assert.equal(result.appliedExceptions.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.exceptionErrors.length, 1);
  assert.match(
    result.exceptionErrors[0].errors.join('; '),
    /expected exactly one matching blocking advisory, found 0/,
  );
});

test('a high package with an unresolvable advisory chain fails closed', async () => {
  const result = await evaluate({
    exceptionConfig: { schemaVersion: 1, exceptions: [] },
    reports: [{
      label: 'Angular client',
      cwd: '.',
      unavailable: false,
      raw: {
        metadata: {
          vulnerabilities: { high: 1, critical: 0, total: 1 },
        },
        vulnerabilities: {
          firebase: {
            name: 'firebase',
            severity: 'high',
            via: ['missing-advisory-leaf'],
          },
        },
      },
    }],
  });

  assert.equal(result.rawBlockers.length, 0);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.appliedExceptions.length, 0);
  assert.equal(result.exceptionErrors.length, 1);
  assert.match(
    result.exceptionErrors
      .flatMap((error) => error.errors)
      .join('; '),
    /could not resolve concrete high\/critical advisory evidence for: firebase/,
  );
});

test('blocking metadata with an empty vulnerability map fails closed', async () => {
  const result = await evaluate({
    exceptionConfig: { schemaVersion: 1, exceptions: [] },
    reports: [{
      label: 'Angular client',
      cwd: '.',
      unavailable: false,
      vulnerabilities: { high: 1, critical: 0, total: 1 },
      raw: {
        metadata: {
          vulnerabilities: { high: 1, critical: 0, total: 1 },
        },
        vulnerabilities: {},
      },
    }],
  });

  assert.equal(result.rawBlockers.length, 0);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.exceptionErrors.length, 1);
  assert.match(
    result.exceptionErrors[0].errors.join('; '),
    /npm reported 1 high\/critical finding\(s\), but the vulnerability map contained 0 blocking package entries/,
  );
});

test('expiry, version, dependency path, surface, GHSA, and reachability mismatches fail closed', async (t) => {
  const cases = [
    {
      name: 'expiry',
      overrides: { now: new Date('2026-10-15T00:00:00.000Z') },
      expected: /expired/,
    },
    {
      name: 'locked version',
      overrides: {
        rootLock: {
          ...rootLock(),
          packages: {
            ...rootLock().packages,
            'node_modules/@grpc/grpc-js': { version: '1.9.15' },
          },
        },
      },
      expected: /version 1\.9\.15 did not match 1\.9\.16/,
    },
    {
      name: 'dependency path',
      overrides: {
        rootLock: {
          ...rootLock(),
          packages: {
            ...rootLock().packages,
            'node_modules/@firebase/firestore': {
              version: '4.16.0',
              dependencies: { '@grpc/grpc-js': '^1.14.5' },
            },
          },
        },
      },
      expected: /dependency @grpc\/grpc-js \^1\.14\.5 did not match ~1\.9\.0/,
    },
    {
      name: 'surface',
      mutateConfig: (config) => { config.exceptions[0].surface.label = 'Cloud Functions'; },
      expected: /exactly one matching blocking advisory, found 0/,
    },
    {
      name: 'GHSA',
      mutateConfig: (config) => { config.exceptions[0].advisory.ghsa = 'GHSA-0000-0000-0000'; },
      expected: /exactly one matching blocking advisory, found 0/,
    },
    {
      name: 'reachability',
      overrides: {
        reachabilityEvidence: {
          ...reachabilityEvidence(),
          [BROWSER_FIRESTORE_REACHABILITY_PROFILE]: {
            ...reachabilityEvidence()[BROWSER_FIRESTORE_REACHABILITY_PROFILE],
            angularHasNoServerTarget: false,
          },
        },
      },
      expected: /reachability check angularHasNoServerTarget did not pass/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const config = await exceptionConfig();
      fixture.mutateConfig?.(config);
      const result = await evaluate({ exceptionConfig: config, ...fixture.overrides });
      assert.equal(result.appliedExceptions.length, 0);
      assert.equal(result.blockers.length, 1);
      assert.equal(result.exceptionErrors.length, 1);
      assert.match(result.exceptionErrors[0].errors.join('; '), fixture.expected);
    });
  }
});

test('the source-controlled exception is bounded, owned, and expires promptly', async () => {
  const config = await exceptionConfig();
  const [exception] = config.exceptions;

  assert.equal(config.schemaVersion, 1);
  assert.equal(config.exceptions.length, 1);
  assert.equal(exception.advisory.ghsa, 'GHSA-m9gg-hp2v-232j');
  assert.equal(exception.advisory.package, '@grpc/grpc-js');
  assert.deepEqual(exception.expectedAffectedPackages, [
    '@firebase/firestore',
    '@firebase/firestore-compat',
    '@grpc/grpc-js',
    'firebase',
  ]);
  assert.equal(exception.reachabilityProfile, BROWSER_FIRESTORE_REACHABILITY_PROFILE);
  assert.match(exception.owner, /platform administrator/i);
  assert.ok(new Date(exception.expiresAt).getTime() > NOW.getTime());
  assert.ok(
    new Date(exception.expiresAt).getTime() - NOW.getTime() <= 15 * 24 * 60 * 60 * 1_000,
  );
});

test('the audit script records raw and effective policy evidence rather than deleting npm findings', async () => {
  const audit = await readFile(new URL('../../scripts/security/dependency-audit.mjs', import.meta.url), 'utf8');

  assert.match(audit, /dependency-advisory-exceptions\.json/);
  assert.match(audit, /evaluateDependencyAuditPolicy/);
  assert.match(audit, /reports,/);
  assert.match(audit, /policy,/);
  assert.match(audit, /policy\.blockers\.length/);
  assert.match(audit, /policy\.exceptionErrors\.length/);
  assert.doesNotMatch(audit, /audit-level=none/);
});
