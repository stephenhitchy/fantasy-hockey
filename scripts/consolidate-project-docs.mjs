import { appendFile, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const destination = resolve(root, 'docs/RINKRAT_PROJECT_DOCUMENTATION.md');
const entries = await readdir(root, { withFileTypes: true });
const candidates = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => name.endsWith('.txt') || /^BATCH_.*_MANUAL_TEST_CHECKLIST\.md$/i.test(name))
  .sort((first, second) => first.localeCompare(second));

if (candidates.length === 0) {
  console.log('Project documentation is already consolidated.');
  process.exit(0);
}

let addition = '\n\n# Newly consolidated project notes\n';
for (const name of candidates) {
  const path = resolve(root, name);
  const content = await readFile(path, 'utf8');
  const fence = name.endsWith('.txt') ? '```text\n' : '';
  const fenceClose = name.endsWith('.txt') ? '\n```' : '';
  addition += `\n\n## ${name}\n\n${fence}${content.trim()}${fenceClose}\n`;
}

await appendFile(destination, addition, 'utf8');
await Promise.all(candidates.map((name) => unlink(resolve(root, name))));
console.log(`Consolidated ${candidates.length} loose documentation files into docs/RINKRAT_PROJECT_DOCUMENTATION.md.`);
