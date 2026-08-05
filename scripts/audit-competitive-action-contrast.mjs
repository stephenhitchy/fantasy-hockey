import assert from 'node:assert/strict';

function parseHex(hex) {
  const normalized = hex.replace('#', '');
  assert.match(normalized, /^[0-9a-f]{6}$/i, `Invalid hex color: ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

function linearize(channel) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const [red, green, blue] = parseHex(hex).map(linearize);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const brighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

const commit = {
  top: '#fff2a8',
  bottom: '#ffbd24',
  ink: '#111820',
  edge: '#111820',
};

const themes = {
  'Rink Dark': '#0e1116',
  'OLED Black': '#050607',
  'Ice Gray': '#15181d',
  'Light Ice': '#dfe5eb',
};

for (const face of [commit.top, commit.bottom]) {
  const ratio = contrast(face, commit.ink);
  assert.ok(
    ratio >= 4.5,
    `Commit text contrast ${ratio.toFixed(2)}:1 is below 4.5:1 for ${face}.`,
  );
}

for (const [theme, background] of Object.entries(themes)) {
  const faceContrast = Math.min(
    contrast(commit.top, background),
    contrast(commit.bottom, background),
  );
  const edgeContrast = contrast(commit.edge, background);
  const strongestBoundary = Math.max(faceContrast, edgeContrast);

  assert.ok(
    strongestBoundary >= 3,
    `${theme} commit boundary contrast ${strongestBoundary.toFixed(2)}:1 is below 3:1.`,
  );

  console.log(
    `✓ ${theme}: face ${faceContrast.toFixed(2)}:1 · edge ${edgeContrast.toFixed(2)}:1`,
  );
}

console.log('Competitive commit-action contrast audit passed.');
