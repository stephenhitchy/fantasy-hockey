#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const configPath = path.join(projectRoot, 'src/environments/app-check.config.ts');
const args = process.argv.slice(2);

function valueAfter(flag) {
  const inline = args.find((value) => value.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }

  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? '' : '';
}

const disable = args.includes('--disable');
const siteKey = valueAfter('--site-key').trim();
const debugEnabled = args.includes('--local-debug');

if (!disable && !/^[A-Za-z0-9_-]{20,250}$/.test(siteKey)) {
  console.error(
    'Provide the public reCAPTCHA Enterprise site key with --site-key="...", or use --disable.',
  );
  process.exitCode = 1;
  process.exit();
}

let source = await fs.readFile(configPath, 'utf8');
source = source
  .replace(/enabled:\s*(?:true|false)/, `enabled: ${disable ? 'false' : 'true'}`)
  .replace(
    /recaptchaEnterpriseSiteKey:\s*'[^']*'/,
    `recaptchaEnterpriseSiteKey: '${disable ? '' : siteKey}'`,
  )
  .replace(
    /localDebugTokenEnabled:\s*(?:true|false)/,
    `localDebugTokenEnabled: ${debugEnabled ? 'true' : 'false'}`,
  );

await fs.writeFile(configPath, source);

console.log(disable
  ? 'Firebase App Check client disabled in src/environments/app-check.config.ts.'
  : 'Firebase App Check monitor client configured. Enforcement remains a separate Firebase Console decision.');

if (debugEnabled) {
  console.log('Local debug-token discovery is enabled only for localhost. Never ship a registered debug token.');
}
