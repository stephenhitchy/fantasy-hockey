import type { ClientPerformanceSnapshot } from '../observability/client-performance-monitor.service';
import type { CompetitiveActionHealthSnapshot } from '../observability/competitive-action-health.util';
import type {
  ReleaseReadinessCheck,
  SeasonLifecycleSimulationResult,
} from './release-readiness.models';
import type {
  ReleaseManifest,
  ReleaseUpdateStatus,
} from './release-manifest.models';

export const INVITE_BETA_VALIDATION_SCHEMA_VERSION = 2;
export const INVITE_BETA_TESTER_LABEL_MAX_LENGTH = 80;
export const INVITE_BETA_DEVICE_LABEL_MAX_LENGTH = 120;
export const INVITE_BETA_NOTE_MAX_LENGTH = 600;

export type InviteBetaValidationStatus = 'untested' | 'pass' | 'attention';

export type InviteBetaValidationGroupId =
  | 'accounts'
  | 'draft'
  | 'scoring'
  | 'roster'
  | 'mobile'
  | 'recovery';

export interface InviteBetaValidationDefinition {
  id: string;
  groupId: InviteBetaValidationGroupId;
  title: string;
  instruction: string;
  evidenceHint: string;
  required: boolean;
}

export interface InviteBetaValidationGroupDefinition {
  id: InviteBetaValidationGroupId;
  label: string;
  description: string;
}

export interface InviteBetaValidationItemState {
  status: InviteBetaValidationStatus;
  note: string;
  updatedAt: string | null;
}

export interface InviteBetaValidationSession {
  schemaVersion: number;
  releaseKey: string;
  releaseLabel: string;
  createdAt: string;
  updatedAt: string;
  testerLabel: string;
  deviceLabel: string;
  items: Record<string, InviteBetaValidationItemState>;
}

export interface InviteBetaValidationGroupView {
  definition: InviteBetaValidationGroupDefinition;
  items: Array<{
    definition: InviteBetaValidationDefinition;
    state: InviteBetaValidationItemState;
  }>;
  requiredCount: number;
  passedRequiredCount: number;
  attentionCount: number;
  untestedCount: number;
}

export interface InviteBetaLaunchGateInput {
  automatedChecks: ReleaseReadinessCheck[];
  simulation: SeasonLifecycleSimulationResult | null;
  manualSession: InviteBetaValidationSession;
  connectionOnline: boolean;
  activeActionCount: number;
  actionErrorCount: number;
  actionUncertainCount: number;
  releaseUpdateAvailable: boolean;
  releaseCheckStatus: ReleaseUpdateStatus;
}

export interface InviteBetaLaunchGate {
  status: 'ready' | 'testing' | 'blocked';
  headline: string;
  detail: string;
  blockers: string[];
  advisories: string[];
  automatedPassedCount: number;
  automatedRequiredCount: number;
  manualPassedCount: number;
  manualRequiredCount: number;
  manualAttentionCount: number;
  manualUntestedCount: number;
  simulationStatus: 'passed' | 'failed' | 'not-run';
}

export interface InviteBetaValidationReportInput {
  releaseLabel: string;
  generatedAt: string;
  session: InviteBetaValidationSession;
  gate: InviteBetaLaunchGate;
  automatedChecks: ReleaseReadinessCheck[];
  simulation: SeasonLifecycleSimulationResult | null;
  clientPerformance: ClientPerformanceSnapshot | null;
  competitiveActions: CompetitiveActionHealthSnapshot | null;
  releaseManifest: ReleaseManifest | null;
  viewport: string;
  browser: string;
}

