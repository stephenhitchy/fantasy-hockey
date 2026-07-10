import {
  DraftableAsset
} from './draft.models';

export type DraftInjuryStatus =
  | 'out-start-season'
  | 'questionable-start-season'
  | 'day-to-day'
  | 'long-term';

export interface DraftPlayerNewsOverride {
  /**
   * Use playerId for skaters when possible.
   * For goalie units or special cases, use assetKey instead.
   *
   * playerName/playerAliases are fallback identifiers for manually maintained
   * offseason lists where collecting every NHL player ID would be brittle.
   */
  playerId?: number;
  assetKey?: string;
  playerName?: string;
  playerAliases?: string[];

  /**
   * Show an offseason move badge like:
   * OLD TEAM LOGO → NEW TEAM LOGO
   */
  previousTeamAbbreviation?: string;
  newTeamAbbreviation?: string;

  /**
   * Manual injury designation for draft day.
   * This does not affect scoring or roster eligibility yet.
   */
  injuryStatus?: DraftInjuryStatus;

  /**
   * Short draft-day note shown on the player card.
   */
  note?: string;
}

export const DRAFT_PLAYER_NEWS_LAST_UPDATED = '2026-07-10';

function createTradeOverride(
  playerName: string,
  previousTeamAbbreviation: string,
  newTeamAbbreviation: string,
  moveDate: string,
  playerAliases: string[] = []
): DraftPlayerNewsOverride {
  return {
    playerName,
    playerAliases,
    previousTeamAbbreviation,
    newTeamAbbreviation,
    note: `Traded ${previousTeamAbbreviation} → ${newTeamAbbreviation} on ${moveDate}.`
  };
}

function createFreeAgentOverride(
  playerName: string,
  previousTeamAbbreviation: string,
  newTeamAbbreviation: string,
  playerAliases: string[] = []
): DraftPlayerNewsOverride {
  return {
    playerName,
    playerAliases,
    previousTeamAbbreviation,
    newTeamAbbreviation,
    note: `Signed ${previousTeamAbbreviation} → ${newTeamAbbreviation} in free agency.`
  };
}

/**
 * Manual draft-day news list.
 *
 * Coverage in this version:
 * - NHL skater/prospect trades from June 1 through July 2, 2026.
 * - NHL-to-NHL skater free-agent signings reported through July 10, 2026.
 * - Individual goalie moves are intentionally omitted because this app drafts
 *   team goalie units rather than individual goalies.
 *
 * Injury overrides can be appended below as opening night gets closer.
 */
