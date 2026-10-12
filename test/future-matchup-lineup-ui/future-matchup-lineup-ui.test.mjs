import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

const componentPath = 'src/app/features/team/team-settings/team-settings.ts';
const templatePath = 'src/app/features/team/team-settings/team-settings.html';

test('My Team keeps the current scoreboard read-only and edits future overlapping matchups', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(template, /id="lineup-planner-heading">Lineups<\/h2>/);
  assert.match(
    template,
    /class="current-matchup-card rr-card rr-card--padded lineup-planner-card"/,
  );
  assert.match(
    template,
    /@if \(selectedFutureLineupIsCurrent\)[\s\S]*?scoreboard-row lineup-current-scoreboard/,
  );
  assert.match(template, /getCurrentMatchupStatusText\(\)/);
  assert.match(template, /getMatchupScore\(matchup, viewedOwnerId\(\)\)/);
  assert.match(template, /getMatchupScore\(matchup, currentOpponentOwnerId\(\)\)/);
  assert.match(template, /@if \(futureLineupEditorVisible\)[\s\S]*?lineup-editor-grid/);
  assert.match(component, /return option\.timing === 'future'/);
  assert.match(component, /Use the roster board below for legal current-matchup moves/);
  assert.doesNotMatch(
    component,
    /selectedCycleNumber\s*<=\s*this\.getCurrentFutureLineupCycleNumber\(\)/,
  );
  assert.match(component, /selectedCycleNumber === 1/);
  assert.match(
    component,
    /if \(this\.isSelectedFutureLineupCurrent\(\)\)[\s\S]*?Choose a future matchup to plan ahead/,
  );
});

