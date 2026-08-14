import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_GLOBAL_HEADERS = new Map([
  ['X-Content-Type-Options', /\bnosniff\b/i],
  ['Referrer-Policy', /strict-origin-when-cross-origin/i],
  ['Permissions-Policy', /camera=\(\).*microphone=\(\).*geolocation=\(\)/i],
  ['X-Frame-Options', /^DENY$/i],
  ['Strict-Transport-Security', /max-age=31536000/i],
  ['Content-Security-Policy-Report-Only', /default-src 'self'/i],
]);

const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "frame-src",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "trusted-types angular angular#bundler firebase-js-sdk",
  "require-trusted-types-for 'script'",
  "report-uri /security/csp-report",
];

function headerMap(headers) {
  const result = new Map();
  for (const entry of headers ?? []) {
    if (typeof entry?.key === 'string' && typeof entry?.value === 'string') {
      result.set(entry.key.toLowerCase(), entry.value);
    }
  }
  return result;
}

export function auditHostingSecurityHeaders(firebaseConfig) {
  const findings = [];
  const hosting = firebaseConfig?.hosting;
  const globalRule = Array.isArray(hosting?.headers)
    ? hosting.headers.find((entry) => entry?.source === '**')
    : null;

  if (!globalRule) {
    return ['Firebase Hosting has no global ** security-header rule.'];
  }

  const headers = headerMap(globalRule.headers);

  for (const [name, pattern] of REQUIRED_GLOBAL_HEADERS) {
    const value = headers.get(name.toLowerCase());
    if (!value) {
      findings.push(`Missing ${name}.`);
      continue;
    }
    if (!pattern.test(value)) {
      findings.push(`${name} does not match the approved baseline.`);
    }
  }

  if (headers.has('content-security-policy')) {
    findings.push('Content-Security-Policy enforcement was enabled before the report-only review gate completed.');
  }

  const csp = headers.get('content-security-policy-report-only') ?? '';

  const rewrites = Array.isArray(hosting?.rewrites) ? hosting.rewrites : [];
  const reportRouteIndex = rewrites.findIndex((entry) => (
    entry?.source === '/security/csp-report' &&
    entry?.function?.functionId === 'collectCspReport'
  ));
  const catchAllIndex = rewrites.findIndex((entry) => entry?.source === '**');

  if (reportRouteIndex < 0) {
    findings.push('Missing /security/csp-report Hosting rewrite.');
  } else if (catchAllIndex >= 0 && reportRouteIndex > catchAllIndex) {
    findings.push('/security/csp-report must appear before the Hosting catch-all rewrite.');
  }
  for (const directive of REQUIRED_CSP_DIRECTIVES) {
    if (!csp.includes(directive)) {
      findings.push(`Report-only CSP is missing: ${directive}`);
    }
  }

  if (!csp.includes('https://www.google.com/recaptcha/')) {
    findings.push('Report-only CSP does not allow the reCAPTCHA Enterprise script/frame origin.');
  }
  if (!csp.includes('https://fonts.googleapis.com') || !csp.includes('https://fonts.gstatic.com')) {
    findings.push('Report-only CSP does not account for the currently hosted Google Fonts styles/fonts.');
  }
  if (!csp.includes('https://assets.nhle.com')) {
    findings.push('Report-only CSP does not allow NHL image assets.');
  }

  return findings;
}

async function auditConfiguredHeaders() {
  const configPath = path.resolve(process.cwd(), 'firebase.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const findings = auditHostingSecurityHeaders(config);

  if (findings.length > 0) {
    console.error('Firebase Hosting security-header configuration needs attention:');
    findings.forEach((finding) => console.error(`- ${finding}`));
    process.exitCode = 1;
    return;
  }

  console.log('Firebase Hosting security-header configuration passed: HSTS and CSP report-only are present; CSP enforcement remains off.');
}

async function auditLiveHeaders(url) {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: {
      'User-Agent': 'RinkRat-Security-Header-Audit/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Live header request returned HTTP ${response.status} for ${response.url}.`);
  }

  const findings = [];
  for (const [name, pattern] of REQUIRED_GLOBAL_HEADERS) {
    const value = response.headers.get(name);
    if (!value) {
      findings.push(`Live response is missing ${name}.`);
    } else if (!pattern.test(value)) {
      findings.push(`Live ${name} does not match the approved baseline.`);
    }
  }

  if (response.headers.has('content-security-policy')) {
    findings.push('Live response is enforcing CSP before the report-only review gate is complete.');
  }

  if (findings.length > 0) {
    console.error(`Live security-header audit needs attention for ${response.url}:`);
    findings.forEach((finding) => console.error(`- ${finding}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Live security-header audit passed for ${response.url}.`);
}

const urlArgument = process.argv.find((argument) => argument.startsWith('--url='));

try {
  if (urlArgument) {
    await auditLiveHeaders(urlArgument.slice('--url='.length));
  } else {
    await auditConfiguredHeaders();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
