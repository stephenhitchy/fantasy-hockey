const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

export const BROWSER_FIRESTORE_REACHABILITY_PROFILE =
  'angular-browser-firestore-node-transport-not-bundled-v1';

export const REQUIRED_BROWSER_FIRESTORE_CHECKS = Object.freeze([
  'angularUsesBrowserApplicationBuilder',
  'angularHasNoServerTarget',
  'angularHasNoServerBuildOptions',
  'firebaseHostsStaticBrowserOutput',
  'firestoreUsesSeparateBrowserExport',
  'firestoreBrowserExportExcludesGrpcServerApis',
  'applicationSourceExcludesGrpcServerApis',
]);

function normalizedSeverity(value) {
  return String(value ?? '').trim().toLowerCase();
}

function advisoryGhsa(advisory) {
  return String(advisory?.url ?? '').match(/GHSA-[0-9a-z-]+/i)?.[0]?.toUpperCase() ?? '';
}

function advisoryKey(surface, advisory) {
  return [surface.label, surface.cwd, advisory.source, advisory.url].join('|');
}

function collectPackageAdvisories(vulnerabilities, packageName, visited = new Set()) {
  if (visited.has(packageName)) {
    return [];
  }

  const vulnerability = vulnerabilities?.[packageName];
  if (!vulnerability || !Array.isArray(vulnerability.via)) {
    return [];
  }

  const nextVisited = new Set(visited);
  nextVisited.add(packageName);
  const advisories = [];

  for (const via of vulnerability.via) {
    if (typeof via === 'string') {
      advisories.push(...collectPackageAdvisories(vulnerabilities, via, nextVisited));
      continue;
    }
    if (via && typeof via === 'object') {
      advisories.push(via);
    }
  }

  return advisories;
}