export const INVITE_BETA_VALIDATION_GROUPS: readonly InviteBetaValidationGroupDefinition[] = [
  {
    id: 'accounts',
    label: 'Accounts and onboarding',
    description: 'Start with clean managers so identity, permissions, and beginner guidance are tested before competition begins.',
  },
  {
    id: 'draft',
    label: 'League and draft',
    description: 'Verify the live room on a phone, including save confirmation, reconnect behavior, queue logic, and Auto-Draft explanations.',
  },
  {
    id: 'scoring',
    label: 'Scoring and matchup windows',
    description: 'Confirm earned points, independent six-game windows, seventh-game rollover, matchup timing, and Game Film transparency.',
  },
  {
    id: 'roster',
    label: 'Roster, waivers, and Injured Reserve',
    description: 'Exercise every competitive roster path, especially immediate versus scheduled moves and team-goalie-unit cleanup.',
  },
  {
    id: 'mobile',
    label: 'Phones, themes, and accessibility',
    description: 'Validate the screen sizes, browsers, visual themes, zoom levels, and overlays managers are most likely to use.',
  },
  {
    id: 'recovery',
    label: 'Recovery, diagnostics, and launch operations',
    description: 'Prove that connectivity loss, support reports, App Check monitoring, and rollback procedures are understood before inviting testers.',
  },
] as const;

