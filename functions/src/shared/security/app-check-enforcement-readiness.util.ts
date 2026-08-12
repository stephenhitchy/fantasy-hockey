export type AppCheckReadinessStatus = 'collecting' | 'needs-attention' | 'ready';

export interface AppCheckEvidenceRecord {
  buildId?: unknown;
  browser?: unknown;
  platform?: unknown;
  viewportCategory?: unknown;
  kind?: unknown;
  action?: unknown;
  serverAppCheckStatus?: unknown;
  dailyUserHash?: unknown;
  dateKey?: unknown;
}

export interface AppCheckCoverageBucket {
  name: string;
  required: boolean;
  total: number;
  valid: number;
  missing: number;
  validPercent: number;
  minimumSamples: number;
  sampleGatePassed: boolean;
  verificationGatePassed: boolean;
}

export interface AppCheckReadinessPolicy {
  minimumTotalSamples: number;
  minimumObservedDays: number;
  minimumManagerDays: number;
  minimumValidPercent: number;
  minimumSamplesPerRequiredBrowser: number;
  minimumSamplesPerRequiredDevice: number;
  minimumSamplesPerRequiredPlatform: number;
  minimumSamplesPerRequiredAction: number;
  requiredBrowsers: readonly string[];
  requiredDevices: readonly string[];
  requiredPlatforms: readonly string[];
  requiredActions: readonly string[];
}

export interface AppCheckEnforcementReadiness {
  status: AppCheckReadinessStatus;
  headline: string;
  detail: string;
  exactBuildId: string;
  totalSamples: number;
  validSamples: number;
  missingSamples: number;
  validPercent: number;
  observedDayCount: number;
  managerDayCount: number;
  minimumTotalSamples: number;
  minimumObservedDays: number;
  minimumManagerDays: number;
  minimumValidPercent: number;
  browserCoverage: AppCheckCoverageBucket[];
  deviceCoverage: AppCheckCoverageBucket[];
  platformCoverage: AppCheckCoverageBucket[];
  actionCoverage: AppCheckCoverageBucket[];
  blockers: string[];
  advisories: string[];
  canaryEligible: boolean;
  automaticEnforcement: false;
}

export const APP_CHECK_READINESS_POLICY: AppCheckReadinessPolicy = Object.freeze({
  minimumTotalSamples: 50,
  minimumObservedDays: 3,
  minimumManagerDays: 5,
  minimumValidPercent: 99,
  minimumSamplesPerRequiredBrowser: 3,
  minimumSamplesPerRequiredDevice: 3,
  minimumSamplesPerRequiredPlatform: 3,
  minimumSamplesPerRequiredAction: 3,
  requiredBrowsers: Object.freeze(['Chrome', 'Safari', 'Mobile Safari']),
  requiredDevices: Object.freeze(['phone', 'desktop']),
  requiredPlatforms: Object.freeze(['iOS', 'Android']),
  requiredActions: Object.freeze([
    'draft-pick',
    'add-drop',
    'lineup-swap',
    'injured-reserve',
    'waiver-claim',
  ]),
});

function stringValue(value: unknown, fallback = 'Unknown'): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;
}

function isValid(record: AppCheckEvidenceRecord): boolean {
  return record.serverAppCheckStatus === 'valid';
}

function percentage(valid: number, total: number): number {
  return total > 0 ? Math.round((valid / total) * 1_000) / 10 : 0;
}

function buildCoverage(
  records: readonly AppCheckEvidenceRecord[],
  selector: (record: AppCheckEvidenceRecord) => string,
  requiredNames: readonly string[],
  minimumRequiredSamples: number,
  minimumValidPercent: number,
): AppCheckCoverageBucket[] {
  const counts = new Map<string, { valid: number; missing: number }>();

  for (const record of records) {
    const name = selector(record);
    const existing = counts.get(name) ?? { valid: 0, missing: 0 };
    if (isValid(record)) existing.valid += 1;
    else existing.missing += 1;
    counts.set(name, existing);
  }

  for (const requiredName of requiredNames) {
    if (!counts.has(requiredName)) counts.set(requiredName, { valid: 0, missing: 0 });
  }

  return [...counts.entries()]
    .map(([name, count]) => {
      const required = requiredNames.includes(name);
      const total = count.valid + count.missing;
      const validPercent = percentage(count.valid, total);
      const minimumSamples = required ? minimumRequiredSamples : 0;
      return {
        name,
        required,
        total,
        valid: count.valid,
        missing: count.missing,
        validPercent,
        minimumSamples,
        sampleGatePassed: !required || total >= minimumSamples,
        verificationGatePassed:
          !required || (total >= minimumSamples && validPercent >= minimumValidPercent),
      };
    })
    .sort((left, right) => {
      if (left.required !== right.required) return left.required ? -1 : 1;
      return right.total - left.total || left.name.localeCompare(right.name);
    });
}

function requiredCoverageBlockers(
  label: string,
  buckets: readonly AppCheckCoverageBucket[],
  minimumValidPercent: number,
): string[] {
  const blockers: string[] = [];

  for (const bucket of buckets.filter((item) => item.required)) {
    if (!bucket.sampleGatePassed) {
      blockers.push(`${label} ${bucket.name} has ${bucket.total}/${bucket.minimumSamples} required exact-build sample(s).`);
      continue;
    }
    if (!bucket.verificationGatePassed) {
      blockers.push(`${label} ${bucket.name} is ${bucket.validPercent}% verified; the gate requires at least ${minimumValidPercent}%.`);
    }
  }

  return blockers;
}

