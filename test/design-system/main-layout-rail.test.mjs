import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const layoutPath = path.join(
  process.cwd(),
  'src/app/layouts/main-layout/main-layout.css',
);

function ruleBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing ${selector} rule.`);
  const end = css.indexOf('\n}', start);
  assert.notEqual(end, -1, `Unclosed ${selector} rule.`);
  return css.slice(start, end);
}

test('keeps the authenticated page rail quiet and theme-safe', async () => {
  const css = await readFile(layoutPath, 'utf8');
  const rail = ruleBody(css, '.main-content::after');

  assert.match(rail, /width:\s*2px;/, 'The page rail should remain a slim guide.');
  assert.match(
    rail,
    /background:\s*color-mix\(in srgb, var\(--border-soft\) 88%, var\(--user-team-primary\)\);/,
    'The page rail should use a mostly neutral semantic border with restrained team identity.',
  );
  assert.doesNotMatch(
    rail,
    /box-shadow\s*:/,
    'The page rail must not rebuild full-height secondary and tertiary color stripes.',
  );
});