test('matchup and slot choices use native labeled controls with mobile shared primitives', async () => {
  const [template, componentStyles, sharedStyles, tokens] = await Promise.all([
    read(templatePath),
    read('src/app/features/team/team-settings/team-settings.css'),
    read('src/rinkrat-shared-primitives.css'),
    read('src/rinkrat-design-tokens.css'),
  ]);

  assert.match(template, /<label class="rr-label" for="lineup-matchup-select">Matchup<\/label>/);
  assert.match(
    template,
    /<select[\s\S]*?id="lineup-matchup-select"[\s\S]*?\(ngModelChange\)="selectFutureLineupCycle\(\$event\)"/,
  );
  assert.match(template, /class="lineup-matchup-picker team-name-form rr-field-group"/);
  assert.match(
    template,
    /class="lineup-editor-grid fantasy-position-slots defense-slots ir-activation-target-list"/,
  );
  assert.match(template, /class="lineup-planner-actions rr-dialog__actions"/);
  assert.doesNotMatch(template, /class="lineup-planner-actions ir-activation-dialog-actions/);
  assert.match(
    componentStyles,
    /@media \(max-width: 640px\)[\s\S]*?\.team-name-form > div[\s\S]*?flex-direction: column/,
  );
  assert.match(
    componentStyles,
    /@media \(max-width: 680px\)[\s\S]*?\.defense-slots[\s\S]*?grid-template-columns: 1fr/,
  );
  assert.match(
    sharedStyles,
    /@media \(max-width: 640px\)[\s\S]*?\.rr-dialog__actions[\s\S]*?flex-direction: column-reverse/,
  );
  assert.match(tokens, /--rr-control-min-height: 44px/);
  assert.match(tokens, /--rr-touch-target: 44px/);
});

test('slot timing distinguishes exact, projected, and pending NHL date evidence', async () => {
  const [component, template, utility] = await Promise.all([
    read(componentPath),
    read(templatePath),
    read('src/app/core/team/future-matchup-lineup.util.ts'),
  ]);

  assert.match(
    component,
    /resolveFutureMatchupSlotDateState\(\{[\s\S]*?assetKey,[\s\S]*?savedWindow,[\s\S]*?projectedGames/,
  );
  assert.match(component, /dateState\.source === 'saved'[\s\S]*?'Exact start'/);
  assert.match(component, /dateState\.source === 'projected'[\s\S]*?'Nominal NHL block'/);
  assert.doesNotMatch(component, /label: 'Calculating start date/);
  assert.match(utility, /label: 'Pending'/);
  assert.match(utility, /label: `Begins \$\{formatIsoDate\(projectedStart, input\.locale\)\}`/);
  assert.doesNotMatch(utility, /label: 'Start date pending'/);
  assert.doesNotMatch(utility, /label: `Nominal NHL block begins/);
  assert.match(component, /return `\$\{startDate\.eyebrow\}: \$\{startDate\.label\}\.`/);
  assert.match(template, /class\.rr-badge--success.*startDate\.confidence === 'saved'/);
  assert.match(template, /class\.rr-badge--warning.*startDate\.confidence === 'projected'/);
  assert.match(template, /class\.rr-badge--info.*startDate\.confidence === 'pending'/);
  assert.match(template, /<time \[attr\.datetime\]="startDate\.dateTime">/);
  assert.match(
    template,
    /@if \(startDate\.dateTime\)[\s\S]*?<time[\s\S]*?@else[\s\S]*?<strong>\{\{ startDate\.label \}\}<\/strong>/,
  );
  assert.match(template, /NHL block dates are nominal pre-materialization/);
  assert.match(template, /exact starts may follow\s+six-game\s+boundaries/);
  assert.doesNotMatch(component, /targetStartsAtMs|resolvedAtMs/);
});

test('the editor limits candidates, preserves occupied slots, and validates immutable plan slots', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(component, /buildFutureMatchupLineupCandidates\(roster, cycleNumber\)/);
  assert.match(
    component,
    /isFutureMatchupCandidateCompatible\(candidate, slot\.position, slot\.slotId\)/,
  );
  assert.match(
    component,
    /validateFutureMatchupLineupDraft\(\{[\s\S]*?slots: this\.buildFutureLineupSlotInputs\(\),[\s\S]*?plan: this\.selectedFutureLineupPlan\(\),[\s\S]*?windows: this\.futureLineupWindows\(\)/,
  );
  assert.match(template, /@if \(!row\.slot\.asset\) \{\s*<option \[ngValue\]="''">Open<\/option>/);
  assert.match(
    template,
    /\[disabled\]="[\s\S]*?row\.locked[\s\S]*?futureLineupLoading\(\)[\s\S]*?futureLineupSaving\(\)/,
  );
  assert.match(component, /plannedSlot\.resolution !== 'planned'/);
  assert.match(template, /getFutureLineupFallbackAssetLabel\(row\.slot\)/);
  assert.match(component, /Other planned slots can still be edited/);
  assert.match(component, /The lineup boundary for this matchup has passed/);
  assert.match(
    component,
    /buildFutureMatchupProjectedLineup\(\{[\s\S]*?plans: this\.futureLineupPlans\(\),[\s\S]*?baseCycleNumber: this\.getCurrentFutureLineupCycleNumber\(\)/,
  );
  assert.doesNotMatch(component, /Partially started|Started · locked/);
});

test('bounded reads and mutations expose loading, retry, stale-response, and spectator-safe states', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(component, /loadFutureMatchupLineupOptionContext\(leagueId, this\.teams\(\)\)/);
  assert.match(
    component,
    /this\.isOwnTeam\(\)[\s\S]*?listFutureMatchupLineupPlans\(leagueId\)[\s\S]*?Promise\.resolve/,
  );
  assert.match(
    component,
    /loadFutureMatchupOwnerWindows\([\s\S]*?this\.leagueId,[\s\S]*?cycleNumber,[\s\S]*?ownerId/,
  );
  assert.match(component, /timingGeneration !== this\.futureLineupTimingGeneration/);
  assert.match(component, /mutationGeneration !== this\.futureLineupMutationGeneration/);
  assert.match(component, /isFutureMatchupLineupRevisionConflict\(error\)/);
  assert.match(
    component,
    /\? pendingMutation\.requestId\s*: createFutureMatchupLineupRequestId\(\)/,
  );
  assert.match(component, /'Retry save'/);
  assert.match(component, /'Retry clear'/);
  assert.doesNotMatch(component, /listenToFutureMatchupLineup/);

  assert.match(
    template,
    /\[attr\.aria-busy\]="futureLineupLoading\(\) \|\| futureLineupSaving\(\)"/,
  );
  assert.match(template, /futureLineupInitialLoadingState[\s\S]*?>Loading</);
  assert.match(template, /\(click\)="retryFutureLineupError\(\)"/);
  assert.match(template, /getFutureLineupErrorRetryLabel\(\)/);
  assert.match(template, /loadFutureLineupTimingEvidence\(\)[\s\S]*?>\s*Retry\s*</);
  assert.match(component, /this\.futureLineupWindowsConfirmed\.set\(true\)/);
  assert.match(
    component,
    /if \(!this\.futureLineupWindowsConfirmed\(\)\) \{[\s\S]*?Retry the date check before editing/,
  );
  assert.match(
    component,
    /incompleteScheduleTeams[\s\S]*?stable NHL game schedule is incomplete[\s\S]*?futureLineupTimingError\.set/,
  );
  assert.match(template, /@if \(isOwnTeam\(\)\)[\s\S]*?\(click\)="saveFutureLineup\(\)"/);
  assert.match(template, /\(click\)="resetFutureLineupDraft\(\)"/);
  assert.match(template, /\(click\)="clearFutureLineup\(\)"/);
  assert.match(component, /This future lineup is read-only\. Only its manager can make changes/);
});

test('full snapshots, fresh authority checks, stable retries, and dirty navigation are explicit', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(component, /'Unsaved lineup preview'/);
  assert.match(
    component,
    /\(this\.futureLineupDirty\(\) \|\| !this\.selectedFutureLineupPlan\(\)\)/,
  );
  assert.match(component, /'Save full lineup'/);
  assert.match(
    component,
    /Promise\.all\(\[[\s\S]*?listFutureMatchupLineupPlans\(this\.leagueId\)[\s\S]*?loadFutureMatchupOwnerWindows\(this\.leagueId, cycleNumber, ownerId\)/,
  );
  assert.match(
    component,
    /authorityChanged[\s\S]*?Review the refreshed assignments and dates, then save again/,
  );
  assert.match(
    component,
    /projectedSlot\.locked[\s\S]*?claimedAssetKeys\.has\(priorDraftAssetKey\)/,
  );
  assert.match(
    component,
    /pendingFutureLineupMutation\?\.operation === 'save'[\s\S]*?await this\.saveFutureLineup\(\)/,
  );
  assert.match(
    component,
    /pendingFutureLineupMutation\?\.operation === 'clear'[\s\S]*?await this\.clearFutureLineup\(\)/,
  );
  assert.match(
    component,
    /canLeaveRosterPage\(\): boolean \{\s*return !this\.isRosterOperationPending\(\) && !this\.futureLineupDirty\(\)/,
  );
  assert.match(
    component,
    /this\.roster\.set\(roster\);[\s\S]*?refreshFutureLineupAuthorityFromLiveChange\(\)/,
  );
  assert.match(
    component,
    /this\.latestCycle\.set\(cycle\);[\s\S]*?this\.futureLineupOptionCycles\.update[\s\S]*?refreshFutureLineupAuthorityFromLiveChange\(\)/,
  );
  assert.match(
    component,
    /getFutureLineupCycleAuthoritySignature[\s\S]*?Deliberately exclude scoring progress and updatedAt/,
  );
  assert.match(
    component,
    /const cycleAuthorityChanged =[\s\S]*?futureLineupLatestCycleAuthoritySignature[\s\S]*?if \(isOwnTeam && cycleAuthorityChanged/,
  );
  assert.match(
    component,
    /futureLineupAuthorityRefreshPromise &&[\s\S]*?futureLineupAuthorityRefreshKey === refreshKey[\s\S]*?return this\.futureLineupAuthorityRefreshPromise/,
  );
  assert.match(
    component,
    /refreshFutureLineupAuthorityFromLiveChange[\s\S]*?loadFreshFutureLineupAuthority\(cycleNumber\)[\s\S]*?applyFreshFutureLineupAuthority\(authority, true\)/,
  );
  assert.match(template, /futureLineupLoading\(\) \? 'Refreshing…' : 'Refresh'/);
  assert.doesNotMatch(component, /listenToFutureMatchupLineup/);
});

test('unsaved lineup edits cannot be discarded by matchup switching or refresh', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(
    component,
    /selectFutureLineupCycle[\s\S]*?cycleNumber === this\.selectedFutureLineupCycleNumber\(\)[\s\S]*?this\.futureLineupDirty\(\)[\s\S]*?return;/,
  );
  assert.match(
    component,
    /async loadFutureMatchupLineupPlans\(\): Promise<void> \{\s*if \(this\.futureLineupDirty\(\)\) \{\s*return;/,
  );
  assert.match(
    template,
    /id="lineup-matchup-select"[\s\S]*?\[disabled\]="[\s\S]*?futureLineupDirty\(\)[\s\S]*?futureLineupLoading\(\)/,
  );
  assert.match(
    template,
    /class="lineup-refresh-button rr-button rr-button--quiet"[\s\S]*?\[disabled\]="futureLineupDirty\(\) \|\| futureLineupLoading\(\) \|\| futureLineupSaving\(\)"/,
  );
  assert.match(template, /id="lineup-unsaved-lineup-note"/);
  assert.match(template, /Save or reset before you switch, refresh, or leave/);
});

test('lineup choices stay read-only while refreshed plan authority is in flight', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(
    component,
    /setFutureLineupAssignment[\s\S]*?this\.futureLineupLoading\(\)[\s\S]*?this\.futureLineupSaving\(\)[\s\S]*?return;/,
  );
  assert.match(
    template,
    /class="rr-field lineup-slot-select"[\s\S]*?\[disabled\]="[\s\S]*?futureLineupLoading\(\)[\s\S]*?futureLineupSaving\(\)/,
  );
});
