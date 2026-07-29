import { Routes } from '@angular/router';

import { authChildGuard, authGuard } from './core/guards/auth.guard';
import { platformAdminGuard } from './core/guards/platform-admin.guard';
import {
  commissionerGuard,
  developerToolsGuard,
  leagueMemberGuard,
} from './core/guards/league-access.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/auth/auth').then((module) => module.Auth),
  },
  {
    path: 'privacy',
    loadComponent: () =>
      import('./features/legal/privacy/privacy').then((module) => module.PrivacyPage),
  },
  {
    path: 'terms',
    loadComponent: () => import('./features/legal/terms/terms').then((module) => module.TermsPage),
  },
  {
    path: 'support',
    loadComponent: () =>
      import('./features/support/support-home/support-home').then(
        (module) => module.SupportHome,
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    canActivateChild: [authChildGuard],
    loadComponent: () =>
      import('./layouts/main-layout/main-layout').then((module) => module.MainLayout),
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((module) => module.Dashboard),
      },
      {
        path: 'training-camp',
        loadComponent: () =>
          import('./features/onboarding/training-camp/training-camp').then(
            (module) => module.TrainingCamp,
          ),
      },
      {
        path: 'leagues/create',
        loadComponent: () =>
          import('./features/leagues/create-league/create-league').then(
            (module) => module.CreateLeague,
          ),
      },
      {
        path: 'leagues/join',
        loadComponent: () =>
          import('./features/leagues/join-league/join-league').then(
            (module) => module.JoinLeague,
          ),
      },
      {
        path: 'account/settings',
        loadComponent: () =>
          import('./features/account/account-settings/account-settings').then(
            (module) => module.AccountSettings,
          ),
      },
      {
        path: 'support/feedback',
        loadComponent: () =>
          import('./features/support/feedback/feedback').then((module) => module.FeedbackPage),
      },
      {
        path: 'admin',
        canActivate: [platformAdminGuard],
        loadComponent: () =>
          import('./features/admin/admin-center/admin-center').then(
            (module) => module.AdminCenter,
          ),
      },
      {
        path: 'access-denied',
        loadComponent: () =>
          import('./features/errors/access-denied/access-denied').then(
            (module) => module.AccessDenied,
          ),
      },
      {
        path: 'scoring-test',
        canActivate: [developerToolsGuard],
        loadComponent: () =>
          import('./features/scoring-test/scoring-test').then((module) => module.ScoringTest),
      },
      {
        path: 'players/:playerId',
        loadComponent: () =>
          import('./features/players/player-detail/player-detail').then(
            (module) => module.PlayerDetail,
          ),
      },
      {
        path: 'leagues/:leagueId/team',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/team/team-settings/team-settings').then(
            (module) => module.TeamSettings,
          ),
      },
      {
        path: 'leagues/:leagueId/free-agents',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/free-agents/free-agents').then((module) => module.FreeAgents),
      },
      {
        path: 'leagues/:leagueId/draft/setup',
        canActivate: [leagueMemberGuard, commissionerGuard],
        loadComponent: () =>
          import('./features/draft/draft-setup/draft-setup').then(
            (module) => module.DraftSetup,
          ),
      },
      {
        path: 'leagues/:leagueId/draft',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/draft/draft-room/draft-room').then((module) => module.DraftRoom),
      },
      {
        path: 'leagues/:leagueId/projections',
        canActivate: [leagueMemberGuard, commissionerGuard],
        loadComponent: () =>
          import('./features/projections/projection-lab/projection-lab').then(
            (module) => module.ProjectionLab,
          ),
      },
      {
        path: 'leagues/:leagueId/player-availability',
        canActivate: [leagueMemberGuard, commissionerGuard],
        loadComponent: () =>
          import('./features/player-availability/player-availability-manager/player-availability-manager').then(
            (module) => module.PlayerAvailabilityManager,
          ),
      },
      {
        path: 'leagues/:leagueId/live-scoring',
        canActivate: [leagueMemberGuard, commissionerGuard, developerToolsGuard],
        loadComponent: () =>
          import('./features/live-scoring/live-scoring-diagnostics/live-scoring-diagnostics').then(
            (module) => module.LiveScoringDiagnostics,
          ),
      },
      {
        path: 'leagues/:leagueId/release-readiness',
        canActivate: [leagueMemberGuard, commissionerGuard, developerToolsGuard],
        loadComponent: () =>
          import('./features/release/release-readiness/release-readiness').then(
            (module) => module.ReleaseReadiness,
          ),
      },
      {
        path: 'leagues/:leagueId/standings',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/leagues/league-standings/league-standings').then(
            (module) => module.LeagueStandings,
          ),
      },
      {
        path: 'leagues/:leagueId/leaders',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/leaders/point-leaders/point-leaders').then(
            (module) => module.PointLeaders,
          ),
      },
      {
        path: 'leagues/:leagueId/playoffs/simulator',
        canActivate: [leagueMemberGuard, commissionerGuard, developerToolsGuard],
        loadComponent: () =>
          import('./features/playoffs/playoff-window-simulator/playoff-window-simulator').then(
            (module) => module.PlayoffWindowSimulator,
          ),
      },
      {
        path: 'leagues/:leagueId/playoffs',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/playoffs/playoff-bracket/playoff-bracket').then(
            (module) => module.PlayoffBracket,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/schedule-preview',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/schedule-preview/cycle-schedule-preview').then(
            (module) => module.CycleSchedulePreview,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/simulator',
        canActivate: [leagueMemberGuard, commissionerGuard, developerToolsGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-simulator/cycle-simulator').then(
            (module) => module.CycleSimulator,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups/:matchupId',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-one/cycle-one').then((module) => module.CycleOne),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/matchup-overview/cycle-matchup-overview').then(
            (module) => module.CycleMatchupOverview,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/assets/:assetKey',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-asset-detail/cycle-asset-detail').then(
            (module) => module.CycleAssetDetail,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-one/cycle-one').then((module) => module.CycleOne),
      },
      {
        path: 'leagues/:leagueId',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/leagues/league-detail/league-detail').then(
            (module) => module.LeagueDetail,
          ),
      },
      {
        path: '**',
        redirectTo: 'dashboard',
      },
    ],
  },
];
