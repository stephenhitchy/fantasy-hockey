import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';
import {
  IDLE_REFRESH_INTERVAL_MILLISECONDS,
  NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT,
  NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
  STANDARD_LIVE_REFRESH_INTERVAL_MILLISECONDS,
  getLiveScoringRefreshDelay,
  selectLeagueAutomationRefreshCadence,
} from '../../functions/src/shared/core/live-scoring/live-scoring-cadence.util.ts';
import { TRAINING_CAMP_STEPS } from '../../src/app/features/onboarding/training-camp/training-camp.data.ts';

const ROOT = new URL('../../', import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, ROOT), 'utf8');
const sha256 = async (relativePath) => createHash('sha256')
  .update(await readFile(new URL(relativePath, ROOT)))
  .digest('hex');

test('Training Camp teaches the six-game rule through player language', async () => {
  const template = await read('src/app/features/onboarding/training-camp/training-camp.html');
  const cycleStep = TRAINING_CAMP_STEPS[0];

  assert.equal(cycleStep.title, 'Six games for every active player');
  assert.match(cycleStep.drills[0].body, /Each active player gets six NHL games/);
  assert.match(cycleStep.drills[0].body, /Team Goalie Unit follows the same six-game rule/);
  assert.doesNotMatch(cycleStep.drills[0].body, /roster spot/i);
  assert.match(cycleStep.drills[1].body, /After a player counts six games/);
  assert.match(template, /Active player/);
  assert.match(template, /Player A/);
  assert.match(template, /Player B/);
  assert.doesNotMatch(template, /Active roster spot|Spot A|Spot B|Both spots still count exactly six games/);
});

test('only an exact Internal Test queue Canary receives the near-live cadence', () => {
  const canaryLeagueIds = ['league-canary'];

  assert.equal(
    selectLeagueAutomationRefreshCadence({
      queueMode: 'canary',
      leagueId: 'league-canary',
      canaryLeagueIds,
      internalTestLeagueIds: canaryLeagueIds,
    }),
    'near-live-canary',
  );
  assert.equal(
    selectLeagueAutomationRefreshCadence({
      queueMode: 'canary',
      leagueId: 'league-friend',
      canaryLeagueIds,
      internalTestLeagueIds: canaryLeagueIds,
    }),
    'standard',
  );
  assert.equal(
    selectLeagueAutomationRefreshCadence({
      queueMode: 'canary',
      leagueId: 'league-canary',
      canaryLeagueIds,
      internalTestLeagueIds: [],
    }),
    'standard',
  );
  assert.equal(NEAR_LIVE_CANARY_MAX_LEAGUE_COUNT, 4);
  assert.equal(
    selectLeagueAutomationRefreshCadence({
      queueMode: 'canary',
      leagueId: 'league-canary',
      canaryLeagueIds: [
        'league-canary',
        'league-two',
        'league-three',
        'league-four',
        'league-five',
      ],
      internalTestLeagueIds: [
        'league-canary',
        'league-two',
        'league-three',
        'league-four',
        'league-five',
      ],
    }),
    'standard',
  );
  assert.equal(
    selectLeagueAutomationRefreshCadence({
      queueMode: 'shadow',
      leagueId: 'league-canary',
      canaryLeagueIds,
      internalTestLeagueIds: canaryLeagueIds,
    }),
    'standard',
  );
  assert.equal(
    selectLeagueAutomationRefreshCadence({
      queueMode: 'primary',
      leagueId: 'league-canary',
      canaryLeagueIds,
      internalTestLeagueIds: canaryLeagueIds,
    }),
    'standard',
  );
});

