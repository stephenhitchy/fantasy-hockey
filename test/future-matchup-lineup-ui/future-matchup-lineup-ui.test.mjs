import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const componentPath = 'src/app/features/team/team-settings/team-settings.ts';
const templatePath = 'src/app/features/team/team-settings/team-settings.html';

test('selecting a future matchup reuses the complete roster board instead of a compact slot editor', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(template, /id="lineup-planner-heading">Lineups<\/h2>/);
  assert.match(
    template,
    /<select[\s\S]*?id="lineup-matchup-select"[\s\S]*?\(ngModelChange\)="selectFutureLineupCycle\(\$event\)"/,
  );
  assert.match(
    template,
    /href="#selected-matchup-roster"[\s\S]*?>[\s\S]*?Roster[\s\S]*?<\/a>/,
  );
  assert.match(template, /<section id="selected-matchup-roster" class="roster-section/);
  assert.match(
    template,
    /isSelectedClosestFinalizingMatchup\(\)[\s\S]*?'Roster Board'[\s\S]*?'Matchup ' \+ selectedFutureLineupCycleNumber\(\) \+ ' Roster'/,
  );
  assert.match(template, /@for \(slot of getPositionSlotsForDisplay\(group\.position\)/);
  assert.match(template, /@for \(slot of getPositionSlotsForDisplay\('D'\)/);
  assert.match(template, /@for \(slot of getPositionSlotsForDisplay\('G'\)/);
  assert.doesNotMatch(template, /lineup-editor-grid|lineup-slot-select/);

  const rosterBoard = sourceSection(
    template,
    '<section id="selected-matchup-roster"',
    '\n\n    <app-action-sheet',
  );
  assert.match(
    rosterBoard,
    /!isSelectedFutureLineupCurrent\(\) && futureLineupOwned && selectedFutureLineupPlan\(\)/,
  );
  assert.match(rosterBoard, /class="lineup-planner-actions rr-dialog__actions"/);
  assert.match(rosterBoard, /\(click\)="resetFutureLineupDraft\(\)"/);
  assert.match(rosterBoard, /\[disabled\]="!canResetFutureLineup\(\)"/);
  assert.match(rosterBoard, /\(click\)="clearFutureLineup\(\)"/);
  assert.match(rosterBoard, /\[disabled\]="!canClearFutureLineup\(\)"/);
  assert.match(rosterBoard, /\{\{ getFutureLineupClearLabel\(\) \}\}/);

  assert.match(
    component,
    /const displaySlots = selectedOption[\s\S]*?this\.getFutureRosterDisplaySlots\(\)[\s\S]*?: this\.getPositionSlots\(position\)/,
  );
  assert.match(
    component,
    /buildFutureMatchupProjectedLineup\(\{[\s\S]*?cycleNumber,[\s\S]*?plan: this\.selectedFutureLineupPlan\(\),[\s\S]*?plans: this\.futureLineupPlans\(\),[\s\S]*?windows: this\.futureLineupWindows\(\)/,
  );
});

test('My Team defaults to the earliest unfinished matchup and exposes one unstarted planning matchup', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);
  const allOptions = sourceSection(
    component,
    'private getAllFutureLineupMatchupOptions(): FutureMatchupLineupOption[]',
    '\n\n  getFutureLineupMatchupOptions()',
  );
  const focusedOptions = sourceSection(
    component,
    'getFutureLineupMatchupOptions(): FutureMatchupLineupOption[]',
    '\n\n  private getPrimaryDisplayedMatchupCycleNumber(',
  );
  const primary = sourceSection(
    component,
    'private getPrimaryDisplayedMatchupCycleNumber()',
    '\n\n  private isNextUnstartedFutureLineupOption(',
  );
  const automaticSelection = sourceSection(
    component,
    'private syncDefaultFutureLineupSelection()',
    '\n\n  private resetFutureLineupDraftFromServer(',
  );
  const projectionBase = sourceSection(
    component,
    'private getFutureLineupProjectionBaseCycleNumber()',
    '\n\n  private syncDefaultFutureLineupSelection()',
  );

  assert.match(focusedOptions, /!this\.currentNavigationMatchupResolved\(\)/);
  assert.match(focusedOptions, /this\.currentNavigationMatchupError\(\)/);
  assert.match(focusedOptions, /selectFocusedFutureMatchupLineupOptions\(\{/);
  assert.match(focusedOptions, /primaryCycleNumber: this\.getPrimaryDisplayedMatchupCycleNumber\(\)/);
  assert.match(focusedOptions, /plan\.status !== 'applied'/);
  assert.match(
    focusedOptions,
    /preserveSelected:[\s\S]*?futureLineupSelectionTouched[\s\S]*?futureLineupDirty\(\)[\s\S]*?isRosterOperationPending\(\)/,
  );
  assert.match(primary, /this\.currentNavigationMatchup\(\)/);
  assert.match(primary, /matchup\?\.status === 'active'/);
  assert.match(primary, /matchup\.phase === 'regular_season'/);
  assert.match(allOptions, /currentMatchup\.cycleNumber !== latestCycle\.cycleNumber/);
  assert.match(allOptions, /latestCycle\.status !== 'active'/);
  assert.match(
    component,
    /listenToEarliestUnfinishedOwnerMatchup\([\s\S]*?currentNavigationMatchup\.set\(matchup\)[\s\S]*?currentNavigationMatchupResolved\.set\(true\)/,
  );
  assert.match(
    component,
    /currentNavigationMatchup\.set\(null\)[\s\S]*?currentNavigationMatchupResolved\.set\(false\)[\s\S]*?closest unfinished matchup could not be confirmed/,
  );
  assert.match(projectionBase, /this\.latestCycle\(\)\?\.cycleNumber/);
  assert.match(
    automaticSelection,
    /getPrimaryDisplayedMatchupCycleNumber\(\)[\s\S]*?option\.timing === 'future' && !option\.materialized/,
  );
  assert.match(component, /Current · Matchup \$\{option\.cycleNumber\}/);
  assert.match(component, /Next · Matchup \$\{option\.cycleNumber\}[\s\S]*?Not started/);
  assert.match(component, /hasNextUnstartedMatchup[\s\S]*?No later unstarted matchup is available yet/);
  assert.match(template, /@if \(selectedFutureLineupIsPrimary\)/);
  assert.match(template, /futureLineupSavedPlanNotice/);
  assert.match(template, /isSelectedClosestFinalizingMatchup\(\) \? 'Active Roster'/);
});

test('focused matchup recovery keeps warnings visible and returns cleared exceptions to the default', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);
  const optionLabel = sourceSection(
    component,
    'getFutureLineupMatchupOptionLabel(option: FutureMatchupLineupOption): string',
    '\n\n  get futureLineupMatchupOptions',
  );
  const statusLabel = sourceSection(
    component,
    'getFutureLineupPlanStatusLabel(): string',
    '\n\n  isSelectedFutureLineupCurrent()',
  );
  const clearPlan = sourceSection(
    component,
    'async clearFutureLineup(): Promise<void>',
    '\n\n  async loadFutureLineupTimingEvidence',
  );

  assert.match(optionLabel, /savedPlan\?\.status === 'conflicted'[\s\S]*?Needs attention/);
  assert.match(optionLabel, /savedPlan\?\.status === 'partially-applied'[\s\S]*?Partially locked/);
  assert.match(statusLabel, /plan\?\.status === 'conflicted'[\s\S]*?Needs attention/);
  assert.match(statusLabel, /plan\?\.status === 'partially-applied'[\s\S]*?Partially locked/);
  assert.match(statusLabel, /currentNavigationMatchupError\(\)[\s\S]*?Unavailable/);
  assert.match(clearPlan, /clearedRecoveryOnlyOption/);
  assert.match(
    clearPlan,
    /futureLineupSelectionTouched = false;[\s\S]*?syncDefaultFutureLineupSelection\(\)/,
  );
  assert.notEqual(clearPlan.indexOf('this.futureLineupSaving.set(false)'), -1);
  assert.notEqual(clearPlan.indexOf('this.futureLineupSelectionTouched = false'), -1);
  assert.ok(
    clearPlan.indexOf('this.futureLineupSaving.set(false)') <
      clearPlan.indexOf('this.futureLineupSelectionTouched = false'),
    'a confirmed clear must release the pending guard before resyncing the default selection',
  );
  assert.match(template, /\[class\.status-warning\]="selectedFutureLineupHasCriticalPlanStatus\(\)"/);
});

test('the selected roster board shows exact matchup progress, start evidence, and later planned starts', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(component, /displayCycleNumber: cycleNumber/);
  assert.match(
    component,
    /const selectedWindow =[\s\S]*?window\.rosterSlotId === sourceSlot\.slotId[\s\S]*?futureStartDate: this\.getFutureLineupStartDate\(sourceSlot, asset\)/,
  );
  assert.match(
    component,
    /getRosterSlotCurrentCycleScore\(slot: ActiveRosterSlot\)[\s\S]*?this\.isFutureDisplaySlot\(slot\)[\s\S]*?getSelectedMatchupSlotScoreState\(slot\)\.score/,
  );
  assert.match(
    component,
    /getRosterSlotGameProgress\(slot: ActiveRosterSlot\)[\s\S]*?getSelectedMatchupSlotScoreState\(slot\)[\s\S]*?scoreState\.gamesPlayed/,
  );
  assert.match(
    component,
    /getSelectedMatchupSlotScoreState\(slot: ActiveRosterDisplaySlot\)[\s\S]*?useLiveCurrentScoring: slot\.useLiveCurrentScoring[\s\S]*?selectedWindow: slot\.selectedWindow[\s\S]*?hasPlannedAssignment/,
  );
  assert.match(
    component,
    /resolveFutureMatchupSlotDateState\(\{[\s\S]*?assetKey,[\s\S]*?savedWindow,[\s\S]*?projectedGames/,
  );
  assert.match(component, /dateState\.source === 'saved'[\s\S]*?'Exact start'/);
  assert.match(component, /dateState\.source === 'projected'[\s\S]*?'Nominal NHL block'/);
  assert.match(
    component,
    /getNextFutureLineupAssignmentLabel\([\s\S]*?plan\.cycleNumber > selectedCycleNumber[\s\S]*?Matchup \$\{nextAssignment\.cycleNumber\}/,
  );

  assert.match(template, /@if \(slot\.futureStartDate; as startDate\)/);
  assert.match(template, /class="lineup-slot-start roster-card-start rr-badge"/);
  assert.match(template, /<time \[attr\.datetime\]="startDate\.dateTime">/);
  assert.match(template, /@if \(slot\.nextPlannedAssetLabel\)/);
  assert.match(template, /class="pending-slot-move-pill future-lineup-move-pill"/);
  const laterStarterBeforeAsset = template.match(
    /@if \(slot\.nextPlannedAssetLabel\)[\s\S]{0,240}?@if \(slot\.asset; as asset\)/g,
  ) ?? [];
  assert.equal(
    laterStarterBeforeAsset.length,
    3,
    'Later-start labels must remain visible even when the selected matchup slot is open.',
  );
  assert.match(template, /displayedRosterFilledCount\(\)/);
  assert.match(
    component,
    /displayedRosterFilledCount = computed[\s\S]*?getFutureRosterDisplaySlots\(\)[\s\S]*?slot\.asset !== null/,
  );
  assert.match(
    component,
    /getNextFutureLineupAssignmentLabel\([\s\S]*?sourceSlot\.slotId,[\s\S]*?assetKey \|\| null/,
  );
  assert.match(
    component,
    /const markerStatus:[\s\S]*?state === 'LIVE' \|\| state === 'CRIT'[\s\S]*?hasProjectedNhlGameStarted\(game\)[\s\S]*?'started; exact scoring pending'/,
  );
  assert.doesNotMatch(component, /Unsaved lineup preview/);
  assert.match(component, /selectedOption\?\.timing === 'open'[\s\S]*?'In-progress lineup'/);
  assert.match(component, /'Projected lineup'/);
});

test('every selected cycle keeps its own assignments while exact current slots retain live scoring', async () => {
  const component = await read(componentPath);
  const timingLoad = sourceSection(
    component,
    'async loadFutureLineupTimingEvidence(',
    '\n\n  private getFutureLineupProjectionBaseCycleNumber(',
  );
  const display = sourceSection(
    component,
    'getPositionSlotsForDisplay(',
    '\n\n  private getSelectedRosterDisplaySlot(',
  );

  assert.doesNotMatch(timingLoad, /if \(this\.isSelectedFutureLineupCurrent\(\)\)/);
  assert.match(
    timingLoad,
    /loadFutureMatchupOwnerWindows\(this\.leagueId, cycleNumber, ownerId\)/,
  );
  assert.match(display, /const displaySlots = selectedOption[\s\S]*?getFutureRosterDisplaySlots/);
  assert.match(
    display,
    /resolveSelectedMatchupAssignmentIdentity\(\{[\s\S]*?timing: selectedOption\.timing[\s\S]*?selectedPickAssetKey[\s\S]*?selectedWindowAssetKey[\s\S]*?projectedAssetKey/,
  );
  assert.match(
    display,
    /shouldUseLiveSelectedMatchupScoring\(\{[\s\S]*?timing: selectedOption\.timing[\s\S]*?livePickAssetKey/,
  );
  assert.match(
    display,
    /gameMarkers: useLiveCurrentScoring[\s\S]*?getRosterSlotGameMarkers\(liveDisplaySlot\)[\s\S]*?getFutureRosterSlotGameMarkers/,
  );
  assert.match(
    component,
    /private isFutureDisplaySlot[\s\S]*?Boolean\(this\.getSelectedFutureLineupMatchupOption\(\)\)/,
  );
  const selectedPickLookup = sourceSection(
    component,
    'private getSelectedCycleRosterPick(',
    '\n\n  getRosterSlotScoreSummary(',
  );
  assert.match(
    selectedPickLookup,
    /const exactSelectedPick = this\.futureLineupRosterPicks\(\)\.find\([\s\S]*?if \(exactSelectedPick \|\| !isLatestSelected\)[\s\S]*?this\.cycleRosterPicks\(\)\.find/,
  );
});

test('non-current matchup management offers scoring detail and selected-lineup actions only', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);
  const actions = sourceSection(
    component,
    'readonly rosterManagerActions = computed',
    '\n\n  constructor(',
  );
  const futureBranch = sourceSection(
    actions,
    'if (this.isFutureRosterAction()) {',
    '\n\n      return actions;',
  );

  assert.match(futureBranch, /id: 'view'/);
  assert.match(futureBranch, /id: 'swap-with-bench'/);
  assert.match(futureBranch, /id: 'keep-open'/);
  assert.match(futureBranch, /id: 'start'/);
  assert.doesNotMatch(
    futureBranch,
    /id: '(?:add-drop|drop|move-to-ir|activate-from-ir|move-ir-to-bench)'/,
  );
  assert.match(actions, /return buildRosterManagementActions\(\{/);
  assert.match(
    component,
    /area !== 'ir' && selectedOption[\s\S]*?selectedOption\.cycleNumber/,
  );
  assert.match(
    component,
    /getFutureSwapBenchCandidates\([\s\S]*?position: DraftPosition,[\s\S]*?slot\.asset\.position === position[\s\S]*?eligibleFromCycleNumber/,
  );
  assert.match(
    component,
    /private getFutureSwapActiveTargets\([\s\S]*?!slot\.assignmentPending/,
  );

  const currentOnlyFindPlayerMatches = [
    ...template.matchAll(/openFreeAgentsForRosterSlot\('active', slot\.slotId\)/g),
  ];
  assert.ok(
    currentOnlyFindPlayerMatches.length >= 3,
    'Every empty active-slot Find Player action should stay current-matchup-only.',
  );
  for (const match of currentOnlyFindPlayerMatches) {
    const guard = template.slice(Math.max(0, (match.index ?? 0) - 500), match.index);
    assert.match(guard, /isOwnTeam\(\)[\s\S]*?isSelectedFutureLineupCurrent\(\)/);
    assert.match(guard, /!slot\.assignmentPending/);
  }
  assert.match(template, /openRosterManager\('active', slot\.slotId\)/);
  assert.match(template, /openRosterManager\('bench', slot\.slotId\)/);
});

test('current matchup management selects authority per slot and compatible position', async () => {
  const component = await read(componentPath);
  const openManager = sourceSection(
    component,
    'openRosterManager(area: RosterManagementArea, slotId: string)',
    '\n\n  isFutureRosterAction()',
  );
  const authority = sourceSection(
    component,
    'private shouldUseSelectedMatchupRosterAuthorityForAction(',
    '\n\n  private getFutureSwapBenchCandidates(',
  );

  assert.match(
    openManager,
    /shouldUseSelectedMatchupRosterAuthorityForAction\([\s\S]*?selectedOption,[\s\S]*?area,[\s\S]*?slotId/,
  );
  assert.match(authority, /managedAssetPosition: managedAsset\?\.position \?\? null/);
  assert.match(authority, /selectedActiveSlots: this\.getFutureRosterDisplaySlots\(\)/);
  assert.match(authority, /physicalActiveSlots: roster\.activeSlots/);
  assert.match(
    component,
    /isSelectedFutureLineupCurrent\(\)[\s\S]*?!this\.rosterActionUsesSelectedMatchupAuthority\(\)[\s\S]*?current matchup is managed through the roster board/,
  );
});

test('captured matchup actions never downgrade to physical-roster authority', async () => {
  const component = await read(componentPath);
  const routeCheck = sourceSection(
    component,
    'isFutureRosterAction(): boolean',
    '\n\n  private shouldUseSelectedMatchupRosterAuthorityForAction(',
  );
  const selection = sourceSection(
    component,
    'selectFutureLineupCycle(value:',
    '\n\n  async loadFutureMatchupLineupPlans(',
  );
  const automaticSelection = sourceSection(
    component,
    'private syncDefaultFutureLineupSelection()',
    '\n\n  private resetFutureLineupDraftFromServer(',
  );

  assert.match(
    routeCheck,
    /rosterActionUsesSelectedMatchupAuthority\(\) && cycleNumber/,
  );
  assert.doesNotMatch(routeCheck, /getFutureLineupMatchupOptions/);
  assert.match(selection, /isRosterOperationPending\(\)[\s\S]*?closeAllRosterManagementState\(\)/);
  assert.match(
    automaticSelection,
    /isRosterOperationPending\(\) \|\| this\.hasPendingFutureLineupSwap\(\)[\s\S]*?closeAllRosterManagementState\(\)/,
  );
});

test('a materialized slow slot keeps its projected starter and expected date without inventing score', async () => {
  const component = await read(componentPath);
  const display = sourceSection(
    component,
    'private getFutureRosterDisplaySlots()',
    '\n\n  private getSelectedRosterDisplaySlot(',
  );
  const startDate = sourceSection(
    component,
    'getFutureLineupStartDate(',
    '\n\n  getFutureLineupStartAriaLabel(',
  );
  const scoreState = sourceSection(
    component,
    'private getSelectedMatchupSlotScoreState(',
    '\n\n  private isFutureDisplaySlot(',
  );

  assert.match(
    display,
    /assignmentIdentity\.source === 'selected-pick'[\s\S]*?selectedPick\?\.asset[\s\S]*?assignmentIdentity\.source === 'selected-window'/,
  );
  assert.match(
    display,
    /resolveSelectedMatchupSlotExpectation\(\{[\s\S]*?expectedRosterSlotIdsByOwner:[\s\S]*?physicalSlotHasAsset: Boolean\(sourceSlot\.asset\)/,
  );
  assert.match(
    display,
    /assignmentPending:[\s\S]*?assignmentIdentity\.source === 'pending'[\s\S]*?selectedOption\.timing === 'open'/,
  );
  assert.match(startDate, /const projectedAssetKey = this\.getRosterAssetKey\(projectedAsset\) \|\| null/);
  assert.match(
    startDate,
    /savedWindow\?\.assetKey \?\?[\s\S]*?projectedAssetKey/,
  );
  assert.match(
    component,
    /getFutureLineupStartAriaLabel\(slot: ActiveRosterSlot\)[\s\S]*?slot\.futureStartDate[\s\S]*?getFutureLineupStartDate\(slot, slot\.asset\)/,
  );
  assert.match(scoreState, /materialized: this\.getSelectedFutureLineupMatchupOption\(\)\?\.materialized === true/);
});

test('future swaps exclude a current bench player already projected into the selected lineup', async () => {
  const component = await read(componentPath);
  const candidates = sourceSection(
    component,
    'private getFutureSwapBenchCandidates(',
    '\n\n  private getFutureSwapActiveTargets(',
  );
  const targets = sourceSection(
    component,
    'private getFutureSwapActiveTargets(',
    '\n\n  private isFutureLineupProjectedStarter(',
  );
  const projectedStarter = sourceSection(
    component,
    'private isFutureLineupProjectedStarter(',
    '\n\n  private getFutureProjectedActiveAssetKeys(',
  );

  assert.match(candidates, /const projectedAssetKeys = this\.getFutureProjectedActiveAssetKeys\(\)/);
  assert.match(
    candidates,
    /!projectedAssetKeys\.has\(this\.getRosterAssetKey\(slot\.asset\)\)/,
  );
  assert.match(targets, /!incomingAssetKey \|\| this\.isFutureLineupProjectedStarter\(asset\)/);
  assert.match(targets, /return \[\]/);
  assert.match(
    targets,
    /this\.getFutureDisplayPositionSlots\(asset\.position\)\.filter\([\s\S]*?this\.getRosterAssetKey\(slot\.asset\) !== incomingAssetKey/,
  );
  assert.match(
    projectedStarter,
    /assetKey && this\.getFutureProjectedActiveAssetKeys\(\)\.has\(assetKey\)/,
  );
  assert.match(
    component,
    /const matchingSlots = this\.getFutureSwapActiveTargets\(asset\)[\s\S]*?already scheduled to start in the selected matchup/,
  );
  assert.equal(
    component.match(/\? this\.getFutureSwapActiveTargets\(benchSlot\.asset\)/g)?.length,
    2,
    'Both future swap opening and target refresh must apply the same no-op filter.',
  );
});

test('a planned swap can be reversed and a planned open-slot promotion can be removed', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);
  const candidates = sourceSection(
    component,
    'private getFutureSwapBenchCandidates(',
    '\n\n  private isFuturePlannedOpenSlotAssignment(',
  );

  assert.match(candidates, /plannedSlot\?\.resolution !== 'planned'/);
  assert.match(candidates, /plannedSlot\.assetKey !== projectedAssetKey/);
  assert.match(candidates, /physicalActiveSlot\.asset/);
  assert.match(candidates, /plannedAssetBenchSlots\.length !== 1/);
  assert.match(
    component,
    /preferredFutureTarget[\s\S]*?getFutureSwapBenchCandidates\([\s\S]*?preferredFutureTarget\.slotId/,
  );
  assert.match(
    component,
    /getPendingBenchSwapSlot[\s\S]*?restrictedTarget[\s\S]*?getFutureSwapBenchCandidates/,
  );
  assert.match(component, /id: 'keep-open'/);
  assert.match(component, /label: 'Change Matchup Starter'/);
  assert.match(
    component,
    /isFuturePlannedReversalCandidate\([\s\S]*?physicalActiveSlot\?\.asset[\s\S]*?physicalBenchSlot\?\.asset[\s\S]*?plannedSlot\?\.resolution === 'planned'/,
  );
  assert.match(component, /Current roster starter · Restore for this matchup/);
  assert.match(
    template,
    /getFutureSwapCandidateSourceLabel\(benchSlot, activeSwapSlot\.slotId\)/,
  );
  assert.match(
    template,
    /getFutureSwapCandidateSourceLabel\([\s\S]*?benchSwapSlot,[\s\S]*?benchSwapTargetSlotId\(\)/,
  );
  assert.match(
    component,
    /clearFuturePlannedOpenSlot[\s\S]*?futureLineupDraftAssignments\.update[\s\S]*?\[activeSlotId\]: null[\s\S]*?saveFutureLineup\(\)/,
  );
});

test('selected matchup detail links use that cycle and projected-only cards use player intel', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);
  const detail = sourceSection(
    component,
    'private hasSelectedMatchupScoringDetail(',
    '\n\n  openRosterAssetIntel(',
  );

  assert.match(
    detail,
    /selectedOption\?\.materialized[\s\S]*?displaySlot\.selectedWindow \|\| displaySlot\.selectedPick \|\| displaySlot\.useLiveCurrentScoring/,
  );
  assert.match(
    detail,
    /selectedOption && !this\.hasSelectedMatchupScoringDetail\(activeSlotId\)[\s\S]*?this\.openRosterAssetIntel\(asset\)/,
  );
  assert.match(
    detail,
    /const cycleNumber = selectedOption\?\.cycleNumber \?\? this\.latestCycle\(\)\?\.cycleNumber/,
  );
  assert.match(template, /openRosterAssetDetail\(asset, slot\.slotId\)/);
  assert.match(
    template,
    /handleRosterIdentityKeydown\(\$event, asset, 'matchup', slot\.slotId\)/,
  );
});

test('future move timing is immediate only when the selected assignments are untouched', async () => {
  const [component, template] = await Promise.all([read(componentPath), read(templatePath)]);

  assert.match(
    component,
    /const appliesToSelected = requestedCycleNumber === effectiveCycleNumber/,
  );
  assert.match(component, /Both players are still untouched in Matchup/);
  assert.match(component, /This lineup change starts in the next fair matchup window/);
  assert.match(component, /Matchup \$\{requestedCycleNumber\} stays unchanged/);
  assert.match(
    component,
    /const outgoingStarted = activeSlot\.asset[\s\S]*?hasFutureMatchupWindowStarted\(selectedWindow\)[\s\S]*?const incomingStarted = this\.hasProjectedNhlBlockStarted\(benchSlot\.asset\)/,
  );
  assert.match(
    component,
    /const predictedEffectiveCycleNumber = outgoingStarted \|\| incomingStarted[\s\S]*?Math\.max\(requestedCycleNumber \+ 1, earliestEligibleCycle\)[\s\S]*?: earliestEligibleCycle/,
  );
  assert.match(
    component,
    /state === 'LIVE'[\s\S]*?state === 'FINAL'[\s\S]*?state === 'OFF'[\s\S]*?startMilliseconds <= Date\.now\(\)/,
  );

  assert.match(template, /\[class\.lineup-swap-timing--ready\]/);
  assert.match(template, /\[class\.lineup-swap-timing--waiting\]/);
  assert.match(template, /<strong>\{\{ timingMessage\.headline \}\}<\/strong>/);
  assert.match(template, /<p>\{\{ timingMessage\.detail \}\}<\/p>/);
  assert.match(template, /The server checks both roster spots again when you confirm\./);
});

test('Matchup 1 stays read-only until its season authority is materialized', async () => {
  const component = await read(componentPath);
  const blockReason = sourceSection(
    component,
    'getFutureLineupEditBlockReason(): string',
    '\n\n  getFutureLineupValidationMessage(',
  );

  assert.match(
    blockReason,
    /selectedCycleNumber === 1[\s\S]*?!selectedOption\.materialized[\s\S]*?Matchup 1 lineup changes become available when the season matchup starts\./,
  );
});

test('an open future starter slot uses the same server-timed bench promotion path', async () => {
  const [component, service, models, utility] = await Promise.all([
    read(componentPath),
    read('src/app/core/team/future-matchup-lineup.service.ts'),
    read('src/app/core/team/future-matchup-lineup.models.ts'),
    read('src/app/core/team/future-matchup-lineup.util.ts'),
  ]);
  const expectedCycle = sourceSection(
    component,
    'private getExpectedFutureSwapCycleNumber()',
    '\n\n  closeRosterManager(',
  );
  const confirmation = sourceSection(
    component,
    'private async confirmFutureMatchupBenchSwap(',
    '\n\n  beginIrBenchActivation(',
  );

  assert.match(component, /getFutureSwapActiveTargets[\s\S]*?!slot\.asset/);
  assert.match(component, /const outgoingAssetKey = this\.getRosterAssetKey\(activeSlot\?\.asset\) \|\| null/);
  assert.match(
    expectedCycle,
    /const outgoingStarted = activeSlot\.asset[\s\S]*?: selectedWindow[\s\S]*?\? null[\s\S]*?: false/,
  );
  assert.match(confirmation, /const outgoingAssetKey = this\.getRosterAssetKey\(targetSlot\.asset\) \|\| null/);
  assert.doesNotMatch(
    confirmation,
    /!expectedEffectiveCycleNumber \|\|[\s\S]{0,80}!outgoingAssetKey/,
  );
  assert.match(confirmation, /expectedOutgoingAssetKey: outgoingAssetKey/);
  assert.match(models, /expectedOutgoingAssetKey: string \| null/);
  assert.match(utility, /outgoingAssetKey: string \| null/);
  assert.match(
    service,
    /input\.expectedOutgoingAssetKey === null[\s\S]*?\? null[\s\S]*?requireNonEmptyString\(input\.expectedOutgoingAssetKey, 'outgoing asset'\)/,
  );
});

test('future timing loads every eligible roster-team schedule before offering a swap', async () => {
  const component = await read(componentPath);
  const timingLoad = sourceSection(
    component,
    'async loadFutureLineupTimingEvidence(',
    '\n\n  private getFutureLineupProjectionBaseCycleNumber(',
  );

  assert.match(
    timingLoad,
    /Promise\.all\(\[[\s\S]*?loadFutureMatchupOwnerWindows[\s\S]*?getCycleOwnerRosterPicksOnce/,
  );
  assert.match(
    timingLoad,
    /const selectedPickAssets = this\.futureLineupRosterPicks\(\)/,
  );
  assert.match(
    timingLoad,
    /const assignmentAssets = Object\.values\(this\.futureLineupDraftAssignments\(\)\)/,
  );
  assert.match(
    timingLoad,
    /const eligibleBenchAssets = \(this\.roster\(\)\?\.benchSlots \?\? \[\]\)/,
  );
  assert.match(
    timingLoad,
    /const eligibleActiveAssets = \(this\.roster\(\)\?\.activeSlots \?\? \[\]\)/,
  );
  assert.match(
    timingLoad,
    /eligibleFromCycleNumber \?\? 1\) <= cycleNumber/,
  );
  assert.match(
    timingLoad,
    /\.\.\.selectedPickAssets,[\s\S]*?\.\.\.assignmentAssets,[\s\S]*?\.\.\.eligibleActiveAssets,[\s\S]*?\.\.\.eligibleBenchAssets,[\s\S]*?loadFutureMatchupNhlSchedules\(teamAbbreviations, season\)/,
  );
});

test('stale-tab signatures include the exact selected plan even before the latest active cycle', async () => {
  const component = await read(componentPath);
  const signature = sourceSection(
    component,
    'private getFutureLineupAuthoritySignature(',
    '\n\n  private async loadFreshFutureLineupAuthority(',
  );

  assert.match(
    signature,
    /selectRelevantFutureMatchupAuthorityPlans\([\s\S]*?plans,[\s\S]*?baseCycleNumber,[\s\S]*?cycleNumber/,
  );
  assert.match(signature, /revision: plan\.revision/);
  assert.match(signature, /assetKey: slot\.assetKey/);
});

test('future swap confirmation refreshes authority, verifies exact assets, and keeps a stable retry id', async () => {
  const [component, service, models] = await Promise.all([
    read(componentPath),
    read('src/app/core/team/future-matchup-lineup.service.ts'),
    read('src/app/core/team/future-matchup-lineup.models.ts'),
  ]);
  const confirmation = sourceSection(
    component,
    'private async confirmFutureMatchupBenchSwap(',
    '\n\n  beginIrBenchActivation(',
  );

  assert.match(
    confirmation,
    /await this\.loadFreshFutureLineupAuthority\(requestedCycleNumber\)/,
  );
  assert.match(
    confirmation,
    /\(this\.getRosterAssetKey\(refreshedTarget\.asset\) \|\| null\) !== outgoingAssetKey[\s\S]*?this\.getRosterAssetKey\(refreshedBench\.asset\) !== incomingAssetKey[\s\S]*?refreshedEffectiveCycleNumber !== expectedEffectiveCycleNumber/,
  );
  assert.match(
    confirmation,
    /pendingMutation\?\.operation === 'swap'[\s\S]*?pendingMutation\.requestId[\s\S]*?: createFutureMatchupLineupRequestId\(\)/,
  );
  assert.match(
    confirmation,
    /const swapRequest: SwapFutureMatchupLineupRequest = \{[\s\S]*?requestedCycleNumber,[\s\S]*?expectedEffectiveCycleNumber,[\s\S]*?expectedOutgoingAssetKey: outgoingAssetKey,[\s\S]*?expectedIncomingAssetKey: incomingAssetKey[\s\S]*?swapFutureMatchupLineup\(swapRequest\)/,
  );
  assert.match(confirmation, /result\.mode === 'immediate'/);
  assert.match(confirmation, /incoming player’s expected start now follows Matchup/);
  assert.match(
    confirmation,
    /isFutureMatchupLineupRevisionConflict\(error\) \|\|[\s\S]*?isFutureMatchupLineupSwapTimingConflict\(error\)/,
  );

  assert.match(models, /operation: 'swap'/);
  assert.match(models, /expectedEffectiveCycleNumber: number/);
  assert.match(models, /expectedOutgoingAssetKey: string \| null/);
  assert.match(models, /expectedIncomingAssetKey: string/);
  assert.match(models, /\| 'swap-timing-conflict'/);
  assert.match(service, /result\.operation !== 'swap'/);
  assert.match(service, /result\.effectiveStart\?\.evidence !== 'lineup-plan-boundary'/);
  assert.match(service, /plan: normalizeFutureMatchupLineupPlanView\(result\.plan\)/);
  assert.match(
    service,
    /isFutureMatchupLineupSwapTimingConflict\(error: unknown\)[\s\S]*?details\.reason === 'swap-timing-conflict'/,
  );
});

test('an uncertain swap closes its dialog and retries only the immutable original request', async () => {
  const component = await read(componentPath);
  const confirmation = sourceSection(
    component,
    'private async confirmFutureMatchupBenchSwap(',
    '\n\n  private async retryPendingFutureLineupSwap(',
  );
  const retry = sourceSection(
    component,
    'private async retryPendingFutureLineupSwap(',
    '\n\n  beginIrBenchActivation(',
  );

  assert.match(confirmation, /swapRequest: SwapFutureMatchupLineupRequest/);
  assert.match(confirmation, /swapRequest,[\s\S]*?swapFutureMatchupLineup\(swapRequest\)/);
  assert.match(
    confirmation,
    /failure\.outcome === 'uncertain'[\s\S]*?clearBenchSwapDialogState\(\)[\s\S]*?rosterActionCycleNumber\.set\(null\)/,
  );
  assert.match(retry, /const request = pendingMutation\?\.operation === 'swap'/);
  assert.match(retry, /swapFutureMatchupLineup\(request\)/);
  assert.doesNotMatch(retry, /getPendingBenchSwapSlot|getBenchSwapTargetSlots/);
  assert.match(component, /hasPendingFutureLineupSwap\(\)/);
});

test('server timing conflicts advance the exact pairing after refresh without leaking overrides', async () => {
  const component = await read(componentPath);
  const confirmation = sourceSection(
    component,
    'private async confirmFutureMatchupBenchSwap(',
    '\n\n  beginIrBenchActivation(',
  );
  const refreshOverride = sourceSection(
    component,
    'private async refreshFutureSwapEffectiveCycleOverride(',
    '\n\n  private async refreshBenchSwapTimingPreview(',
  );
  const expectedCycle = sourceSection(
    component,
    'private getExpectedFutureSwapCycleNumber()',
    '\n\n  closeRosterManager(',
  );

  assert.match(
    confirmation,
    /normalizeFutureMatchupLineupError\(error\)[\s\S]*?details\.reason === 'swap-timing-conflict'[\s\S]*?details\.effectiveCycleNumber/,
  );
  assert.match(
    confirmation,
    /activeSlotId: targetSlot\.slotId,[\s\S]*?benchSlotId: benchSlot\.slotId,[\s\S]*?outgoingAssetKey,[\s\S]*?incomingAssetKey,[\s\S]*?effectiveCycleNumber: authoritativeEffectiveCycleNumber,[\s\S]*?authorityRefreshed: false/,
  );
  assert.match(confirmation, /this\.pendingFutureLineupMutation = null/);
  assert.match(
    confirmation,
    /await this\.refreshFutureSwapEffectiveCycleOverride\(override\)[\s\S]*?Review the updated timing, then confirm this exact swap again/,
  );

  assert.match(refreshOverride, /getFutureMatchupSwapIntentKey\(override\)/);
  assert.match(
    refreshOverride,
    /await this\.loadFreshFutureLineupAuthority\([\s\S]*?override\.requestedCycleNumber/,
  );
  assert.match(
    refreshOverride,
    /getFutureMatchupSwapIntentKey\(refreshedIntent\) !== overrideKey[\s\S]*?getFutureMatchupSwapIntentKey\(currentOverride\) !== overrideKey/,
  );
  assert.match(refreshOverride, /authorityRefreshed: true/);
  assert.match(
    expectedCycle,
    /resolveFutureMatchupSwapEffectiveCycle\(\{[\s\S]*?predictedEffectiveCycleNumber,[\s\S]*?intent: this\.getFutureSwapIntent\(benchSlot, activeSlot\),[\s\S]*?override: this\.futureSwapEffectiveCycleOverride\(\)/,
  );

  assert.match(
    component,
    /selectFutureLineupCycle[\s\S]*?clearFutureSwapEffectiveCycleOverride\(\)[\s\S]*?selectedFutureLineupCycleNumber\.set/,
  );
  assert.match(
    component,
    /listenToFantasyRoster\([\s\S]*?this\.roster\.set\(roster\)[\s\S]*?clearFutureSwapEffectiveCycleOverrideIfIntentChanged\(\)/,
  );
  assert.match(
    component,
    /selectBenchSwapTarget[\s\S]*?slotId !== this\.benchSwapTargetSlotId\(\)[\s\S]*?clearFutureSwapEffectiveCycleOverride\(\)/,
  );
  assert.match(
    component,
    /clearBenchSwapDialogState[\s\S]*?clearFutureSwapEffectiveCycleOverride\(\)[\s\S]*?benchSwapSlotId\.set\(''\)/,
  );
});

test('future lineup reads remain bounded and every asynchronous swap state is explicit', async () => {
  const [component, template, service] = await Promise.all([
    read(componentPath),
    read(templatePath),
    read('src/app/core/team/future-matchup-lineup.service.ts'),
  ]);

  assert.match(component, /loadFutureMatchupLineupOptionContext\(leagueId, this\.teams\(\)\)/);
  assert.match(
    component,
    /loadFutureMatchupOwnerWindows\([\s\S]*?this\.leagueId,[\s\S]*?cycleNumber,[\s\S]*?ownerId/,
  );
  assert.match(component, /timingGeneration !== this\.futureLineupTimingGeneration/);
  assert.match(component, /mutationGeneration !== this\.futureLineupMutationGeneration/);
  assert.match(component, /futureLineupSaving\.set\(true\)/);
  assert.match(component, /futureLineupSaving\.set\(false\)/);
  assert.match(component, /this\.futureLineupStale\.set\(isFutureMatchupLineupRevisionConflict\(error\)\)/);
  assert.match(
    template,
    /\[attr\.aria-busy\]="[\s\S]*?futureLineupInitialLoadingState[\s\S]*?futureLineupLoading\(\)[\s\S]*?futureLineupSaving\(\)[\s\S]*?"/,
  );
  assert.match(template, /aria-live="polite"/);
  assert.match(template, /Retry timing check/);
  assert.match(template, /\[disabled\]="!canConfirmBenchSwap\(\)"/);
  assert.doesNotMatch(component, /listenToFutureMatchupLineup/);
  assert.doesNotMatch(service, /onSnapshot\(/);
});

test('current matchup roster actions retain their established injury and six-game timing paths', async () => {
  const component = await read(componentPath);

  assert.match(component, /return buildRosterManagementActions\(\{/);
  assert.match(component, /previewActiveBenchSwapTiming\(\{/);
  assert.match(component, /this\.isPendingBenchSwapInjuryReplacement\(\)/);
  assert.match(component, /replaceInjuredRosterAsset\(\{/);
  assert.match(component, /queueActiveBenchSwap\(\{/);
  assert.match(
    component,
    /if \(this\.isFutureRosterAction\(\)\) \{[\s\S]*?await this\.confirmFutureMatchupBenchSwap\(benchSlot, targetSlot\);[\s\S]*?return;[\s\S]*?const targetAsset/,
  );
});

test('matchup selection and dialogs preserve mobile and keyboard-accessible primitives', async () => {
  const [template, componentStyles, sharedStyles, tokens] = await Promise.all([
    read(templatePath),
    read('src/app/features/team/team-settings/team-settings.css'),
    read('src/rinkrat-shared-primitives.css'),
    read('src/rinkrat-design-tokens.css'),
  ]);

  assert.match(template, /<label class="rr-label" for="lineup-matchup-select">Viewing lineup<\/label>/);
  assert.match(template, /id="lineup-unsaved-lineup-note"/);
  assert.match(template, /Save or reset to switch or refresh\./);
  assert.match(template, /futureLineupInitialLoadingState \|\| futureLineupLoading\(\)/);
  assert.match(template, /appDialogFocusTrap/);
  assert.match(template, /\(dialogEscape\)="cancelBenchSwap\(\)"/);
  assert.match(template, /role="dialog"/);
  assert.match(template, /aria-modal="true"/);
  assert.match(
    componentStyles,
    /@media \(max-width: 680px\)[\s\S]*?\.defense-slots[\s\S]*?grid-template-columns: 1fr/,
  );
  assert.match(
    sharedStyles,
    /@media \(max-width: 640px\)[\s\S]*?\.rr-dialog__actions[\s\S]*?flex-direction: column-reverse/,
  );
  assert.match(
    componentStyles,
    /@media \(max-width: 640px\)[\s\S]*?\.team-name-form > div[\s\S]*?flex-direction: column/,
  );
  assert.match(tokens, /--rr-control-min-height: 44px/);
  assert.match(tokens, /--rr-touch-target: 44px/);
});