export function buildAppCheckEnforcementReadiness(
  allRecords: readonly AppCheckEvidenceRecord[],
  exactBuildId: string,
  policy: AppCheckReadinessPolicy = APP_CHECK_READINESS_POLICY,
  options: { sampleLimitReached?: boolean } = {},
): AppCheckEnforcementReadiness {
  const normalizedBuildId = exactBuildId.trim().slice(0, 180);
  const records = normalizedBuildId
    ? allRecords.filter((record) => stringValue(record.buildId, '') === normalizedBuildId)
    : [...allRecords];
  const validSamples = records.filter(isValid).length;
  const totalSamples = records.length;
  const missingSamples = totalSamples - validSamples;
  const validPercent = percentage(validSamples, totalSamples);
  const observedDays = new Set(records.map((record) => stringValue(record.dateKey, '')).filter(Boolean));
  const managerDays = new Set(records.map((record) => stringValue(record.dailyUserHash, '')).filter(Boolean));
  const browserCoverage = buildCoverage(records, (record) => stringValue(record.browser), policy.requiredBrowsers, policy.minimumSamplesPerRequiredBrowser, policy.minimumValidPercent);
  const deviceCoverage = buildCoverage(records, (record) => stringValue(record.viewportCategory), policy.requiredDevices, policy.minimumSamplesPerRequiredDevice, policy.minimumValidPercent);
  const platformCoverage = buildCoverage(records, (record) => stringValue(record.platform), policy.requiredPlatforms, policy.minimumSamplesPerRequiredPlatform, policy.minimumValidPercent);
  const competitiveRecords = records.filter((record) => record.kind === 'competitive-action');
  const actionCoverage = buildCoverage(competitiveRecords, (record) => stringValue(record.action), policy.requiredActions, policy.minimumSamplesPerRequiredAction, policy.minimumValidPercent);
  const blockers: string[] = [];
  const advisories: string[] = [];

  if (!normalizedBuildId) blockers.push('The administrator client did not supply an exact build ID.');
  if (totalSamples < policy.minimumTotalSamples) blockers.push(`Exact-build evidence has ${totalSamples}/${policy.minimumTotalSamples} required sample(s).`);
  if (observedDays.size < policy.minimumObservedDays) blockers.push(`Exact-build evidence covers ${observedDays.size}/${policy.minimumObservedDays} required UTC day(s).`);
  if (managerDays.size < policy.minimumManagerDays) blockers.push(`Exact-build evidence contains ${managerDays.size}/${policy.minimumManagerDays} required privacy-limited manager-day(s).`);
  if (totalSamples > 0 && validPercent < policy.minimumValidPercent) blockers.push(`Overall exact-build App Check verification is ${validPercent}%; the gate requires at least ${policy.minimumValidPercent}%.`);

  blockers.push(
    ...requiredCoverageBlockers('Browser', browserCoverage, policy.minimumValidPercent),
    ...requiredCoverageBlockers('Device class', deviceCoverage, policy.minimumValidPercent),
    ...requiredCoverageBlockers('Platform', platformCoverage, policy.minimumValidPercent),
    ...requiredCoverageBlockers('Competitive action', actionCoverage, policy.minimumValidPercent),
  );

  if (options.sampleLimitReached) advisories.push('The evidence query reached its 1,000-sample ceiling. Use a shorter window before making an enforcement decision.');
  if (!records.some((record) => stringValue(record.platform) !== 'Unknown')) advisories.push('Older evidence does not include a normalized operating-system family. New samples will populate the platform matrix.');
  advisories.push('Passing this gate permits only a deliberate selected-callable canary. It never enables App Check enforcement automatically.');
  advisories.push('Firestore App Check enforcement remains a later gate after selected callable enforcement succeeds across supported browsers.');

  const sampleCollectionIncomplete =
    totalSamples < policy.minimumTotalSamples ||
    observedDays.size < policy.minimumObservedDays ||
    managerDays.size < policy.minimumManagerDays ||
    browserCoverage.some((item) => item.required && !item.sampleGatePassed) ||
    deviceCoverage.some((item) => item.required && !item.sampleGatePassed) ||
    platformCoverage.some((item) => item.required && !item.sampleGatePassed) ||
    actionCoverage.some((item) => item.required && !item.sampleGatePassed);
  const canaryEligible = blockers.length === 0 && !options.sampleLimitReached;
  const status: AppCheckReadinessStatus = canaryEligible ? 'ready' : sampleCollectionIncomplete ? 'collecting' : 'needs-attention';
  const headline = canaryEligible
    ? 'Ready for a selected-callable App Check canary'
    : status === 'collecting'
      ? 'Continue collecting exact-build App Check evidence'
      : 'Resolve App Check verification gaps before a canary';
  const detail = canaryEligible
    ? 'The exact build meets the documented sample, browser, device, action, and verification gates. Enforcement remains off until an administrator deliberately starts a later canary release.'
    : 'RinkRat remains safely in monitor mode. The blockers below explain exactly what evidence is still missing or unverified.';

  return {
    status,
    headline,
    detail,
    exactBuildId: normalizedBuildId || 'unknown-build',
    totalSamples,
    validSamples,
    missingSamples,
    validPercent,
    observedDayCount: observedDays.size,
    managerDayCount: managerDays.size,
    minimumTotalSamples: policy.minimumTotalSamples,
    minimumObservedDays: policy.minimumObservedDays,
    minimumManagerDays: policy.minimumManagerDays,
    minimumValidPercent: policy.minimumValidPercent,
    browserCoverage,
    deviceCoverage,
    platformCoverage,
    actionCoverage,
    blockers,
    advisories,
    canaryEligible,
    automaticEnforcement: false,
  };
}