export const DRAFT_PLAYER_NEWS_OVERRIDES: DraftPlayerNewsOverride[] = [
  // Trades
  // June 1
  createTradeOverride('Jack Pridham', 'CHI', 'TBL', 'June 1'),
  // June 13
  createTradeOverride('Emil Pieniniemi', 'PIT', 'FLA', 'June 13'),
  createTradeOverride('Oliver Okuliar', 'FLA', 'PIT', 'June 13'),
  // June 16
  createTradeOverride('Emil Andrae', 'PHI', 'TOR', 'June 16'),
  createTradeOverride('Ross Colton', 'COL', 'NSH', 'June 16'),
  createTradeOverride('Simon Benoit', 'TOR', 'PHI', 'June 16'),
  // June 17
  createTradeOverride('Michael Kesselring', 'BUF', 'SJS', 'June 17'),
  // June 18
  createTradeOverride('Andre Gasseau', 'BOS', 'SJS', 'June 18'),
  // June 19
  createTradeOverride('Darren Raddysh', 'TBL', 'TOR', 'June 19'),
  // June 21
  createTradeOverride('Brady Tkachuk', 'OTT', 'FLA', 'June 21'),
  createTradeOverride('Mackie Samoskevich', 'FLA', 'SEA', 'June 21'),
  // June 23
  createTradeOverride('Bowen Byram', 'BUF', 'CHI', 'June 23'),
  createTradeOverride('Brandon Svoboda', 'SJS', 'OTT', 'June 23'),
  createTradeOverride('Connor McMichael', 'WSH', 'STL', 'June 23'),
  createTradeOverride('Etienne Morin', 'CGY', 'NJD', 'June 23', ['Étienne Morin']),
  createTradeOverride('Jordan Greenway', 'BUF', 'CHI', 'June 23'),
  createTradeOverride('Jordan Kyrou', 'STL', 'WSH', 'June 23'),
  createTradeOverride('Kasper Halttunen', 'SJS', 'OTT', 'June 23'),
  createTradeOverride('Louis Crevier', 'CHI', 'BUF', 'June 23'),
  createTradeOverride('Maxim Tsyplakov', 'NJD', 'CGY', 'June 23'),
  createTradeOverride('Milton Gastrin', 'WSH', 'STL', 'June 23'),
  createTradeOverride('Simon Nemec', 'NJD', 'CGY', 'June 23'),
  createTradeOverride('William Eklund', 'SJS', 'OTT', 'June 23'),
  // June 24
  createTradeOverride('Alex Tuch', 'BUF', 'WSH', 'June 24'),
  createTradeOverride('Chase Bradley', 'COL', 'NSH', 'June 24'),
  createTradeOverride('Fedor Svechkov', 'NSH', 'COL', 'June 24'),
  createTradeOverride('Jack Drury', 'COL', 'NSH', 'June 24'),
  createTradeOverride('Zachary L\'Heureux', 'NSH', 'COL', 'June 24', ['Zach L\'Heureux']),
  // June 25
  createTradeOverride('Amadeus Lombardi', 'DET', 'NJD', 'June 25'),
  createTradeOverride('Declan Chisholm', 'WSH', 'NJD', 'June 25'),
  createTradeOverride('Garnet Hathaway', 'PHI', 'FLA', 'June 25'),
  createTradeOverride('Hendrix Lapierre', 'WSH', 'PIT', 'June 25'),
  createTradeOverride('Hunter McKown', 'CBJ', 'MTL', 'June 25'),
  createTradeOverride('Luke Tuch', 'MTL', 'CBJ', 'June 25'),
  createTradeOverride('Valeri Nichushkin', 'COL', 'CBJ', 'June 25'),
  // June 26
  createTradeOverride('Andre Burakovsky', 'CHI', 'OTT', 'June 26'),
  createTradeOverride('Anton Wahlberg', 'BUF', 'ANA', 'June 26'),
  createTradeOverride('Brett Berard', 'NYR', 'MTL', 'June 26'),
  createTradeOverride('JJ Peterka', 'UTA', 'BOS', 'June 26', ['J.J. Peterka', 'John-Jason Peterka']),
  createTradeOverride('Mason McTavish', 'ANA', 'STL', 'June 26'),
  createTradeOverride('Olen Zellweger', 'ANA', 'BUF', 'June 26'),
  createTradeOverride('Pavel Dorofeyev', 'VGK', 'NYR', 'June 26'),
  createTradeOverride('William Trudeau', 'MTL', 'NYR', 'June 26'),
  // June 27
  createTradeOverride('Adam Edstrom', 'NYR', 'NSH', 'June 27'),
  createTradeOverride('Brandon Carlo', 'TOR', 'STL', 'June 27'),
  createTradeOverride('Fabian Lysell', 'BOS', 'COL', 'June 27'),
  createTradeOverride('Ivan Ivan', 'COL', 'BOS', 'June 27'),
  createTradeOverride('Massimo Rizzo', 'NSH', 'NYR', 'June 27'),
  createTradeOverride('Ryan Healey', 'MIN', 'NYI', 'June 27'),
  // June 29
  createTradeOverride('A.J. Greer', 'FLA', 'ANA', 'June 29', ['AJ Greer']),
  createTradeOverride('Brendan Gallagher', 'MTL', 'VAN', 'June 29'),
  createTradeOverride('David Gustafsson', 'WPG', 'PIT', 'June 29'),
  createTradeOverride('Jack St. Ivany', 'PIT', 'WPG', 'June 29'),
  createTradeOverride('Joshua Roy', 'MTL', 'UTA', 'June 29'),
  createTradeOverride('Maksymilian Szuber', 'UTA', 'MTL', 'June 29'),
  createTradeOverride('Nils Hoglander', 'VAN', 'NSH', 'June 29', ['Nils Höglander']),
  createTradeOverride('Radko Gudas', 'ANA', 'FLA', 'June 29'),
  // June 30
  createTradeOverride('Angus Crookshank', 'NJD', 'FLA', 'June 30'),
  createTradeOverride('Ben Steeves', 'NJD', 'FLA', 'June 30'),
  createTradeOverride('Evan Rodrigues', 'FLA', 'NJD', 'June 30'),
  createTradeOverride('Jesper Boqvist', 'FLA', 'NJD', 'June 30'),
  createTradeOverride('Kaedan Korczak', 'VGK', 'PIT', 'June 30'),
  createTradeOverride('Kyle Masters', 'ANA', 'CAR', 'June 30'),
  createTradeOverride('Parker Wotherspoon', 'PIT', 'VGK', 'June 30'),
  // July 1
  createTradeOverride('Cole Beaudoin', 'UTA', 'NYR', 'July 1'),
  createTradeOverride('Darnell Nurse', 'EDM', 'SJS', 'July 1'),
  createTradeOverride('Ilya Lyubushkin', 'DAL', 'NSH', 'July 1'),
  createTradeOverride('Kalle Vaisanen', 'NYR', 'BOS', 'July 1', ['Kalle Väisänen']),
  createTradeOverride('Keegan Kolesar', 'VGK', 'DET', 'July 1'),
  createTradeOverride('Marcus Pettersson', 'VAN', 'NYR', 'July 1'),
  createTradeOverride('Mavrik Bourque', 'DAL', 'NSH', 'July 1'),
  createTradeOverride('Nicholas Robertson', 'TOR', 'PIT', 'July 1'),
  createTradeOverride('Nick Paul', 'TBL', 'TOR', 'July 1'),
  createTradeOverride('Sean Durzi', 'UTA', 'NYR', 'July 1'),
  createTradeOverride('Shakir Mukhamadullin', 'SJS', 'EDM', 'July 1'),
  createTradeOverride('Vincent Trocheck', 'NYR', 'UTA', 'July 1'),
  createTradeOverride('Will Borgen', 'NYR', 'BOS', 'July 1'),
  createTradeOverride('Zachary Sharp', 'SJS', 'EDM', 'July 1'),
  // July 2
  createTradeOverride('Blake Coleman', 'CGY', 'MIN', 'July 2'),
  createTradeOverride('Jacob Middleton', 'MIN', 'CGY', 'July 2'),
  createTradeOverride('Olli Maatta', 'CGY', 'MIN', 'July 2', ['Olli Määttä']),

  // Free-agent signings (grouped by previous NHL team)
  // From ANA
  createFreeAgentOverride('Jansen Harkins', 'ANA', 'TBL'),
  createFreeAgentOverride('Ross Johnston', 'ANA', 'STL'),
  createFreeAgentOverride('Jacob Trouba', 'ANA', 'SJS'),
  createFreeAgentOverride('Jeffrey Viel', 'ANA', 'TBL'),
  // From BOS
  createFreeAgentOverride('Viktor Arvidsson', 'BOS', 'DET'),
  createFreeAgentOverride('Andrew Peeke', 'BOS', 'UTA'),
  createFreeAgentOverride('Riley Tufte', 'BOS', 'NJD'),
  createFreeAgentOverride('Michael Callahan', 'BOS', 'TBL'),
  // From BUF
  createFreeAgentOverride('Josh Dunne', 'BUF', 'WSH'),
  createFreeAgentOverride('Luke Schenn', 'BUF', 'VAN'),
  createFreeAgentOverride('Zac Jones', 'BUF', 'UTA'),
  // From CGY
  createFreeAgentOverride('Justin Kirkland', 'CGY', 'MIN'),
  createFreeAgentOverride('Ryan Lomberg', 'CGY', 'CBJ'),
  createFreeAgentOverride('Victor Olofsson', 'CGY', 'VGK'),
  createFreeAgentOverride('John Beecher', 'CGY', 'FLA'),
  // From CAR
  createFreeAgentOverride('John Carlson', 'CAR', 'TBL'),
  createFreeAgentOverride('Ryan Suzuki', 'CAR', 'OTT'),
  createFreeAgentOverride('Domenick Fensore', 'CAR', 'COL'),
  // From CHI
  createFreeAgentOverride('Sam Lafferty', 'CHI', 'FLA'),
  createFreeAgentOverride('Ilya Mikheyev', 'CHI', 'TBL'),
  // From COL
  createFreeAgentOverride('Jack Ahcan', 'COL', 'NSH'),
  createFreeAgentOverride('Alex Barre-Boulet', 'COL', 'SJS'),
  createFreeAgentOverride('Tye Felhaber', 'COL', 'SJS'),
  createFreeAgentOverride('Joel Kiviranta', 'COL', 'DAL'),
  createFreeAgentOverride('Jacob MacDonald', 'COL', 'WSH'),
  createFreeAgentOverride('Jason Polin', 'COL', 'BUF'),
  createFreeAgentOverride('Matt Stienburg', 'COL', 'VAN'),
  // From CBJ
  createFreeAgentOverride('Zach Aston-Reese', 'CBJ', 'PHI'),
  createFreeAgentOverride('Brendan Gaunce', 'CBJ', 'BOS'),
  createFreeAgentOverride('Boone Jenner', 'CBJ', 'WSH'),
  createFreeAgentOverride('Mason Marchment', 'CBJ', 'SJS'),
  // From DAL
  createFreeAgentOverride('Alexander Petrovic', 'DAL', 'FLA'),
  createFreeAgentOverride('Vladislav Kolyachonok', 'DAL', 'NJD'),
  // From DET
  createFreeAgentOverride('Erik Gustafsson', 'DET', 'LAK'),
  createFreeAgentOverride('Eduards Tralmaks', 'DET', 'EDM'),
  createFreeAgentOverride('Antti Tuomisto', 'DET', 'VGK'),
  // From EDM
  createFreeAgentOverride('Cam Dineen', 'EDM', 'PHI'),
  createFreeAgentOverride('James Hamblin', 'EDM', 'ANA'),
  createFreeAgentOverride('Jack Roslovic', 'EDM', 'TOR'),
  createFreeAgentOverride('Samuel Poulin', 'EDM', 'MTL'),
  // From FLA
  createFreeAgentOverride('Noah Gregor', 'FLA', 'WPG'),
  createFreeAgentOverride('Vinnie Hinostroza', 'FLA', 'COL'),
  createFreeAgentOverride('Jack Studnicka', 'FLA', 'PHI'),
  createFreeAgentOverride('Mike Benning', 'FLA', 'CGY'),
  createFreeAgentOverride('Wilmer Skoog', 'FLA', 'DET'),
  // From LAK
  createFreeAgentOverride('Kyle Burroughs', 'LAK', 'DAL'),
  createFreeAgentOverride('Glenn Gawdin', 'LAK', 'NYR'),
  createFreeAgentOverride('Mathieu Joseph', 'LAK', 'EDM'),
  createFreeAgentOverride('Andrei Kuzmenko', 'LAK', 'PIT'),
  createFreeAgentOverride('Jeff Malott', 'LAK', 'ANA'),
  // From MIN
  createFreeAgentOverride('Ben Jones', 'MIN', 'CGY'),
  createFreeAgentOverride('Mats Zuccarello', 'MIN', 'LAK'),
  createFreeAgentOverride('Cameron Butler', 'MIN', 'DET'),
  // From MTL
  createFreeAgentOverride('Sammy Blais', 'MTL', 'OTT'),
  createFreeAgentOverride('Marc Del Gaizo', 'MTL', 'NYR'),
  createFreeAgentOverride('Joe Veleno', 'MTL', 'NYR'),
  // From NSH
  createFreeAgentOverride('Andreas Englund', 'NSH', 'CGY'),
  createFreeAgentOverride('Erik Haula', 'NSH', 'LAK'),
  // From NJD
  createFreeAgentOverride('Dennis Cholowski', 'NJD', 'NYR'),
  createFreeAgentOverride('Brian Halonen', 'NJD', 'BOS'),
  createFreeAgentOverride('Zack MacEwen', 'NJD', 'TOR'),
  createFreeAgentOverride('Colton White', 'NJD', 'CBJ'),
  createFreeAgentOverride('Paul Cotter', 'NJD', 'VAN'),
  // From NYI
  createFreeAgentOverride('Anders Lee', 'NYI', 'UTA'),
  createFreeAgentOverride('Adam Beckman', 'NYI', 'COL'),
  createFreeAgentOverride('Cole McWard', 'NYI', 'TOR'),
  createFreeAgentOverride('Travis Mitchell', 'NYI', 'ANA'),
  createFreeAgentOverride('Marc Gatcomb', 'NYI', 'VGK'),
  createFreeAgentOverride('Maxim Shabanov', 'NYI', 'MIN', ['Max Shabanov']),
  // From NYR
  createFreeAgentOverride('Jonny Brodzinski', 'NYR', 'WSH'),
  createFreeAgentOverride('Casey Fitzgerald', 'NYR', 'FLA'),
  createFreeAgentOverride('Trey Fix-Wolansky', 'NYR', 'VAN'),
  createFreeAgentOverride('Connor Mackey', 'NYR', 'CHI'),
  createFreeAgentOverride('Conor Sheary', 'NYR', 'BUF'),
  // From OTT
  createFreeAgentOverride('Lars Eller', 'OTT', 'FLA'),
  createFreeAgentOverride('Dennis Gilbert', 'OTT', 'BUF'),
  createFreeAgentOverride('Nick Jensen', 'OTT', 'ANA'),
  // From PHI
  createFreeAgentOverride('Noah Juulsen', 'PHI', 'COL'),
  createFreeAgentOverride('Lane Pederson', 'PHI', 'LAK'),
  createFreeAgentOverride('Adam Ginning', 'PHI', 'VGK'),
  createFreeAgentOverride('Maxence Guenette', 'PHI', 'BOS', ['Max Guenette']),
  createFreeAgentOverride('Christian Kyrou', 'PHI', 'OTT'),
  createFreeAgentOverride('Philip Tomasino', 'PHI', 'OTT'),
  // From PIT
  createFreeAgentOverride('Noel Acciari', 'PIT', 'PHI'),
  createFreeAgentOverride('Connor Clifton', 'PIT', 'BOS'),
  createFreeAgentOverride('Bokondji Imama', 'PIT', 'FLA'),
  createFreeAgentOverride('Ryan Shea', 'PIT', 'EDM'),
  // From SJS
  createFreeAgentOverride('Vincent Desharnais', 'SJS', 'WSH'),
  createFreeAgentOverride('Mario Ferraro', 'SJS', 'WPG'),
  createFreeAgentOverride('Jett Woo', 'SJS', 'ANA'),
  // From SEA
  createFreeAgentOverride('Jamie Oleksiak', 'SEA', 'VAN'),
  createFreeAgentOverride('Jaden Schwartz', 'SEA', 'COL'),
  // From STL
  createFreeAgentOverride('Justin Holl', 'STL', 'WSH'),
  createFreeAgentOverride('Hunter Skinner', 'STL', 'NSH'),
  createFreeAgentOverride('Akil Thomas', 'STL', 'VAN'),
  createFreeAgentOverride('Matthew Kessel', 'STL', 'NYI'),
  // From TBL
  createFreeAgentOverride('Oliver Bjorkstrand', 'TBL', 'NYR'),
  createFreeAgentOverride('Corey Perry', 'TBL', 'LAK'),
  createFreeAgentOverride('Declan Carlile', 'TBL', 'PIT'),
  // From TOR
  createFreeAgentOverride('Matias Maccelli', 'TOR', 'NYI'),
  createFreeAgentOverride('Henry Thrun', 'TOR', 'WPG'),
  // From UTA
  createFreeAgentOverride('Ian Cole', 'UTA', 'CHI'),
  createFreeAgentOverride('Alexander Kerfoot', 'UTA', 'NSH'),
  createFreeAgentOverride('Scott Perunovich', 'UTA', 'LAK'),
  // From VAN
  createFreeAgentOverride('Teddy Blueger', 'VAN', 'TOR'),
  createFreeAgentOverride('Curtis Douglas', 'VAN', 'SEA'),
  createFreeAgentOverride('Danila Klimovich', 'VAN', 'PHI'),
  createFreeAgentOverride('Chase Stillman', 'VAN', 'DET'),
  // From VGK
  createFreeAgentOverride('Colton Sissons', 'VGK', 'TOR'),
  createFreeAgentOverride('Cole Smith', 'VGK', 'CHI'),
  // From WSH
  createFreeAgentOverride('Brandon Duhaime', 'WSH', 'TOR'),
  createFreeAgentOverride('Brett Leason', 'WSH', 'SJS'),
  createFreeAgentOverride('Corey Schueneman', 'WSH', 'ANA'),
  createFreeAgentOverride('Trevor van Riemsdyk', 'WSH', 'PIT'),
  createFreeAgentOverride('Henrik Rybinski', 'WSH', 'TOR'),
  // From WPG
  createFreeAgentOverride('Jacob Bryson', 'WPG', 'DET'),
  createFreeAgentOverride('Mason Shaw', 'WPG', 'MIN'),
  createFreeAgentOverride('Ville Heinola', 'WPG', 'VGK'),
];

