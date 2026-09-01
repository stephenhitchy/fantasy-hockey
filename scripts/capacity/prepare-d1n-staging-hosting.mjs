import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const D1N_STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
export const D1N_STAGING_HOSTING_CONFIG_PATH = '.d1n-staging.firebase.json';

const ROOT = new URL('../../', import.meta.url);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

export function buildD1nStagingHostingConfig(sourceConfig) {
  const root = asRecord(sourceConfig);
  const sourceHosting = asRecord(root?.hosting);

  if (!sourceHosting || sourceHosting.target !== 'app') {
    throw new Error('The source Firebase Hosting target must remain app.');
  }

  if (
    sourceHosting.public !== 'dist/fantasy-hockey/browser' ||
    !Array.isArray(sourceHosting.ignore) ||
    !Array.isArray(sourceHosting.headers) ||
    !Array.isArray(sourceHosting.rewrites)
  ) {
    throw new Error('The source Firebase Hosting contract is incomplete.');
  }

  const applicationRewrites = sourceHosting.rewrites.filter((rewrite) => {
    const value = asRecord(rewrite);
    return typeof value?.destination === 'string';
  });

  if (
    applicationRewrites.length !== 1 ||
    applicationRewrites[0]?.source !== '**' ||
    applicationRewrites[0]?.destination !== '/index.html'
  ) {
    throw new Error('The staging config requires one exact Angular application rewrite.');
  }

  return {
    $schema: root?.$schema,
    hosting: {
      site: D1N_STAGING_PROJECT_ID,
      public: sourceHosting.public,
      ignore: sourceHosting.ignore,
      rewrites: applicationRewrites,
      headers: sourceHosting.headers,
      predeploy: [
        'npm --prefix "$PROJECT_DIR" run release:verify-clean-deploy-source',
        'npm --prefix "$PROJECT_DIR" run build:staging',
        'npm --prefix "$PROJECT_DIR" run release:verify-clean-deploy-source',
      ],
    },
  };
}

export async function prepareD1nStagingHostingConfig() {
  const source = JSON.parse(await readFile(new URL('firebase.json', ROOT), 'utf8'));
  const config = buildD1nStagingHostingConfig(source);
  const output = new URL(D1N_STAGING_HOSTING_CONFIG_PATH, ROOT);

  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return {
    projectId: D1N_STAGING_PROJECT_ID,
    outputPath: D1N_STAGING_HOSTING_CONFIG_PATH,
    config,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareD1nStagingHostingConfig()
    .then((result) => {
      console.log(
        `Prepared ${result.outputPath} for the isolated ${result.projectId} Hosting site.`,
      );
      console.log('No Firebase resource was deployed.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
