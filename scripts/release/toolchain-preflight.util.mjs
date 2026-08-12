export function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/, '');
}

export function expectedPackageManagerVersion(packageManager, name = 'npm') {
  const match = String(packageManager ?? '').trim().match(new RegExp(`^${name}@([^\\s]+)$`));
  if (!match?.[1]) {
    throw new Error(`package.json must pin one exact ${name} version through packageManager.`);
  }
  return match[1];
}

export function inspectToolchain({
  expectedNode,
  expectedNpm,
  actualNode,
  actualNpm,
}) {
  const normalized = {
    expectedNode: normalizeVersion(expectedNode),
    expectedNpm: normalizeVersion(expectedNpm),
    actualNode: normalizeVersion(actualNode),
    actualNpm: normalizeVersion(actualNpm),
  };

  const issues = [];
  if (!normalized.expectedNode) {
    issues.push('The project does not define an expected Node version.');
  } else if (normalized.actualNode !== normalized.expectedNode) {
    issues.push(
      `Node ${normalized.expectedNode} is required; current Node is ${normalized.actualNode || 'unknown'}. Run: nvm use ${normalized.expectedNode}`,
    );
  }

  if (!normalized.expectedNpm) {
    issues.push('The project does not define an expected npm version.');
  } else if (normalized.actualNpm !== normalized.expectedNpm) {
    issues.push(
      `npm ${normalized.expectedNpm} is required; current npm is ${normalized.actualNpm || 'unknown'}. Run: npm install -g npm@${normalized.expectedNpm}`,
    );
  }

  return {
    expected: {
      node: normalized.expectedNode,
      npm: normalized.expectedNpm,
    },
    actual: {
      node: normalized.actualNode,
      npm: normalized.actualNpm,
    },
    ok: issues.length === 0,
    issues,
  };
}
