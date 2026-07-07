import { Routes } from '@angular/router';

import { Auth } from './features/auth/auth';
import { Dashboard } from './features/dashboard/dashboard';
import { CreateLeague } from './features/leagues/create-league/create-league';
import { JoinLeague } from './features/leagues/join-league/join-league';
import { LeagueDetail } from './features/leagues/league-detail/league-detail';
import { TeamSettings } from './features/team/team-settings/team-settings';
import { AccountSettings } from './features/account/account-settings/account-settings';
import { ScoringTest } from './features/scoring-test/scoring-test';
import { PlayerDetail } from './features/players/player-detail/player-detail';
import { DraftSetup } from './features/draft/draft-setup/draft-setup';
import { MainLayout } from './layouts/main-layout/main-layout';

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
        path: 'leagues/:leagueId/draft/setup',
        component: DraftSetup
      },
      {
        path: 'leagues/:leagueId',
        component: LeagueDetail
      }
    ]
  }
];