export const INVITE_BETA_VALIDATION_DEFINITIONS: readonly InviteBetaValidationDefinition[] = [
  {
    id: 'neutral-account-onboarding',
    groupId: 'accounts',
    title: 'Create a new neutral RinkRat account',
    instruction: 'Register without choosing an NHL favorite, complete Training Camp, sign out, and sign back in.',
    evidenceHint: 'RinkRat colors persist, no permission error appears, and Training Camp completion remains saved.',
    required: true,
  },
  {
    id: 'identity-theme-switching',
    groupId: 'accounts',
    title: 'Switch between RinkRat and NHL identities',
    instruction: 'Save RinkRat colors, an NHL team, and at least one alternate identity from Account Settings.',
    evidenceHint: 'The selected identity and readable theme survive a reload and public manager displays remain correct.',
    required: true,
  },
  {
    id: 'second-manager-join',
    groupId: 'accounts',
    title: 'Join with a second manager account',
    instruction: 'Use a separate account and browser session to join through the league code.',
    evidenceHint: 'The manager receives member access without commissioner-only controls or raw permission errors.',
    required: true,
  },
  {
    id: 'draft-settings-save',
    groupId: 'draft',
    title: 'Save and reload the draft time',
    instruction: 'Save a future draft time and immediately attempt to navigate away while the server write is pending.',
    evidenceHint: 'Navigation stays protected until confirmation, then the exact date and time remain after reload.',
    required: true,
  },
  {
    id: 'complete-mobile-draft',
    groupId: 'draft',
    title: 'Complete a full phone-width draft',
    instruction: 'Draft through Players, Queue, and Roster views at a phone width, including at least one Auto-Draft selection.',
    evidenceHint: 'Every pick confirms once, the clock stays compact, and Auto-Draft explains why its player was chosen.',
    required: true,
  },
  {
    id: 'draft-reconnect',
    groupId: 'draft',
    title: 'Recover the Draft Room after connectivity loss',
    instruction: 'Background the browser or disable the connection, then return while the draft is active.',
    evidenceHint: 'Competitive actions stay blocked until all live draft listeners are current again.',
    required: true,
  },
  {
    id: 'score-refresh-completion',
    groupId: 'scoring',
    title: 'Advance scoring and confirm the control recovers',
    instruction: 'Advance one historical day or request a live refresh and watch scores, players, and the testing control.',
    evidenceHint: 'The saved scoring update appears and the button unlocks when Firestore reports ready instead of waiting on a stale HTTP request.',
    required: true,
  },
  {
    id: 'independent-window-rollover',
    groupId: 'scoring',
    title: 'Verify independent seventh-game rollover',
    instruction: 'Advance until one roster slot finishes six games before the rest of the roster.',
    evidenceHint: 'That slot opens the next matchup and its seventh team game counts there while other slots may remain behind.',
    required: true,
  },
  {
    id: 'game-film-audit',
    groupId: 'scoring',
    title: 'Audit one complete Game Film breakdown',
    instruction: 'Open a player with played, missed, and upcoming games and compare the detail page with Game Center.',
    evidenceHint: 'The saved total, category contributions, exact six games, and missed-appearance explanation agree.',
    required: true,
  },
  {
    id: 'matchup-finish-date',
    groupId: 'scoring',
    title: 'Check the matchup finish date',
    instruction: 'Review an active matchup and a future matchup containing a scheduled roster change.',
    evidenceHint: 'The displayed date follows the latest sixth game across the exact roster-slot assignments.',
    required: true,
  },
  {
    id: 'immediate-add-drop',
    groupId: 'roster',
    title: 'Complete an immediate add/drop',
    instruction: 'Choose an untouched legal roster slot and complete the Transaction Workbench flow.',
    evidenceHint: 'The correct player replaces the old player once, the roster listener confirms it, and no blurred or locked screen remains.',
    required: true,
  },
  {
    id: 'scheduled-add-drop',
    groupId: 'roster',
    title: 'Complete a scheduled add/drop',
    instruction: 'Queue a move behind an already-started six-game roster window and advance through its boundary.',
    evidenceHint: 'The timing message names the delaying player and the incoming player owns the first legal future window.',
    required: true,
  },
  {
    id: 'waiver-claim',
    groupId: 'roster',
    title: 'Submit and process a waiver claim',
    instruction: 'Submit a claim from a non-first priority and process the waiver period.',
    evidenceHint: 'Priority, winner, dropped player, timing, and transaction history all remain correct.',
    required: true,
  },
  {
    id: 'injured-reserve-roundtrip',
    groupId: 'roster',
    title: 'Move a player through Injured Reserve',
    instruction: 'Move an eligible player to IR, then activate them to a legal active or bench destination.',
    evidenceHint: 'Only legal actions appear and the six-game assignment is not rewritten retroactively.',
    required: true,
  },
  {
    id: 'goalie-unit-roundtrip',
    groupId: 'roster',
    title: 'Add and remove a team goalie unit',
    instruction: 'Replace the active goalie unit, then remove or replace the newly added unit.',
    evidenceHint: 'Both operations confirm without an endless cursor, fuzzy backdrop, duplicate unit, or stale scheduled move.',
    required: true,
  },
  {
    id: 'phone-browser-matrix',
    groupId: 'mobile',
    title: 'Test the core phone-width matrix',
    instruction: 'Run representative flows at 320, 390, and 430 pixels in Mobile Safari and Mobile Chrome.',
    evidenceHint: 'Draft, Game Center, My Team, Available Players, and dialogs remain readable without unintended horizontal page scrolling.',
    required: true,
  },
  {
    id: 'themes-zoom-motion',
    groupId: 'mobile',
    title: 'Test themes, 200% zoom, and reduced motion',
    instruction: 'Check Rink Dark, Light Ice, OLED Black, neutral RinkRat, and a light or gold NHL theme.',
    evidenceHint: 'Text and final-action controls remain visible; zoom and reduced motion do not clip required controls.',
    required: true,
  },
  {
    id: 'overlay-viewport',
    groupId: 'mobile',
    title: 'Open every important overlay inside the viewport',
    instruction: 'Test Draft Join Now, roster confirmations, transaction comparison, and account or league safety dialogs after scrolling deeply.',
    evidenceHint: 'The dialog appears immediately in view, background scroll locks, and closing restores the prior position.',
    required: true,
  },
  {
    id: 'desktop-utility-layout',
    groupId: 'mobile',
    title: 'Check desktop utility layouts',
    instruction: 'Review Draft, Game Center, Transaction Workbench, Projection Lab, and Release Readiness on desktop.',
    evidenceHint: 'Tables and cards stack or scroll intentionally without overlap, cut-off controls, or tiny essential text.',
    required: true,
  },
  {
    id: 'offline-action-blocking',
    groupId: 'recovery',
    title: 'Verify offline competitive-action blocking',
    instruction: 'Disable connectivity before attempting a draft pick, roster change, waiver claim, and replay advance.',
    evidenceHint: 'No write is sent, the reason is clear, and actions unlock only after the short live-data revalidation period.',
    required: true,
  },
  {
    id: 'diagnostics-feedback',
    groupId: 'recovery',
    title: 'Copy diagnostics and submit feedback',
    instruction: 'Copy Beta Diagnostics and send one disposable feedback report from a signed-in account.',
    evidenceHint: 'The report reaches Admin Center with a reference ID and excludes private league, player, score, roster, and account data.',
    required: true,
  },
  {
    id: 'app-check-monitoring',
    groupId: 'recovery',
    title: 'Confirm App Check monitor traffic',
    instruction: 'Enable the production App Check client and review verified request metrics before any enforcement is enabled.',
    evidenceHint: 'Normal desktop, mobile, login, draft, roster, scoring, feedback, and deletion traffic is verified in Firebase Console.',
    required: true,
  },
  {
    id: 'rollback-rehearsal',
    groupId: 'recovery',
    title: 'Record and rehearse the rollback path',
    instruction: 'Keep the known-good commit and deployment order, then confirm the prior Hosting release can be selected or redeployed.',
    evidenceHint: 'The rollback does not require editing Firestore documents and the release build ID is recorded.',
    required: true,
  },
  {
    id: 'injury-email-flow',
    groupId: 'recovery',
    title: 'Verify one opt-in injury email',
    instruction: 'Enable injury email alerts for a disposable manager, trigger or test one eligible rostered OUT-player alert, then disable the preference.',
    evidenceHint: 'The email arrives once, excludes bench-only injuries, and a delivery failure never blocks scoring or roster actions.',
    required: true,
  },
  {
    id: 'deletion-safety',
    groupId: 'recovery',
    title: 'Test disposable league and account deletion',
    instruction: 'Delete a disposable commissioner league and a separate disposable manager account using the required typed confirmations.',
    evidenceHint: 'Deletion removes the intended data, preserves unrelated leagues, and never leaves the browser in a locked or ambiguous state.',
    required: true,
  },
  {
    id: 'capacity-boundary-recorded',
    groupId: 'recovery',
    title: 'Record the invite-beta capacity boundary',
    instruction: 'Run the balanced, draft-night, and game-night capacity reports and review docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md.',
    evidenceHint: 'The launch is explicitly limited to a controlled cohort, and the queued league-scoring migration is recorded for future scale work.',
    required: false,
  },
  {
    id: 'fresh-league-lifecycle',
    groupId: 'recovery',
    title: 'Finish one completely fresh league lifecycle',
    instruction: 'Use new accounts from league creation through draft, scoring, roster moves, standings, playoffs, and final placement.',
    evidenceHint: 'No step depends on leftover data from an older test league and ordinary-user consoles remain clean.',
    required: true,
  },
] as const;

