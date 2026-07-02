import { Routes } from '@angular/router';
import { Auth } from './features/auth/auth';
import { Dashboard } from './features/dashboard/dashboard';
import { CreateLeague } from './features/leagues/create-league/create-league';
import { LeagueDetail } from './features/leagues/league-detail/league-detail';
import { ScoringTest } from './features/scoring-test/scoring-test';

export const routes: Routes = [
  { path: '', component: Auth },
  { path: 'dashboard', component: Dashboard },
  { path: 'leagues/create', component: CreateLeague },
  { path: 'leagues/:leagueId', component: LeagueDetail },
  { path: 'scoring-test', component: ScoringTest }
];