export function getDraftNewsTeamLogoUrl(
  teamAbbreviation: string
): string {
  return `https://assets.nhle.com/logos/nhl/svg/${teamAbbreviation.toUpperCase()}_light.svg`;
}

function normalizeDraftPlayerName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const DRAFT_NEWS_BY_ASSET_KEY = new Map<
  string,
  DraftPlayerNewsOverride
>();

const DRAFT_NEWS_BY_PLAYER_ID = new Map<
  number,
  DraftPlayerNewsOverride
>();

const DRAFT_NEWS_BY_PLAYER_NAME = new Map<
  string,
  DraftPlayerNewsOverride
>();

for (const override of DRAFT_PLAYER_NEWS_OVERRIDES) {
  if (override.assetKey) {
    DRAFT_NEWS_BY_ASSET_KEY.set(
      override.assetKey,
      override
    );
  }

  if (typeof override.playerId === 'number') {
    DRAFT_NEWS_BY_PLAYER_ID.set(
      override.playerId,
      override
    );
  }

  const overrideNames = [
    override.playerName,
    ...(override.playerAliases ?? [])
  ].filter((name): name is string => Boolean(name));

  for (const name of overrideNames) {
    DRAFT_NEWS_BY_PLAYER_NAME.set(
      normalizeDraftPlayerName(name),
      override
    );
  }
}

