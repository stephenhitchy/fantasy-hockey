import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { evaluateCleanDeploySource } from './clean-deploy-source.util.mjs';

const execFile = promisify(execFileCallback);

async function git(args) {
  const { stdout } = await execFile('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });

  return stdout.trimEnd();
}

async function main() {
  let revision = '';
  let statusOutput = '';

  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    revision = await git(['rev-parse', 'HEAD']);
    statusOutput = await git([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
  } catch (error) {
    console.error('RinkRat clean-deployment guard could not inspect this Git repository.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const result = evaluateCleanDeploySource({ revision, statusOutput });

  if (!result.ready) {
    console.error('RinkRat blocked this Firebase deployment because the source is not reproducible.');
    for (const blocker of result.blockers) {
      console.error(`- ${blocker}`);
    }
    if (result.dirtyPaths.length > 0) {
      console.error('Commit, intentionally discard, or ignore these paths before deploying:');
      for (const path of result.dirtyPaths.slice(0, 25)) {
        console.error(`  - ${path}`);
      }
      if (result.dirtyPaths.length > 25) {
        console.error(`  - ...and ${result.dirtyPaths.length - 25} more`);
      }
    }
    console.error('Then rerun the complete release gate, rebuild from the clean commit, and deploy the exact targeted resources.');
    process.exitCode = 1;
    return;
  }

  console.log(`RinkRat clean-deployment guard passed: ${result.revision}.`);
}

await main();
