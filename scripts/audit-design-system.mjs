import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const tokenPath = path.join(sourceRoot, 'rinkrat-design-tokens.css');
const primitivePath = path.join(sourceRoot, 'rinkrat-shared-primitives.css');
const budgetPath = path.join(root, 'config', 'design-system-budgets.json');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(fullPath) : [fullPath];
    }),
  );
  return nested.flat();
}

function countMatches(text, expression) {
  return text.match(expression)?.length ?? 0;
}

function metricsFor(text) {
  const hexColors = countMatches(text, /#[0-9a-fA-F]{3,8}\b/g);
  const functionalColors = countMatches(text, /\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g);

  return {
    importantDeclarations: countMatches(text, /!important\b/g),
    literalColors: hexColors + functionalColors,
    rootSelectors: countMatches(text, /(^|\n)\s*:root\s*\{/g),
  };
}

const [budgetText, tokenText, primitiveText, allFiles] = await Promise.all([
  readFile(budgetPath, 'utf8'),
  readFile(tokenPath, 'utf8'),
  readFile(primitivePath, 'utf8'),
  walk(sourceRoot),
]);

const budgets = JSON.parse(budgetText);
const cssFiles = allFiles.filter((filePath) => filePath.endsWith('.css'));
const globalCssFiles = cssFiles.filter((filePath) => path.dirname(filePath) === sourceRoot);
const allCss = (await Promise.all(cssFiles.map((filePath) => readFile(filePath, 'utf8')))).join('\n');
const globalCssOutsideTokens = (
  await Promise.all(
    globalCssFiles
      .filter((filePath) => filePath !== tokenPath)
      .map((filePath) => readFile(filePath, 'utf8')),
  )
).join('\n');

const allMetrics = metricsFor(allCss);
const globalOutsideTokenMetrics = metricsFor(globalCssOutsideTokens);
const primitiveMetrics = metricsFor(primitiveText);
const tokenMetrics = metricsFor(tokenText);

const checks = [
  {
    label: 'All CSS !important declarations',
    actual: allMetrics.importantDeclarations,
    maximum: budgets.allCssImportantDeclarations,
  },
  {
    label: 'All CSS literal colors',
    actual: allMetrics.literalColors,
    maximum: budgets.allCssLiteralColors,
  },
  {
    label: 'Global literal colors outside the token file',
    actual: globalOutsideTokenMetrics.literalColors,
    maximum: budgets.globalCssLiteralColorsOutsideTokenFile,
  },
  {
    label: 'Global :root selectors outside the token file',
    actual: globalOutsideTokenMetrics.rootSelectors,
    maximum: budgets.globalRootSelectorsOutsideTokenFile,
  },
  {
    label: 'Shared primitive !important declarations',
    actual: primitiveMetrics.importantDeclarations,
    maximum: budgets.sharedPrimitiveImportantDeclarations,
  },
  {
    label: 'Shared primitive literal colors',
    actual: primitiveMetrics.literalColors,
    maximum: budgets.sharedPrimitiveLiteralColors,
  },
];

console.log('RinkRat design-system audit');
console.log(`  CSS files scanned: ${cssFiles.length}`);
console.log(`  Central token declarations: ${countMatches(tokenText, /--[a-zA-Z0-9_-]+\s*:/g)}`);
console.log(`  Token-file literal colors: ${tokenMetrics.literalColors}`);

let failed = false;
for (const check of checks) {
  const passed = check.actual <= check.maximum;
  console.log(
    `  ${passed ? '✓' : '✗'} ${check.label}: ${check.actual} (budget ${check.maximum})`,
  );
  failed ||= !passed;
}

if (failed) {
  console.error('\nDesign-system debt increased beyond the approved Batch 7A baseline.');
  console.error('Move reusable values into rinkrat-design-tokens.css or reduce legacy overrides before raising a budget.');
  process.exitCode = 1;
}
