import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.angular',
  '.firebase',
  'node_modules',
  'dist',
  'coverage',
  'out-tsc',
  'tmp',
  'lib',
]);

const MAX_SCANNED_FILE_BYTES = 2_000_000;

const SECRET_PATTERNS = [
  {
    id: 'private-key-pem',
    description: 'Private-key PEM material',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    id: 'github-token',
    description: 'GitHub personal or application token',
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{36,}\b/,
  },
  {
    id: 'github-fine-grained-token',
    description: 'GitHub fine-grained personal token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{70,}\b/,
  },
  {
    id: 'gitlab-token',
    description: 'GitLab personal access token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack API token',
    pattern: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,}\b/,
  },
  {
    id: 'stripe-live-secret',
    description: 'Stripe live secret key',
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'google-oauth-client-secret',
    description: 'Google OAuth client secret',
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'firebase-app-check-debug-token',
    description: 'Committed Firebase App Check debug token',
    pattern: /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*['"][A-Za-z0-9_-]{20,}['"]/,
  },
];

const SENSITIVE_FILE_EXTENSIONS = new Set(['.pem', '.p12', '.pfx', '.key', '.keystore', '.jks']);

function normalizeRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isIgnoredPath(relativePath) {
  const segments = relativePath.split('/');
  return segments.some((segment) => DEFAULT_EXCLUDED_DIRECTORIES.has(segment));
}

async function walkFiles(root, current = root, collected = []) {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeRelativePath(root, absolutePath);

    if (isIgnoredPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkFiles(root, absolutePath, collected);
      continue;
    }

    if (entry.isFile()) {
      collected.push(relativePath);
    }
  }

  return collected;
}

export async function listScannableFiles(root) {
  try {
    const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return [...new Set(
      output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value) => !isIgnoredPath(value)),
    )].sort();
  } catch {
    return (await walkFiles(root)).sort();
  }
}

function lineNumberForOffset(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

export function scanTextForSecrets(content, relativePath = 'unknown') {
  const findings = [];

  if (
    /"type"\s*:\s*"service_account"/.test(content) &&
    /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/.test(content)
  ) {
    findings.push({
      id: 'google-service-account',
      description: 'Google Cloud service-account JSON with private-key material',
      file: relativePath,
      line: lineNumberForOffset(content, content.indexOf('"private_key"')),
    });
  }

  for (const candidate of SECRET_PATTERNS) {
    const match = candidate.pattern.exec(content);

    if (!match || match.index === undefined) {
      continue;
    }

    findings.push({
      id: candidate.id,
      description: candidate.description,
      file: relativePath,
      line: lineNumberForOffset(content, match.index),
    });
  }

  return findings;
}

export async function scanRepositoryForSecrets(root) {
  const files = await listScannableFiles(root);
  const findings = [];
  let scannedFileCount = 0;

  for (const relativePath of files) {
    if (relativePath === 'scripts/security/secret-scan.mjs') {
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    let metadata;

    try {
      metadata = await stat(absolutePath);
    } catch {
      continue;
    }

    if (!metadata.isFile() || metadata.size > MAX_SCANNED_FILE_BYTES) {
      continue;
    }

    const extension = path.extname(relativePath).toLowerCase();
    if (SENSITIVE_FILE_EXTENSIONS.has(extension)) {
      findings.push({
        id: 'sensitive-key-file',
        description: `Sensitive key-container file (${extension})`,
        file: relativePath,
        line: 1,
      });
      continue;
    }

    let content;
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch {
      continue;
    }

    if (content.includes('\u0000')) {
      continue;
    }

    scannedFileCount += 1;
    findings.push(...scanTextForSecrets(content, relativePath));
  }

  return { scannedFileCount, findings };
}

async function main() {
  const rootArgument = process.argv.find((argument) => argument.startsWith('--root='));
  const root = path.resolve(rootArgument ? rootArgument.slice('--root='.length) : process.cwd());
  const result = await scanRepositoryForSecrets(root);

  if (result.findings.length > 0) {
    console.error(`Secret scan found ${result.findings.length} potential credential issue(s):`);
    for (const finding of result.findings) {
      console.error(`- ${finding.file}:${finding.line} [${finding.id}] ${finding.description}`);
    }
    console.error('Remove the credential, rotate it when it was real, and recommit only a placeholder or public client key.');
    process.exitCode = 1;
    return;
  }

  console.log(`Secret scan passed: ${result.scannedFileCount} text file(s) inspected; no private credential patterns found.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  await main();
}
