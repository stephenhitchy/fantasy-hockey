import { Routes } from '@angular/router';
import { Auth } from './features/auth/auth';
import { Dashboard } from './features/dashboard/dashboard';
import { CreateLeague } from './features/leagues/create-league/create-league';
import { LeagueDetail } from './features/leagues/league-detail/league-detail';
import { ScoringTest } from './features/scoring-test/scoring-test';
import { TeamSettings } from './features/team/team-settings/team-settings';
import { JoinLeague } from './features/leagues/join-league/join-league';
import { AccountSettings } from './features/account/account-settings/account-settings';
import { MainLayout } from './layouts/main-layout/main-layout';

export const routes: Routes = [
  { path: '', component: Auth },

  {
    path: '',
    component: MainLayout,
    children: [
      { path: 'dashboard', component: Dashboard },
      { path: 'leagues/create', component: CreateLeague },
      { path: 'leagues/join', component: JoinLeague },
      { path: 'account/settings', component: AccountSettings },
      { path: 'scoring-test', component: ScoringTest },
      { path: 'leagues/:leagueId/team', component: TeamSettings },
      { path: 'leagues/:leagueId', component: LeagueDetail }
    ]
  }
];