import { Routes } from '@angular/router';

import { authChildGuard, authGuard } from './core/guards/auth.guard';
import { platformAdminGuard } from './core/guards/platform-admin.guard';
import { pendingDraftSaveGuard } from './core/guards/pending-draft-save.guard';
import { pendingDraftActionGuard } from './core/guards/pending-draft-action.guard';
import { pendingRosterActionGuard } from './core/guards/pending-roster-action.guard';
import {
  commissionerGuard,
  leagueMemberGuard,
} from './core/guards/league-access.guard';

export const routes: Routes = [
  {
    path: '',
    title: 'RinkRat Fantasy',
    pathMatch: 'full',
    loadComponent: () => import('./features/auth/auth').then((module) => module.Auth),
  },
  {
    path: 'privacy',
    title: 'Privacy',
    loadComponent: () =>
      import('./features/legal/privacy/privacy').then((module) => module.PrivacyPage),
  },
  {
    path: 'terms',
    title: 'Terms',
    loadComponent: () => import('./features/legal/terms/terms').then((module) => module.TermsPage),
  },
  {
    path: 'support',
    title: 'Support',
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
        title: 'Dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((module) => module.Dashboard),
      },
      {
        path: 'training-camp',
        title: 'Training Camp',
        loadComponent: () =>
          import('./features/onboarding/training-camp/training-camp').then(
            (module) => module.TrainingCamp,
          ),
      },
      {
        path: 'scoring',
        title: 'Scoring Guide',
        loadComponent: () =>
          import('./features/scoring/scoring-guide/scoring-guide').then(
            (module) => module.ScoringGuide,
          ),
      },
      {
        path: 'leagues/create',
        title: 'Create League',
        loadComponent: () =>
          import('./features/leagues/create-league/create-league').then(
            (module) => module.CreateLeague,
          ),
      },
      {
        path: 'leagues/join',
        title: 'Join League',
        loadComponent: () =>
          import('./features/leagues/join-league/join-league').then(
            (module) => module.JoinLeague,
          ),
      },
      {
        path: 'account/settings',
        title: 'Account Settings',
        loadComponent: () =>
          import('./features/account/account-settings/account-settings').then(
            (module) => module.AccountSettings,
          ),
      },
      {
        path: 'support/feedback',
        title: 'Send Feedback',
        loadComponent: () =>
          import('./features/support/feedback/feedback').then((module) => module.FeedbackPage),
      },
      {
        path: 'admin',
        title: 'Admin Center',
        canActivate: [platformAdminGuard],
        loadComponent: () =>
          import('./features/admin/admin-center/admin-center').then(
            (module) => module.AdminCenter,
          ),
      },
      {
        path: 'access-denied',
        title: 'Access Denied',
        loadComponent: () =>
          import('./features/errors/access-denied/access-denied').then(
            (module) => module.AccessDenied,
          ),
      },
      {
        path: 'scoring-test',
        title: 'Scoring Test Lab',
        canActivate: [platformAdminGuard],
        loadComponent: () =>
          import('./features/scoring-test/scoring-test').then((module) => module.ScoringTest),
      },
      {
        path: 'players/:playerId',
        title: 'Player Details',
        loadComponent: () =>
          import('./features/players/player-detail/player-detail').then(
            (module) => module.PlayerDetail,
          ),
      },
      {
        path: 'leagues/:leagueId/team',
        title: 'My Team',
        canActivate: [leagueMemberGuard],
        canDeactivate: [pendingRosterActionGuard],
        loadComponent: () =>
          import('./features/team/team-settings/team-settings').then(
            (module) => module.TeamSettings,
          ),
      },
      {
        path: 'leagues/:leagueId/free-agents',
        title: 'Free Agents',
        canActivate: [leagueMemberGuard],
        canDeactivate: [pendingRosterActionGuard],
        loadComponent: () =>
          import('./features/free-agents/free-agents').then((module) => module.FreeAgents),
      },
      {
        path: 'leagues/:leagueId/draft/setup',
        title: 'Draft Setup',
        canActivate: [leagueMemberGuard, commissionerGuard],
        canDeactivate: [pendingDraftSaveGuard],
        loadComponent: () =>
          import('./features/draft/draft-setup/draft-setup').then(
            (module) => module.DraftSetup,
          ),
      },
      {
        path: 'leagues/:leagueId/draft',
        title: 'Draft Room',
        canActivate: [leagueMemberGuard],
        canDeactivate: [pendingDraftActionGuard],
        loadComponent: () =>
          import('./features/draft/draft-room/draft-room').then((module) => module.DraftRoom),
      },
      {
        path: 'leagues/:leagueId/projections',
        title: 'Projection Lab',
        canActivate: [leagueMemberGuard, commissionerGuard],
        loadComponent: () =>
          import('./features/projections/projection-lab/projection-lab').then(
            (module) => module.ProjectionLab,
          ),
      },
      {
        path: 'leagues/:leagueId/player-availability',
        title: 'Player Availability',
        canActivate: [leagueMemberGuard, commissionerGuard],
        loadComponent: () =>
          import('./features/player-availability/player-availability-manager/player-availability-manager').then(
            (module) => module.PlayerAvailabilityManager,
          ),
      },
      {
        path: 'leagues/:leagueId/live-scoring',
        title: 'Live Scoring Diagnostics',
        canActivate: [leagueMemberGuard, platformAdminGuard],
        loadComponent: () =>
          import('./features/live-scoring/live-scoring-diagnostics/live-scoring-diagnostics').then(
            (module) => module.LiveScoringDiagnostics,
          ),
      },
      {
        path: 'leagues/:leagueId/release-readiness',
        title: 'Release Readiness',
        canActivate: [leagueMemberGuard, platformAdminGuard],
        loadComponent: () =>
          import('./features/release/release-readiness/release-readiness').then(
            (module) => module.ReleaseReadiness,
          ),
      },
      {
        path: 'leagues/:leagueId/standings',
        title: 'Standings',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/leagues/league-standings/league-standings').then(
            (module) => module.LeagueStandings,
          ),
      },
      {
        path: 'leagues/:leagueId/leaders',
        title: 'Point Leaders',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/leaders/point-leaders/point-leaders').then(
            (module) => module.PointLeaders,
          ),
      },
      {
        path: 'leagues/:leagueId/scoring',
        title: 'Scoring Guide',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/scoring/scoring-guide/scoring-guide').then(
            (module) => module.ScoringGuide,
          ),
      },
      {
        path: 'leagues/:leagueId/playoffs/simulator',
        title: 'Playoff Window Simulator',
        canActivate: [leagueMemberGuard, platformAdminGuard],
        loadComponent: () =>
          import('./features/playoffs/playoff-window-simulator/playoff-window-simulator').then(
            (module) => module.PlayoffWindowSimulator,
          ),
      },
      {
        path: 'leagues/:leagueId/playoffs',
        title: 'Playoffs',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/playoffs/playoff-bracket/playoff-bracket').then(
            (module) => module.PlayoffBracket,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/schedule-preview',
        title: 'Schedule Preview',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/schedule-preview/cycle-schedule-preview').then(
            (module) => module.CycleSchedulePreview,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/simulator',
        title: 'Cycle Simulator',
        canActivate: [leagueMemberGuard, platformAdminGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-simulator/cycle-simulator').then(
            (module) => module.CycleSimulator,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups/:matchupId',
        title: 'Game Center',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-one/cycle-one').then((module) => module.CycleOne),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups',
        title: 'Matchups',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/matchup-overview/cycle-matchup-overview').then(
            (module) => module.CycleMatchupOverview,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/assets/:assetKey',
        title: 'Player Matchup Detail',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-asset-detail/cycle-asset-detail').then(
            (module) => module.CycleAssetDetail,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber',
        title: 'Game Center',
        canActivate: [leagueMemberGuard],
        loadComponent: () =>
          import('./features/cycles/cycle-one/cycle-one').then((module) => module.CycleOne),
      },
      {
        path: 'leagues/:leagueId',
        title: 'League HQ',
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
