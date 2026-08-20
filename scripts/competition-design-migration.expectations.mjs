/**
 * Current reviewed competition-surface design contract.
 *
 * Batch 7C.3 established the shared primitives, but later product batches may
 * intentionally replace a page's composition. The audit and tests import this
 * single contract so they cannot drift apart when a reviewed successor ships.
 */
export const COMPETITION_TEMPLATE_EXPECTATIONS = [
  {
    relativePath: 'src/app/features/team/team-settings/team-settings.html',
    label: 'My Team',
    requiredMarkers: [
      'rr-page-shell',
      'rr-stat-grid',
      'rr-list-row',
      'rr-data-panel',
      'rr-dialog',
    ],
    forbiddenMarkers: [],
  },
  {
    relativePath: 'src/app/features/free-agents/free-agents.html',
    label: 'Unified Add / Drop',
    requiredMarkers: [
      'unified-player-page rr-page-shell',
      'unified-player-controls rr-card rr-card--padded',
      'class="rr-field',
      'class="rr-select"',
      'class="unified-player-list"',
      'unified-player-row rr-card',
      'transaction-incoming-row unified-player-row rr-card',
      'transaction-roster-list',
      'transaction-confirmation rr-card rr-card--padded',
      'rr-button--commit',
    ],
    forbiddenMarkers: [
      'replacement-player-card',
      'app-action-sheet',
      'rr-dialog-backdrop',
      'viewport-overlay',
    ],
  },
  {
    relativePath: 'src/app/features/draft/draft-setup/draft-setup.html',
    label: 'Draft Setup',
    requiredMarkers: [
      'rr-page-shell',
      'rr-stat-grid',
      'rr-field',
      'rr-select',
      'rr-list-row',
    ],
    forbiddenMarkers: [],
  },
  {
    relativePath: 'src/app/features/draft/draft-room/draft-room.html',
    label: 'Draft Room',
    requiredMarkers: [
      'rr-page-shell',
      'rr-toolbar',
      'rr-choice-card',
      'rr-list-row',
      'rr-card',
    ],
    forbiddenMarkers: [],
  },
  {
    relativePath: 'src/app/features/cycles/cycle-one/cycle-one.html',
    label: 'Game Center',
    requiredMarkers: [
      'rr-page-shell',
      'rr-card',
      'rr-data-panel',
      'rr-button',
      'rr-state',
    ],
    forbiddenMarkers: [],
  },
];

export const COMPETITION_STYLE_EXPECTATIONS = [
  {
    relativePath: 'src/app/features/team/team-settings/team-settings.css',
    label: 'My Team',
    literalColorBudget: 224,
    importantBudget: 4,
    requiredMarkers: ['--rr-team-migration-color-'],
    forbiddenMarkers: [],
  },
  {
    relativePath: 'src/app/features/free-agents/free-agents.css',
    label: 'Unified Add / Drop',
    literalColorBudget: 8,
    importantBudget: 0,
    requiredMarkers: [],
    forbiddenMarkers: [
      '--rr-free-agents-migration-color-',
      '--rr-game-center-migration-color-',
    ],
  },
  {
    relativePath: 'src/app/features/draft/draft-setup/draft-setup.css',
    label: 'Draft Setup',
    literalColorBudget: 91,
    importantBudget: 0,
    requiredMarkers: ['--rr-draft-setup-migration-color-'],
    forbiddenMarkers: [],
  },
  {
    relativePath: 'src/app/features/draft/draft-room/draft-room.css',
    label: 'Draft Room',
    literalColorBudget: 189,
    importantBudget: 1,
    requiredMarkers: ['--rr-draft-room-migration-color-'],
    forbiddenMarkers: [],
  },
  {
    relativePath: 'src/app/features/cycles/cycle-one/cycle-one.css',
    label: 'Game Center',
    literalColorBudget: 392,
    importantBudget: 1,
    requiredMarkers: [],
    forbiddenMarkers: ['--rr-game-center-migration-color-'],
  },
];