export function collectBlockingAdvisories(reports) {
  const blockers = new Map();

  for (const report of reports ?? []) {
    if (report?.unavailable) {
      continue;
    }

    const vulnerabilities = report?.raw?.vulnerabilities ?? {};
    const surface = {
      label: String(report?.label ?? ''),
      cwd: String(report?.cwd ?? ''),
    };

    for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
      if (!BLOCKING_SEVERITIES.has(normalizedSeverity(vulnerability?.severity))) {
        continue;
      }

      for (const advisory of collectPackageAdvisories(vulnerabilities, packageName)) {
        if (!BLOCKING_SEVERITIES.has(normalizedSeverity(advisory?.severity))) {
          continue;
        }

        const key = advisoryKey(surface, advisory);
        const existing = blockers.get(key) ?? {
          key,
          surface,
          source: Number(advisory.source),
          ghsa: advisoryGhsa(advisory),
          package: String(advisory.name ?? advisory.dependency ?? ''),
          severity: normalizedSeverity(advisory.severity),
          title: String(advisory.title ?? ''),
          url: String(advisory.url ?? ''),
          affectedPackages: [],
        };
        if (!existing.affectedPackages.includes(packageName)) {
          existing.affectedPackages.push(packageName);
          existing.affectedPackages.sort();
        }
        blockers.set(key, existing);
      }
    }
  }

  return [...blockers.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function collectBlockingAdvisoryExtractionErrors(reports) {
  const errors = [];

  for (const report of reports ?? []) {
    if (report?.unavailable) {
      continue;
    }

    const vulnerabilities = report?.raw?.vulnerabilities ?? {};
    const blockingPackages = Object.entries(vulnerabilities)
      .filter(([, vulnerability]) => (
        BLOCKING_SEVERITIES.has(normalizedSeverity(vulnerability?.severity))
      ));
    const unresolvedPackages = blockingPackages
      .filter(([packageName]) => !collectPackageAdvisories(
        vulnerabilities,
        packageName,
      ).some((advisory) => (
        BLOCKING_SEVERITIES.has(normalizedSeverity(advisory?.severity))
      )))
      .map(([packageName]) => packageName)
      .sort();
    const vulnerabilityCounts = report?.vulnerabilities ??
      report?.raw?.metadata?.vulnerabilities;
    const reportedBlockingCount = vulnerabilityCounts &&
      Number.isFinite(Number(vulnerabilityCounts.high)) &&
      Number.isFinite(Number(vulnerabilityCounts.critical))
        ? Math.max(0, Number(vulnerabilityCounts.high)) +
          Math.max(0, Number(vulnerabilityCounts.critical))
        : null;
    const reportErrors = [];

    if (
      reportedBlockingCount !== null &&
      reportedBlockingCount !== blockingPackages.length
    ) {
      reportErrors.push(
        `npm reported ${reportedBlockingCount} high/critical finding(s), but the vulnerability map contained ${blockingPackages.length} blocking package entr${blockingPackages.length === 1 ? 'y' : 'ies'}`,
      );
    }

    if (unresolvedPackages.length > 0) {
      reportErrors.push(
        `could not resolve concrete high/critical advisory evidence for: ${unresolvedPackages.join(', ')}`,
      );
    }

    if (reportErrors.length > 0) {
      errors.push({
        id: `dependency-audit-advisory-extraction-${String(report?.label ?? 'unknown')}`,
        errors: reportErrors,
      });
    }
  }

  return errors;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateExceptionShape(exception) {
  const errors = [];
  if (!nonEmptyString(exception?.id)) errors.push('id is required');
  if (!nonEmptyString(exception?.surface?.label)) errors.push('surface.label is required');
  if (!nonEmptyString(exception?.surface?.cwd)) errors.push('surface.cwd is required');
  if (!nonEmptyString(exception?.advisory?.ghsa)) errors.push('advisory.ghsa is required');
  if (!Number.isFinite(Number(exception?.advisory?.source))) errors.push('advisory.source is required');
  if (!nonEmptyString(exception?.advisory?.package)) errors.push('advisory.package is required');
  if (!BLOCKING_SEVERITIES.has(normalizedSeverity(exception?.advisory?.severity))) {
    errors.push('advisory.severity must be high or critical');
  }
  if (
    !Array.isArray(exception?.expectedAffectedPackages) ||
    exception.expectedAffectedPackages.length === 0
  ) {
    errors.push('expectedAffectedPackages must be non-empty');
  } else if (
    exception.expectedAffectedPackages.some((packageName) => !nonEmptyString(packageName)) ||
    new Set(exception.expectedAffectedPackages).size !==
      exception.expectedAffectedPackages.length
  ) {
    errors.push('expectedAffectedPackages must contain unique non-empty package names');
  }
  if (!Array.isArray(exception?.lockPackages) || exception.lockPackages.length === 0) {
    errors.push('lockPackages must be non-empty');
  }
  if (!Array.isArray(exception?.dependencyEdges) || exception.dependencyEdges.length === 0) {
    errors.push('dependencyEdges must be non-empty');
  }
  if (!nonEmptyString(exception?.reachabilityProfile)) errors.push('reachabilityProfile is required');
  if (!nonEmptyString(exception?.owner)) errors.push('owner is required');
  if (!nonEmptyString(exception?.reason)) errors.push('reason is required');
  if (!nonEmptyString(exception?.upstream)) errors.push('upstream is required');
  if (!nonEmptyString(exception?.approvedAt)) errors.push('approvedAt is required');
  if (!nonEmptyString(exception?.expiresAt)) errors.push('expiresAt is required');
  return errors;
}

function validateLockEvidence(exception, rootLock) {
  const errors = [];
  const packages = rootLock?.packages;
  if (!packages || typeof packages !== 'object') {
    return ['root package-lock evidence is unavailable'];
  }

  for (const expected of exception.lockPackages ?? []) {
    if (!nonEmptyString(expected?.path) || !nonEmptyString(expected?.version)) {
      errors.push('lockPackages entries require exact path and version');
      continue;
    }
    const actual = packages[expected.path]?.version;
    if (actual !== expected.version) {
      errors.push(`${expected.path} version ${actual ?? 'missing'} did not match ${expected.version}`);
    }
  }

  for (const edge of exception.dependencyEdges ?? []) {
    if (!nonEmptyString(edge?.from) || !nonEmptyString(edge?.dependency) || !nonEmptyString(edge?.declared)) {
      errors.push('dependencyEdges entries require exact from, dependency, and declared values');
      continue;
    }
    const actual = packages[edge.from]?.dependencies?.[edge.dependency];
    if (actual !== edge.declared) {
      errors.push(
        `${edge.from} dependency ${edge.dependency} ${actual ?? 'missing'} did not match ${edge.declared}`,
      );
    }
  }

  return errors;
}

function validateReachability(exception, reachabilityEvidence) {
  if (exception.reachabilityProfile !== BROWSER_FIRESTORE_REACHABILITY_PROFILE) {
    return [`unsupported reachability profile ${exception.reachabilityProfile}`];
  }

  const evidence = reachabilityEvidence?.[exception.reachabilityProfile];
  if (!evidence || typeof evidence !== 'object') {
    return [`reachability evidence ${exception.reachabilityProfile} is unavailable`];
  }

  const errors = [];
  for (const check of REQUIRED_BROWSER_FIRESTORE_CHECKS) {
    if (evidence[check] !== true) {
      errors.push(`reachability check ${check} did not pass`);
    }
  }
  return errors;
}

function matchesException(blocker, exception) {
  const actualAffectedPackages = [...blocker.affectedPackages]
    .sort((left, right) => left.localeCompare(right));
  const expectedAffectedPackages = [...(exception.expectedAffectedPackages ?? [])]
    .sort((left, right) => left.localeCompare(right));

  return blocker.surface.label === exception.surface.label
    && blocker.surface.cwd === exception.surface.cwd
    && blocker.ghsa === String(exception.advisory.ghsa).toUpperCase()
    && blocker.source === Number(exception.advisory.source)
    && blocker.package === exception.advisory.package
    && blocker.severity === normalizedSeverity(exception.advisory.severity)
    && actualAffectedPackages.length === expectedAffectedPackages.length
    && actualAffectedPackages.every(
      (packageName, index) => packageName === expectedAffectedPackages[index],
    );
}

export function evaluateDependencyAuditPolicy({
  reports,
  exceptionConfig,
  rootLock,
  reachabilityEvidence,
  now = new Date(),
}) {
  const rawBlockers = collectBlockingAdvisories(reports);
  const remaining = new Map(rawBlockers.map((blocker) => [blocker.key, blocker]));
  const appliedExceptions = [];
  const exceptionErrors = collectBlockingAdvisoryExtractionErrors(reports);

  if (exceptionConfig?.schemaVersion !== 1 || !Array.isArray(exceptionConfig?.exceptions)) {
    return {
      rawBlockers,
      blockers: rawBlockers,
      appliedExceptions,
      exceptionErrors: [...exceptionErrors, {
        id: 'dependency-advisory-policy-config',
        errors: ['dependency advisory exception config must use schemaVersion 1 with an exceptions array'],
      }],
    };
  }

  const seenIds = new Set();
  const appliedBlockerKeys = new Set();
  for (const exception of exceptionConfig.exceptions) {
    const id = nonEmptyString(exception?.id) ? exception.id : '<missing-id>';
    const errors = validateExceptionShape(exception);

    if (seenIds.has(id)) errors.push(`duplicate exception id ${id}`);
    seenIds.add(id);

    const approvedAt = new Date(exception?.approvedAt ?? Number.NaN);
    const expiresAt = new Date(exception?.expiresAt ?? Number.NaN);
    if (Number.isNaN(approvedAt.getTime())) errors.push('approvedAt is invalid');
    if (Number.isNaN(expiresAt.getTime())) errors.push('expiresAt is invalid');
    if (!Number.isNaN(expiresAt.getTime()) && now.getTime() >= expiresAt.getTime()) {
      errors.push(`exception expired at ${exception.expiresAt}`);
    }
    if (!Number.isNaN(approvedAt.getTime()) && approvedAt.getTime() > now.getTime()) {
      errors.push(`approvedAt ${exception.approvedAt} is in the future`);
    }

    errors.push(...validateLockEvidence(exception, rootLock));
    errors.push(...validateReachability(exception, reachabilityEvidence));

    const matches = rawBlockers.filter((blocker) => matchesException(blocker, exception));
    if (matches.length !== 1) {
      errors.push(`expected exactly one matching blocking advisory, found ${matches.length}`);
    } else if (appliedBlockerKeys.has(matches[0].key)) {
      errors.push(`blocking advisory is already covered by another exception`);
    }

    if (errors.length > 0) {
      exceptionErrors.push({ id, errors });
      continue;
    }

    const [blocker] = matches;
    appliedBlockerKeys.add(blocker.key);
    remaining.delete(blocker.key);
    appliedExceptions.push({
      id,
      surface: blocker.surface,
      source: blocker.source,
      ghsa: blocker.ghsa,
      package: blocker.package,
      severity: blocker.severity,
      affectedPackages: blocker.affectedPackages,
      owner: exception.owner,
      expiresAt: exception.expiresAt,
      reachabilityProfile: exception.reachabilityProfile,
    });
  }

  return {
    rawBlockers,
    blockers: [...remaining.values()],
    appliedExceptions,
    exceptionErrors,
  };
}
