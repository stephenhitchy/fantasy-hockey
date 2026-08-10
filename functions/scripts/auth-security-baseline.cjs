#!/usr/bin/env node

const process = require('node:process');
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const projectArgument = args.find((value) => value.startsWith('--project='));
const projectId = (
  projectArgument?.slice('--project='.length) ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  ''
).trim();

if (!projectId) {
  console.error(
    'Provide --project=YOUR_FIREBASE_PROJECT_ID or set GCLOUD_PROJECT before inspecting Authentication security.',
  );
  process.exit(1);
}

if (apply && process.env.RINKRAT_APPLY_AUTH_SECURITY !== 'APPLY') {
  console.error(
    'Refusing to change Firebase Authentication. Set RINKRAT_APPLY_AUTH_SECURITY=APPLY and run the command again.',
  );
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });
}

function summarize(config) {
  const passwordPolicy = config.passwordPolicyConfig || {};
  const constraints = passwordPolicy.constraints || {};
  const emailPrivacy = config.emailPrivacyConfig || {};
  const multiFactor = config.multiFactorConfig || {};

  return {
    projectId,
    passwordPolicy: {
      enforcementState: passwordPolicy.enforcementState || 'OFF',
      forceUpgradeOnSignin: passwordPolicy.forceUpgradeOnSignin === true,
      minimumLength: constraints.minLength ?? null,
      maximumLength: constraints.maxLength ?? null,
      requireLowercase: constraints.requireLowercase === true,
      requireUppercase: constraints.requireUppercase === true,
      requireNumeric: constraints.requireNumeric === true,
      requireNonAlphanumeric: constraints.requireNonAlphanumeric === true,
    },
    emailEnumerationProtection: {
      enabled: emailPrivacy.enableImprovedEmailPrivacy === true,
    },
    multiFactor: {
      state: multiFactor.state || 'DISABLED',
      factorIds: multiFactor.factorIds || [],
      providerCount: Array.isArray(multiFactor.providerConfigs)
        ? multiFactor.providerConfigs.length
        : 0,
    },
  };
}

async function main() {
  const manager = getAuth().projectConfigManager();
  const before = await manager.getProjectConfig();

  console.log('Current Firebase Authentication security baseline:');
  console.log(JSON.stringify(summarize(before), null, 2));

  if (!apply) {
    console.log('\nInspection only. No Firebase Authentication settings were changed.');
    return;
  }

  await manager.updateProjectConfig({
    passwordPolicyConfig: {
      enforcementState: 'ENFORCE',
      forceUpgradeOnSignin: false,
      constraints: {
        minLength: 12,
        maxLength: 128,
      },
    },
    emailPrivacyConfig: {
      enableImprovedEmailPrivacy: true,
    },
  });

  const after = await manager.getProjectConfig();
  console.log('\nUpdated Firebase Authentication security baseline:');
  console.log(JSON.stringify(summarize(after), null, 2));
  console.log(
    '\nExisting passwords are not silently replaced. Managers encounter the stronger policy when creating or changing a password.',
  );
}

main().catch((error) => {
  console.error('Firebase Authentication security inspection failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
