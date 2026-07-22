import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/auth/auth').then((module) => module.Auth),
  },
  {
    path: '',
    loadComponent: () =>
      import('./layouts/main-layout/main-layout').then((module) => module.MainLayout),
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((module) => module.Dashboard),
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
          import('./features/leagues/join-league/join-league').then((module) => module.JoinLeague),
      },
      {
        path: 'account/settings',
        loadComponent: () =>
          import('./features/account/account-settings/account-settings').then(
            (module) => module.AccountSettings,
          ),
      },
      {
        path: 'scoring-test',
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
        loadComponent: () =>
          import('./features/team/team-settings/team-settings').then(
            (module) => module.TeamSettings,
          ),
      },
      {
        path: 'leagues/:leagueId/free-agents',
        loadComponent: () =>
          import('./features/free-agents/free-agents').then((module) => module.FreeAgents),
      },
      {
        path: 'leagues/:leagueId/draft/setup',
        loadComponent: () =>
          import('./features/draft/draft-setup/draft-setup').then((module) => module.DraftSetup),
      },
      {
        path: 'leagues/:leagueId/draft',
        loadComponent: () =>
          import('./features/draft/draft-room/draft-room').then((module) => module.DraftRoom),
      },
      {
        path: 'leagues/:leagueId/projections',
        loadComponent: () =>
          import('./features/projections/projection-lab/projection-lab').then(
            (module) => module.ProjectionLab,
          ),
      },
      {
        path: 'leagues/:leagueId/player-availability',
        loadComponent: () =>
          import('./features/player-availability/player-availability-manager/player-availability-manager').then(
            (module) => module.PlayerAvailabilityManager,
          ),
      },
      {
        path: 'leagues/:leagueId/live-scoring',
        loadComponent: () =>
          import('./features/live-scoring/live-scoring-diagnostics/live-scoring-diagnostics').then(
            (module) => module.LiveScoringDiagnostics,
          ),
      },
      {
        path: 'leagues/:leagueId/release-readiness',
        loadComponent: () =>
          import('./features/release/release-readiness/release-readiness').then(
            (module) => module.ReleaseReadiness,
          ),
      },
      {
        path: 'leagues/:leagueId/standings',
        loadComponent: () =>
          import('./features/leagues/league-standings/league-standings').then(
            (module) => module.LeagueStandings,
          ),
      },
      {
        path: 'leagues/:leagueId/leaders',
        loadComponent: () =>
          import('./features/leaders/point-leaders/point-leaders').then(
            (module) => module.PointLeaders,
          ),
      },
      {
        path: 'leagues/:leagueId/playoffs/simulator',
        loadComponent: () =>
          import('./features/playoffs/playoff-window-simulator/playoff-window-simulator').then(
            (module) => module.PlayoffWindowSimulator,
          ),
      },
      {
        path: 'leagues/:leagueId/playoffs',
        loadComponent: () =>
          import('./features/playoffs/playoff-bracket/playoff-bracket').then(
            (module) => module.PlayoffBracket,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/schedule-preview',
        loadComponent: () =>
          import('./features/cycles/schedule-preview/cycle-schedule-preview').then(
            (module) => module.CycleSchedulePreview,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/simulator',
        loadComponent: () =>
          import('./features/cycles/cycle-simulator/cycle-simulator').then(
            (module) => module.CycleSimulator,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups/:matchupId',
        loadComponent: () =>
          import('./features/cycles/cycle-one/cycle-one').then((module) => module.CycleOne),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/matchups',
        loadComponent: () =>
          import('./features/cycles/matchup-overview/cycle-matchup-overview').then(
            (module) => module.CycleMatchupOverview,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber/assets/:assetKey',
        loadComponent: () =>
          import('./features/cycles/cycle-asset-detail/cycle-asset-detail').then(
            (module) => module.CycleAssetDetail,
          ),
      },
      {
        path: 'leagues/:leagueId/cycles/:cycleNumber',
        loadComponent: () =>
          import('./features/cycles/cycle-one/cycle-one').then((module) => module.CycleOne),
      },
      {
        path: 'leagues/:leagueId',
        loadComponent: () =>
          import('./features/leagues/league-detail/league-detail').then(
            (module) => module.LeagueDetail,
          ),
      },
    ],
  },
];