const DEFINITION_BY_ID = new Map(
  INVITE_BETA_VALIDATION_DEFINITIONS.map((definition) => [definition.id, definition]),
);

function limitText(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, maximumLength);
}

function cleanText(value: unknown, maximumLength: number): string {
  return limitText(value, maximumLength)
    .replace(/\s+/g, ' ')
    .trim();
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeStatus(value: unknown): InviteBetaValidationStatus {
  return value === 'pass' || value === 'attention' ? value : 'untested';
}

function createEmptyItemState(): InviteBetaValidationItemState {
  return {
    status: 'untested',
    note: '',
    updatedAt: null,
  };
}

export function createInviteBetaValidationSession(
  releaseKey: string,
  releaseLabel: string,
  nowIso = new Date().toISOString(),
): InviteBetaValidationSession {
  return {
    schemaVersion: INVITE_BETA_VALIDATION_SCHEMA_VERSION,
    releaseKey: cleanText(releaseKey, 180),
    releaseLabel: cleanText(releaseLabel, 120),
    createdAt: nowIso,
    updatedAt: nowIso,
    testerLabel: '',
    deviceLabel: '',
    items: Object.fromEntries(
      INVITE_BETA_VALIDATION_DEFINITIONS.map((definition) => [
        definition.id,
        createEmptyItemState(),
      ]),
    ),
  };
}

export function normalizeInviteBetaValidationSession(
  value: unknown,
  releaseKey: string,
  releaseLabel: string,
  nowIso = new Date().toISOString(),
): InviteBetaValidationSession {
  const cleanReleaseKey = cleanText(releaseKey, 180);
  const cleanReleaseLabel = cleanText(releaseLabel, 120);

  if (!value || typeof value !== 'object') {
    return createInviteBetaValidationSession(cleanReleaseKey, cleanReleaseLabel, nowIso);
  }

  const candidate = value as Partial<InviteBetaValidationSession>;

  if (
    cleanText(candidate.releaseKey, 180) !== cleanReleaseKey ||
    cleanText(candidate.releaseLabel, 120) !== cleanReleaseLabel
  ) {
    return createInviteBetaValidationSession(cleanReleaseKey, cleanReleaseLabel, nowIso);
  }

  const itemSource = candidate.items && typeof candidate.items === 'object'
    ? candidate.items
    : {};
  const items: Record<string, InviteBetaValidationItemState> = {};

  for (const definition of INVITE_BETA_VALIDATION_DEFINITIONS) {
    const rawState = (itemSource as Record<string, unknown>)[definition.id];

    if (!rawState || typeof rawState !== 'object') {
      items[definition.id] = createEmptyItemState();
      continue;
    }

    const state = rawState as Partial<InviteBetaValidationItemState>;
    items[definition.id] = {
      status: normalizeStatus(state.status),
      note: cleanText(state.note, INVITE_BETA_NOTE_MAX_LENGTH),
      updatedAt: isIsoTimestamp(state.updatedAt) ? state.updatedAt : null,
    };
  }

  return {
    schemaVersion: INVITE_BETA_VALIDATION_SCHEMA_VERSION,
    releaseKey: cleanReleaseKey,
    releaseLabel: cleanReleaseLabel,
    createdAt: isIsoTimestamp(candidate.createdAt) ? candidate.createdAt : nowIso,
    updatedAt: isIsoTimestamp(candidate.updatedAt) ? candidate.updatedAt : nowIso,
    testerLabel: cleanText(candidate.testerLabel, INVITE_BETA_TESTER_LABEL_MAX_LENGTH),
    deviceLabel: cleanText(candidate.deviceLabel, INVITE_BETA_DEVICE_LABEL_MAX_LENGTH),
    items,
  };
}

export function updateInviteBetaValidationIdentity(
  session: InviteBetaValidationSession,
  field: 'testerLabel' | 'deviceLabel',
  value: string,
  nowIso = new Date().toISOString(),
): InviteBetaValidationSession {
  const maximumLength = field === 'testerLabel'
    ? INVITE_BETA_TESTER_LABEL_MAX_LENGTH
    : INVITE_BETA_DEVICE_LABEL_MAX_LENGTH;

  return {
    ...session,
    [field]: limitText(value, maximumLength),
    updatedAt: nowIso,
  };
}

export function updateInviteBetaValidationItem(
  session: InviteBetaValidationSession,
  itemId: string,
  update: Partial<Pick<InviteBetaValidationItemState, 'status' | 'note'>>,
  nowIso = new Date().toISOString(),
): InviteBetaValidationSession {
  if (!DEFINITION_BY_ID.has(itemId)) {
    return session;
  }

  const current = session.items[itemId] ?? createEmptyItemState();
  const nextStatus = update.status === undefined
    ? current.status
    : normalizeStatus(update.status);
  const nextNote = update.note === undefined
    ? current.note
    : limitText(update.note, INVITE_BETA_NOTE_MAX_LENGTH);

  return {
    ...session,
    updatedAt: nowIso,
    items: {
      ...session.items,
      [itemId]: {
        status: nextStatus,
        note: nextNote,
        updatedAt: nowIso,
      },
    },
  };
}

export function buildInviteBetaValidationGroups(
  session: InviteBetaValidationSession,
): InviteBetaValidationGroupView[] {
  return INVITE_BETA_VALIDATION_GROUPS.map((group) => {
    const items = INVITE_BETA_VALIDATION_DEFINITIONS
      .filter((definition) => definition.groupId === group.id)
      .map((definition) => ({
        definition,
        state: session.items[definition.id] ?? createEmptyItemState(),
      }));
    const requiredItems = items.filter((item) => item.definition.required);

    return {
      definition: group,
      items,
      requiredCount: requiredItems.length,
      passedRequiredCount: requiredItems.filter((item) => item.state.status === 'pass').length,
      attentionCount: items.filter((item) => item.state.status === 'attention').length,
      untestedCount: items.filter((item) => item.state.status === 'untested').length,
    };
  });
}

export function calculateInviteBetaLaunchGate(
  input: InviteBetaLaunchGateInput,
): InviteBetaLaunchGate {
  const requiredDefinitions = INVITE_BETA_VALIDATION_DEFINITIONS.filter(
    (definition) => definition.required,
  );
  const manualPassedCount = requiredDefinitions.filter(
    (definition) => input.manualSession.items[definition.id]?.status === 'pass',
  ).length;
  const manualAttentionCount = requiredDefinitions.filter(
    (definition) => input.manualSession.items[definition.id]?.status === 'attention',
  ).length;
  const manualUntestedCount = requiredDefinitions.length - manualPassedCount - manualAttentionCount;
  const automatedRequiredChecks = input.automatedChecks.filter(
    (check) => check.requiredForLiveLaunch,
  );
  const automatedPassedCount = automatedRequiredChecks.filter(
    (check) => check.level === 'pass',
  ).length;
  const blockers: string[] = [];
  const advisories: string[] = [];
  let hasHardFailure = false;

  for (const check of automatedRequiredChecks) {
    if (check.level === 'pass') {
      continue;
    }

    blockers.push(`${check.label}: ${check.detail}`);
    hasHardFailure ||= check.level === 'fail';
  }

  if (input.simulation === null) {
    blockers.push('Run the deterministic full-season simulator for this release candidate.');
  } else if (!input.simulation.passed) {
    blockers.push('The deterministic full-season simulator has at least one failed invariant.');
    hasHardFailure = true;
  }

  if (manualAttentionCount > 0) {
    blockers.push(`${manualAttentionCount} required manual validation item${manualAttentionCount === 1 ? '' : 's'} need attention.`);
    hasHardFailure = true;
  }

  if (manualUntestedCount > 0) {
    blockers.push(`${manualUntestedCount} required manual validation item${manualUntestedCount === 1 ? '' : 's'} remain untested.`);
  }

  if (input.releaseUpdateAvailable) {
    blockers.push('This browser tab is not running the currently deployed build. Reload RinkRat and repeat any affected checks.');
    hasHardFailure = true;
  } else if (input.releaseCheckStatus === 'error') {
    advisories.push('The deployed-build freshness check is currently unavailable. Verify the build fingerprint before inviting managers.');
  } else if (input.releaseCheckStatus === 'idle' || input.releaseCheckStatus === 'checking') {
    advisories.push('Wait for the deployed-build freshness check before making the final launch decision.');
  }

  if (!input.connectionOnline) {
    blockers.push('This device is offline. Reconnect before making a launch decision.');
    hasHardFailure = true;
  }

  if (input.activeActionCount > 0) {
    blockers.push(`${input.activeActionCount} competitive operation${input.activeActionCount === 1 ? ' is' : 's are'} still active in this browser.`);
    hasHardFailure = true;
  }

  if (input.actionErrorCount > 0 || input.actionUncertainCount > 0) {
    advisories.push(
      `Review ${input.actionErrorCount} failed and ${input.actionUncertainCount} uncertain competitive operation${input.actionErrorCount + input.actionUncertainCount === 1 ? '' : 's'} from this browser session before inviting managers.`,
    );
  }

  if (blockers.length === 0) {
    return {
      status: 'ready',
      headline: 'Ready for a small invite-beta cohort',
      detail: 'Automated safeguards, the full-season simulation, and every required manual workflow have passed for this release candidate.',
      blockers,
      advisories,
      automatedPassedCount,
      automatedRequiredCount: automatedRequiredChecks.length,
      manualPassedCount,
      manualRequiredCount: requiredDefinitions.length,
      manualAttentionCount,
      manualUntestedCount,
      simulationStatus: 'passed',
    };
  }

  return {
    status: hasHardFailure ? 'blocked' : 'testing',
    headline: hasHardFailure ? 'Launch blockers need attention' : 'Invite-beta validation is still in progress',
    detail: hasHardFailure
      ? 'Resolve the failed or attention items before adding real managers.'
      : 'Continue the required tests. A new release candidate intentionally starts a fresh validation board.',
    blockers,
    advisories,
    automatedPassedCount,
    automatedRequiredCount: automatedRequiredChecks.length,
    manualPassedCount,
    manualRequiredCount: requiredDefinitions.length,
    manualAttentionCount,
    manualUntestedCount,
    simulationStatus: input.simulation === null
      ? 'not-run'
      : input.simulation.passed
        ? 'passed'
        : 'failed',
  };
}

export function createInviteBetaValidationReport(
  input: InviteBetaValidationReportInput,
): Record<string, unknown> {
  return {
    schemaVersion: INVITE_BETA_VALIDATION_SCHEMA_VERSION,
    reportType: 'rinkrat-invite-beta-validation',
    releaseKey: input.session.releaseKey,
    releaseLabel: cleanText(input.releaseLabel, 120),
    generatedAt: input.generatedAt,
    build: input.releaseManifest,
    tester: {
      label: input.session.testerLabel || null,
      deviceLabel: input.session.deviceLabel || null,
      browser: cleanText(input.browser, 120) || 'Unknown',
      viewport: cleanText(input.viewport, 40) || 'Unknown',
    },
    launchGate: input.gate,
    automatedChecks: input.automatedChecks.map((check) => ({
      id: check.id,
      category: check.category,
      label: check.label,
      level: check.level,
      requiredForLiveLaunch: check.requiredForLiveLaunch,
      detail: check.detail,
    })),
    lifecycleSimulation: input.simulation
      ? {
          passed: input.simulation.passed,
          passedCount: input.simulation.passedCount,
          totalCount: input.simulation.totalCount,
          failedChecks: input.simulation.checks
            .filter((check) => !check.passed)
            .map((check) => ({ id: check.id, stage: check.stage, label: check.label })),
        }
      : null,
    manualValidation: INVITE_BETA_VALIDATION_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      items: INVITE_BETA_VALIDATION_DEFINITIONS
        .filter((definition) => definition.groupId === group.id)
        .map((definition) => {
          const state = input.session.items[definition.id] ?? createEmptyItemState();
          return {
            id: definition.id,
            title: definition.title,
            required: definition.required,
            status: state.status,
            note: state.note || null,
            updatedAt: state.updatedAt,
          };
        }),
    })),
    clientPerformance: input.clientPerformance,
    competitiveActions: input.competitiveActions,
    privacy: {
      automaticallyExcluded: [
        'league identifiers',
        'matchup identifiers',
        'player identifiers and names',
        'scores and roster contents',
        'email addresses',
        'raw Firestore documents',
      ],
      manualNotesIncluded: true,
    },
  };
}