test('live Canary cadence is two minutes while standard and idle behavior stay unchanged', () => {
  const live = [{ hasLiveGames: true, nextScheduledGameStart: null }];
  const idle = [{ hasLiveGames: false, nextScheduledGameStart: null }];

  assert.equal(
    getLiveScoringRefreshDelay(live, false, 0, 'near-live-canary'),
    NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS,
  );
  assert.equal(NEAR_LIVE_CANARY_REFRESH_INTERVAL_MILLISECONDS, 2 * 60 * 1000);
  assert.equal(
    getLiveScoringRefreshDelay(live, false, 0, 'standard'),
    STANDARD_LIVE_REFRESH_INTERVAL_MILLISECONDS,
  );
  assert.equal(STANDARD_LIVE_REFRESH_INTERVAL_MILLISECONDS, 10 * 60 * 1000);
  assert.equal(
    getLiveScoringRefreshDelay(idle, false, 0, 'near-live-canary'),
    IDLE_REFRESH_INTERVAL_MILLISECONDS,
  );
});

test('near-live cadence uses the existing per-league queue and does not speed up the legacy sweep', async () => {
  const source = await read('functions/src/league-automation.ts');

  assert.match(source, /schedule: '\* \* \* \* \*'/);
  assert.match(source, /schedule: 'every 10 minutes'/);
  assert.match(source, /const MAX_PARALLEL_LEAGUES = 2/);
  assert.match(source, /const LEAGUE_AUTOMATION_QUEUE_MAX_CONCURRENT_DISPATCHES = 4/);
  assert.match(source, /selectLeagueAutomationRefreshCadence\(\{/);
  assert.match(source, /queueMode: config\.mode/);
  assert.match(source, /internalTestLeagueIds: config\.internalTestLeagueIds/);
  assert.match(source, /Every queued scoring canary must also be marked Internal Test/);
  assert.match(source, /if \(mode === 'canary' && canaryLeagueIdsMissingInternalTest\.length > 0\)/);
  assert.match(source, /Near-live Canary is limited to/);
  assert.match(source, /must also be marked Internal Test before it can run/);
  assert.match(source, /queueNearLiveCanaryMaxLeagueCount/);
  assert.match(source, /runLeagueAutomation\([\s\S]*?'queue-task',[\s\S]*?refreshCadence/);
  assert.match(source, /'manual',[\s\S]*?getConfiguredLeagueAutomationRefreshCadence\(config, leagueId\)/);
  assert.match(source, /lastRefreshCadence: refreshCadence/);
  assert.match(source, /queueNearLiveCanaryRefreshIntervalMilliseconds/);
});

test('only the exact internal Canary receives the fresher NHL request profile', async () => {
  const [automation, scoring, nhlApi] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
  ]);

  assert.match(automation, /internalTestLeagueIds: config\.internalTestLeagueIds/);
  assert.match(automation, /nhlRefreshProfile: refreshCadence/);
  assert.match(automation, /Every queued scoring canary must also be marked Internal Test/);
  assert.match(scoring, /const nhlRefreshProfile = input\.nhlRefreshProfile \?\? 'standard'/);
  assert.match(scoring, /getGameBoxscore\(gameId, refreshProfile\)/);
  assert.match(scoring, /getGamePlayByPlay\(gameId, refreshProfile\)/);
  assert.match(nhlApi, /NHL_SCHEDULE_CACHE_MILLISECONDS = 10 \* 60 \* 1000/);
  assert.match(nhlApi, /NHL_GAME_DATA_CACHE_MILLISECONDS = 2 \* 60 \* 1000/);
  assert.match(nhlApi, /NHL_NEAR_LIVE_SCHEDULE_CACHE_MILLISECONDS = 30 \* 1000/);
  assert.match(nhlApi, /NHL_NEAR_LIVE_GAME_DATA_CACHE_MILLISECONDS = 15 \* 1000/);
  assert.match(nhlApi, /refreshProfile: NhlApiRefreshProfile = 'standard'/);
});

test('the control center identifies near-live Canary without offering broad live activation', async () => {
  const [service, component, template] = await Promise.all([
    read('src/app/core/admin/scoring-queue-control.service.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.ts'),
    read('src/app/features/release/scoring-queue-control-center/scoring-queue-control-center.html'),
  ]);

  assert.match(service, /LeagueAutomationRefreshCadence = 'standard' \| 'near-live-canary'/);
  assert.match(service, /queueNearLiveCanaryMaxLeagueCount/);
  assert.match(component, /this\.isNearLiveCanary\(league\) \? 'Near-Live Canary' : 'Queued Canary'/);
  assert.match(component, /healthy two-minute refresh cadence/);
  assert.match(component, /selectingCanary/);
  assert.match(component, /removingInternalTest/);
  assert.match(template, /Scoring cadence/);
  assert.match(template, /Canary live target/);
  assert.match(template, /Primary stays on the standard cadence/);
  assert.match(template, /guarded two-minute cadence/);
  assert.match(template, /Selecting[\s\S]*Canary marks the league Internal Test automatically/);
  assert.doesNotMatch(template, /scope, not speed/i);
  assert.doesNotMatch(template, /Enable near-live for all leagues/i);
});


test('near-live Canary uses fresher process-local NHL data without changing standard cache windows', async () => {
  const [nhlApi, cycleScoring] = await Promise.all([
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
    read('functions/src/shared/core/cycle/cycle-scoring.service.ts'),
  ]);

  assert.match(nhlApi, /const NHL_SCHEDULE_CACHE_MILLISECONDS = 10 \* 60 \* 1000/);
  assert.match(nhlApi, /const NHL_GAME_DATA_CACHE_MILLISECONDS = 2 \* 60 \* 1000/);
  assert.match(nhlApi, /const NHL_NEAR_LIVE_SCHEDULE_CACHE_MILLISECONDS = 30 \* 1000/);
  assert.match(nhlApi, /const NHL_NEAR_LIVE_GAME_DATA_CACHE_MILLISECONDS = 15 \* 1000/);
  assert.match(nhlApi, /refreshProfile: NhlApiRefreshProfile = 'standard'/);
  assert.match(cycleScoring, /nhlRefreshProfile\?: NhlApiRefreshProfile/);
  assert.match(cycleScoring, /getNhlTeamSeasonSchedule\([\s\S]*?refreshProfile/);
  assert.match(cycleScoring, /getGameBoxscore\(gameId, refreshProfile\)/);
  assert.match(cycleScoring, /getGamePlayByPlay\(gameId, refreshProfile\)/);
});

test('shared NHL cache and competitive models remain protected during the Canary cadence batch', async () => {
  const cache = JSON.parse(await read('config/nhl-shared-cache-policy.json'));

  assert.equal(cache.mode, 'shadow');
  assert.equal(cache.authoritativeReadsEnabled, false);
  assert.equal(await sha256('src/app/core/scoring/scoring-rules.ts'), PROTECTED_SOURCE_HASHES.scoringRules);
  assert.equal(await sha256('src/app/core/scoring/scoring-engine.ts'), PROTECTED_SOURCE_HASHES.scoringEngine);
  assert.equal(await sha256('src/app/core/projection/projection-v11.util.ts'), PROTECTED_SOURCE_HASHES.projectionV11);
  assert.equal(await sha256('firestore.rules'), PROTECTED_SOURCE_HASHES.firestoreRules);
});

test('D1D is documented as a measured Canary-only infrastructure batch', async () => {
  const [packageSource, readme, releaseNotes, rootRoadmap, docsRoadmap] = await Promise.all([
    read('package.json'),
    read('README.md'),
    read('docs/RINKRAT_DATA_D1D_NEAR_LIVE_SCORING_CANARY.md'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(rootRoadmap, docsRoadmap);
  assert.match(packageJson.scripts['verify:batchd1d:core'], /verify:batchb1k:core/);
  assert.match(packageJson.scripts['verify:batchd1d'], /toolchain:verify/);
  assert.match(readme, /D1D Near-Live Scoring Canary/);
  assert.match(releaseNotes, /exact internal Canar(?:y|ies)/i);
  assert.match(releaseNotes, /two-minute live-game target/i);
  assert.match(releaseNotes, /Primary remains on the standard cadence/i);
  assert.match(rootRoadmap, /LOG\.86 2026-08-25/);
});
