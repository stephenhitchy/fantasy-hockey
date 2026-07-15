import { Routes } from '@angular/router';

import { Auth } from './features/auth/auth';
import { Dashboard } from './features/dashboard/dashboard';
import { CreateLeague } from './features/leagues/create-league/create-league';
import { JoinLeague } from './features/leagues/join-league/join-league';
import { LeagueDetail } from './features/leagues/league-detail/league-detail';
import { LeagueStandings } from './features/leagues/league-standings/league-standings';
import { TeamSettings } from './features/team/team-settings/team-settings';
import { FreeAgents } from './features/free-agents/free-agents';
import { AccountSettings } from './features/account/account-settings/account-settings';
import { ScoringTest } from './features/scoring-test/scoring-test';
import { PlayerDetail } from './features/players/player-detail/player-detail';
import { DraftSetup } from './features/draft/draft-setup/draft-setup';
import { DraftRoom } from './features/draft/draft-room/draft-room';
import { MainLayout } from './layouts/main-layout/main-layout';
import { CycleOne } from './features/cycles/cycle-one/cycle-one';
import { ProjectionLab } from './features/projections/projection-lab/projection-lab';
import { CycleAssetDetail } from './features/cycles/cycle-asset-detail/cycle-asset-detail';
import { CycleSchedulePreview } from './features/cycles/schedule-preview/cycle-schedule-preview';
import { CycleMatchupOverview } from './features/cycles/matchup-overview/cycle-matchup-overview';
import { PlayerAvailabilityManager } from './features/player-availability/player-availability-manager/player-availability-manager';
import { PlayoffBracket } from './features/playoffs/playoff-bracket/playoff-bracket';

export const routes: Routes = [
  {
    path: '',
    component: Auth
  },
  {
    path: '',
    component: MainLayout,
    children: [
      {
        path: 'dashboard',
        component: Dashboard
      },
      {
        path: 'leagues/create',
        component: CreateLeague
      },
      {
        path: 'leagues/join',
        component: JoinLeague
      },
      {
        path: 'account/settings',
        component: AccountSettings
      },
      {
        path: 'scoring-test',
        component: ScoringTest
      },
      {
        path: 'players/:playerId',
        component: PlayerDetail
      },
      {
        path: 'leagues/:leagueId/team',
        component: TeamSettings
      },
      {
        path: 'leagues/:leagueId/free-agents',
        component: FreeAgents
      },
      {
        path: 'leagues/:leagueId/draft/setup',
        component: DraftSetup
      },
      {
        path: 'leagues/:leagueId/draft',
        component: DraftRoom
      },
      {
        path: 'leagues/:leagueId/projections',
        component: ProjectionLab
      },
      {
        path: 'leagues/:leagueId/player-availability',
        component: PlayerAvailabilityManager
      },
      {
        path: 'leagues/:leagueId/standings',
        component: LeagueStandings
      },
      {
        path: 'leagues/:leagueId/playoffs',
        component: PlayoffBracket
      },
      {
        path: 'leagues/:leagueId/cycles/schedule-preview',
        component: CycleSchedulePreview
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups/:matchupId',
        component: CycleOne
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups',
        component: CycleMatchupOverview
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/assets/:assetKey',
        component: CycleAssetDetail
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber',
        component: CycleOne
      },
      {
        path: 'leagues/:leagueId',
        component: LeagueDetail
      }
    ]
  }
];
