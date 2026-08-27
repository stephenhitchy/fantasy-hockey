function boundedText(value, maximumLength = 500) {
  return typeof value === 'string'
    ? value.trim().slice(0, maximumLength)
    : '';
}

export function parseGitStatusPaths(statusOutput) {
  return String(statusOutput ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.length > 3 ? line.slice(3).trim() : line.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export function evaluateCleanDeploySource(input = {}) {
  const revision = boundedText(input.revision, 80);
  const dirtyPaths = parseGitStatusPaths(input.statusOutput);
  const blockers = [];

  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    blockers.push('Git HEAD is not one clean 40-character commit revision.');
  }

  if (dirtyPaths.length > 0) {
    blockers.push(
      `${dirtyPaths.length} tracked or untracked path(s) would make this deployment unreproducible.`,
    );
  }

  return {
    schemaVersion: 1,
    ready: blockers.length === 0,
    revision,
    dirtyPaths,
    blockers,
  };
}