export function getDraftNewsOverrideForAsset(
  asset: DraftableAsset
): DraftPlayerNewsOverride | null {
  let matchingOverride =
    DRAFT_NEWS_BY_ASSET_KEY.get(asset.assetKey) ?? null;

  if (!matchingOverride && asset.assetType === 'skater') {
    matchingOverride =
      DRAFT_NEWS_BY_PLAYER_ID.get(asset.player.id) ??
      DRAFT_NEWS_BY_PLAYER_NAME.get(
        normalizeDraftPlayerName(asset.player.fullName)
      ) ??
      null;
  }

  if (!matchingOverride) {
    return null;
  }

  if (
    asset.assetType === 'skater' &&
    matchingOverride.newTeamAbbreviation &&
    matchingOverride.newTeamAbbreviation.toUpperCase() ===
      asset.player.nhlTeamAbbreviation.toUpperCase() &&
    !matchingOverride.previousTeamAbbreviation &&
    !matchingOverride.injuryStatus &&
    !matchingOverride.note
  ) {
    return null;
  }

  return {
    ...matchingOverride,
    previousTeamAbbreviation:
      matchingOverride.previousTeamAbbreviation?.toUpperCase(),
    newTeamAbbreviation:
      matchingOverride.newTeamAbbreviation?.toUpperCase()
  };
}