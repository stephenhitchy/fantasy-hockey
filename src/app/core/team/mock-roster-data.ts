import { RosterAsset } from './roster.models';

function getTeamLogo(teamAbbreviation: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${teamAbbreviation}_light.svg`;
}

export const MOCK_ROSTER_ASSETS: Partial<Record<string, RosterAsset>> = {
  'LW-1': {
    assetType: 'skater',
    position: 'LW',
    player: {
      id: 101,
      fullName: 'Test Left Wing',
      position: 'LW',
      nhlTeamAbbreviation: 'VGK',
      teamLogoUrl: getTeamLogo('VGK')
    },
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 4,
      fantasyPoints: 31.5
    }
  },

  'C-1': {
    assetType: 'skater',
    position: 'C',
    player: {
      id: 102,
      fullName: 'Test Center',
      position: 'C',
      nhlTeamAbbreviation: 'EDM',
      teamLogoUrl: getTeamLogo('EDM')
    },
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 5,
      fantasyPoints: 42
    }
  },

  'RW-1': {
    assetType: 'skater',
    position: 'RW',
    player: {
      id: 103,
      fullName: 'Test Right Wing',
      position: 'RW',
      nhlTeamAbbreviation: 'TBL',
      teamLogoUrl: getTeamLogo('TBL')
    },
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 3,
      fantasyPoints: 24.75
    }
  },

  'D-1': {
    assetType: 'skater',
    position: 'D',
    player: {
      id: 104,
      fullName: 'Test Defenseman',
      position: 'D',
      nhlTeamAbbreviation: 'COL',
      teamLogoUrl: getTeamLogo('COL')
    },
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 6,
      fantasyPoints: 38.25
    }
  },

  'G-1': {
    assetType: 'team-goalie-unit',
    position: 'G',
    teamName: 'Nashville Predators',
    teamAbbreviation: 'NSH',
    teamLogoUrl: getTeamLogo('NSH'),
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 5,
      fantasyPoints: 128.4
    }
  }
};