export interface PixelLogoItem {
  abbreviation: string;
  logoUrl: string;
}

interface PixelTeamPalette extends PixelLogoItem {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  tertiaryColor: string;
}

export type TeamIdentityVariantKind =
  | 'home'
  | 'away'
  | 'alternate'
  | 'heritage'
  | 'special';

export type TeamIdentityUnlockRequirement =
  | 'default'
  | 'first-line-change'
  | 'commissioner-mode'
  | 'league-explorer'
  | 'crowded-schedule';

export interface TeamIdentityUnlockDetail {
  challengeTitle: string;
  rewardLabel: string;
  description: string;
}

export const TEAM_IDENTITY_UNLOCK_DETAILS: Record<
  TeamIdentityUnlockRequirement,
  TeamIdentityUnlockDetail
> = {
  default: {
    challengeTitle: 'Starter Identity',
    rewardLabel: 'Current home identities',
    description: 'Available to every RinkRat manager.',
  },
  'first-line-change': {
    challengeTitle: 'First Line Change',
    rewardLabel: 'Every team’s away identity',
    description: 'Join a fantasy hockey league.',
  },
  'commissioner-mode': {
    challengeTitle: 'Commissioner Mode',
    rewardLabel: 'Every team’s retro identity',
    description: 'Create or manage a league.',
  },
  'league-explorer': {
    challengeTitle: 'League Explorer',
    rewardLabel: 'Every team’s alternate identity',
    description: 'Compete in three different leagues.',
  },
  'crowded-schedule': {
    challengeTitle: 'Crowded Schedule',
    rewardLabel: 'Every remaining special identity',
    description: 'Face at least ten fantasy opponents.',
  },
};

export interface PixelTeamTheme extends PixelTeamPalette {
  /** Stable ID stored in the user profile. */
  variantId: string;
  /** Human-readable identity-pack title shown on the account page. */
  variantLabel: string;
  /** Short title used in compact badges. */
  variantShortLabel: string;
  variantDescription: string;
  variantKind: TeamIdentityVariantKind;
  unlockRequirement: TeamIdentityUnlockRequirement;
  eraLabel?: string;
  /** A visible team color for borders and focus states on the dark app canvas. */
  accentColor: string;
  /** Legacy alias retained for older page components. */
  highlightColor: string;
  primaryTextColor: string;
  secondaryTextColor: string;
  tertiaryTextColor: string;
}

interface TeamIdentityVariantDefinition {
  id: string;
  label: string;
  shortLabel?: string;
  description: string;
  kind: TeamIdentityVariantKind;
  unlockRequirement: TeamIdentityUnlockRequirement;
  eraLabel?: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  tertiaryColor?: string;
  accentColor?: string;
}

const DARK_APP_SURFACE = '#0d1520';
export const DEFAULT_TEAM_IDENTITY_VARIANT_ID = 'current-home';
export const RINKRAT_NEUTRAL_ABBREVIATION = 'RR';

const RINKRAT_NEUTRAL_PALETTE: PixelTeamPalette = {
  abbreviation: RINKRAT_NEUTRAL_ABBREVIATION,
  name: 'RinkRat Colors',
  primaryColor: '#26384C',
  secondaryColor: '#D6E2EE',
  tertiaryColor: '#C94F5D',
  logoUrl: '/assets/branding/rinkrat-headshot.png',
};

const NHL_TEAM_PALETTES: PixelTeamPalette[] = [
  team('ANA', 'Anaheim Ducks', '#FC4C02', '#B9975B', '#000000'),
  team('BOS', 'Boston Bruins', '#000000', '#FFB81C', '#FFFFFF'),
  team('BUF', 'Buffalo Sabres', '#002654', '#FFB81C', '#FFFFFF'),
  team('CGY', 'Calgary Flames', '#C8102E', '#F1BE48', '#FFFFFF'),
  team('CAR', 'Carolina Hurricanes', '#CC0000', '#000000', '#A2AAAD'),
  team('CHI', 'Chicago Blackhawks', '#CF0A2C', '#000000', '#FFFFFF'),
  team('COL', 'Colorado Avalanche', '#6F263D', '#236192', '#A2AAAD'),
  team('CBJ', 'Columbus Blue Jackets', '#041E42', '#CE1126', '#A2AAAD'),
  team('DAL', 'Dallas Stars', '#006847', '#111111', '#8F8F8C'),
  team('DET', 'Detroit Red Wings', '#CE1126', '#FFFFFF', '#111111'),
  team('EDM', 'Edmonton Oilers', '#041E42', '#FF4C00', '#FFFFFF'),
  team('FLA', 'Florida Panthers', '#C8102E', '#041E42', '#B9975B'),
  team('LAK', 'Los Angeles Kings', '#111111', '#A2AAAD', '#FFFFFF'),
  team('MIN', 'Minnesota Wild', '#154734', '#A6192E', '#EAAA00'),
  team('MTL', 'Montreal Canadiens', '#AF1E2D', '#192168', '#FFFFFF'),
  team('NSH', 'Nashville Predators', '#FFB81C', '#041E42', '#FFFFFF'),
  team('NJD', 'New Jersey Devils', '#CE1126', '#000000', '#FFFFFF'),
  team('NYI', 'New York Islanders', '#00539B', '#F47D30', '#FFFFFF'),
  team('NYR', 'New York Rangers', '#0038A8', '#CE1126', '#FFFFFF'),
  team('OTT', 'Ottawa Senators', '#000000', '#C8102E', '#C69214'),
  team('PHI', 'Philadelphia Flyers', '#F74902', '#000000', '#FFFFFF'),
  team('PIT', 'Pittsburgh Penguins', '#000000', '#FCB514', '#FFFFFF'),
  team('SEA', 'Seattle Kraken', '#001628', '#99D9D9', '#E9072B'),
  team('SJS', 'San Jose Sharks', '#006D75', '#000000', '#EA7200'),
  team('STL', 'St. Louis Blues', '#00529B', '#FFB81C', '#FFFFFF'),
  team('TBL', 'Tampa Bay Lightning', '#002868', '#FFFFFF', '#111111'),
  team('TOR', 'Toronto Maple Leafs', '#003E7E', '#FFFFFF', '#A2AAAD'),
  team('UTA', 'Utah Mammoth', '#010101', '#69B3E7', '#FFFFFF'),
  team('VAN', 'Vancouver Canucks', '#00205B', '#00843D', '#FFFFFF'),
  team('VGK', 'Vegas Golden Knights', '#B9975B', '#333F42', '#C8102E'),
  team('WSH', 'Washington Capitals', '#C8102E', '#041E42', '#FFFFFF'),
  team('WPG', 'Winnipeg Jets', '#041E42', '#004C97', '#AC162C'),
];

/**
 * Full identity catalog. Each club receives one retro reward, one alternate
 * reward, and one special reward in addition to the universal home/away pair.
 * Historical logos use exact filenames from the NHL logo archive. Teams with
 * a verified secondary or alternate mark point to a dedicated local asset.
 * Alternate identities without a true alternate crest deliberately reuse the
 * current crest while still applying their distinct uniform-inspired palette.
 */
const SPECIAL_TEAM_VARIANTS: Record<string, TeamIdentityVariantDefinition[]> = {
  ANA: [
    heritage('ana-mighty-ducks', 'Mighty Ducks Classic', 'Mighty Ducks', 'Eggplant, jade, silver, and the original Anaheim attitude.', '1993–2006', '#532A8E', '#00A0B0', '#C4CED4', archivedLogo('ANA_19931994-19951996_light.svg')),
    alternate('ana-orange-alternate', 'Orange Alternate', 'Orange Alt', 'Orange County takes over with black and metallic-gold support.', '#FC4C02', '#111111', '#B9975B'),
    special('ana-wild-wing', 'Wild Wing Rush', 'Wild Wing', 'A high-energy purple, teal, and black throwback color rush.', '#3A165D', '#00A6B2', '#111111'),
  ],
  BOS: [
    heritage('bos-brown-gold', 'Brown & Gold Original', 'Brown & Gold', 'The Bruins’ earliest earthy brown and golden identity.', '1920s heritage', '#4B2E1E', '#D6A11D', '#F4E4C1', archivedLogo('BOS_19241925-19251926_light.svg')),
    alternate('bos-centennial-black', 'Centennial Black', 'Centennial', 'A clean black-first look with bold Boston gold.', '#050505', '#FFB81C', '#F2E6C9'),
    special('bos-pooh-bear', 'Pooh Bear Gold', 'Pooh Bear', 'A playful 1990s-inspired gold, brown, and black palette.', '#F6B800', '#4A2C1A', '#111111'),
  ],
  BUF: [
    heritage('buf-classic-royal', 'Classic Royal', 'Classic Royal', 'Royal blue, athletic gold, and white from Buffalo’s early years.', '1970s heritage', '#003087', '#FDBB30', '#FFFFFF', archivedLogo('BUF_19701971-19951996_light.svg')),
    alternate('buf-goathead', 'Goathead Black', 'Goathead', 'The aggressive black, red, silver, and white Buffalo identity.', '#111111', '#C8102E', '#A2AAAD', archivedLogo('BUF_19961997-19981999_light.svg')),
    special('buf-butterknives', 'Butterknives Red', 'Butterknives', 'A red-first late-1990s look with black and silver edges.', '#C8102E', '#111111', '#C4CED4'),
  ],
  CGY: [
    heritage('cgy-classic-red', 'Classic Red', 'Classic Red', 'Bright Flames red, yellow, and white from the Cup-era look.', '1980s heritage', '#C8102E', '#F1BE48', '#FFFFFF', archivedLogo('CGY_19801981-19931994_light.svg')),
    alternate('cgy-blasty', 'Blasty Black', 'Blasty', 'The fire-breathing black alternate with red and gold heat.', '#111111', '#C8102E', '#F1BE48'),
    special('cgy-heritage-white', 'Heritage White', 'Heritage White', 'An ice-white classic with red shoulders and yellow highlights.', '#F8F4E8', '#C8102E', '#F1BE48'),
  ],
  CAR: [
    heritage('car-whalers-classic', 'Whalers Classic', 'Whalers', 'The Hartford-inspired blue, green, and white heritage identity.', '1979–1992 heritage', '#005F83', '#046A38', '#FFFFFF', archivedLogo('HFD_19791980-19911992_light.svg')),
    alternate('car-black-alternate', 'Black Alternate', 'Black Alt', 'A black-first Hurricanes look with red and white highlights.', '#111111', '#CC0000', '#FFFFFF'),
    special('car-ice-storm', 'Ice Storm', 'Ice Storm', 'A blue-green-white color rush inspired by the franchise’s full history.', '#003B5C', '#00A499', '#FFFFFF'),
  ],
  CHI: [
    heritage('chi-vintage-cream', 'Vintage Cream', 'Vintage', 'A muted red, cream, black, and gold heritage presentation.', 'Original Six heritage', '#B31B34', '#F2E6C9', '#111111', archivedLogo('CHI_19261927-19561957_light.svg')),
    alternate('chi-winter-black', 'Winter Black', 'Winter Black', 'A black sweater identity with red and vintage-white trim.', '#111111', '#CF0A2C', '#E8DDC4'),
    special('chi-barber-pole', 'Barber Pole', 'Barber Pole', 'Historic horizontal red, black, and cream striping energy.', '#CF0A2C', '#111111', '#F4E4C1'),
  ],
  COL: [
    heritage('col-nordiques', 'Nordiques Heritage', 'Nordiques', 'Quebec blue, red, and white honoring the franchise before Denver.', '1979–1995 heritage', '#5DA9E9', '#E31837', '#FFFFFF', archivedLogo('QUE_19791980-19941995_light.svg')),
    alternate('col-blue-c', 'Colorado C Alternate', 'Colorado C', 'Mountain blue leads with burgundy and silver support.', '#236192', '#6F263D', '#A2AAAD'),
    special('col-rockies', 'Rockies Heritage', 'Rockies', 'Colorado hockey history in navy, red, gold, and white.', '#00205B', '#C8102E', '#FFB81C', archivedLogo('CLR_19761977-19811982_light.svg')),
  ],
  CBJ: [
    heritage('cbj-cannon-heritage', 'Cannon Heritage', 'Cannon', 'Union blue, cream, and red built around Columbus cannon tradition.', 'Civil War heritage', '#041E42', '#E7D9B5', '#CE1126', archivedLogo('CBJ_20002001-20062007_light.svg')),
    alternate('cbj-cannon-navy', 'Cannon Navy', 'Cannon Navy', 'A dark navy alternate with cream and red detail.', '#071A33', '#D7C9A3', '#CE1126'),
    special('cbj-union-blue', 'Union Blue Rush', 'Union Blue', 'Brighter union blue, metallic silver, and red for a fast modern look.', '#005EB8', '#A2AAAD', '#CE1126'),
  ],
  DAL: [
    heritage('dal-north-stars', 'North Stars Classic', 'North Stars', 'Minnesota green, yellow, and white from the franchise roots.', '1967–1991 heritage', '#00843D', '#FFB81C', '#FFFFFF', archivedLogo('MNS_19671968-19841985_light.svg')),
    alternate('dal-blackout', 'Blackout Neon', 'Blackout', 'Black, neon victory green, and silver under arena lights.', '#050505', '#00FF66', '#8F8F8C'),
    special('dal-mooterus', 'Mooterus Rush', 'Mooterus', 'A red, gold, green, and black early-2000s-inspired identity.', '#8A1538', '#C6A15B', '#006847'),
  ],
  DET: [
    heritage('det-cougars', 'Detroit Cougars', 'Cougars', 'Deep red, cream, and black from Detroit’s earliest NHL identity.', '1920s heritage', '#9E1B32', '#F3E2C7', '#111111', archivedLogo('DCG_19261927-19291930_light.svg')),
    alternate('det-black-red', 'Motor City Black', 'Motor City', 'A black-first Red Wings color rush with crisp red and white.', '#111111', '#CE1126', '#FFFFFF'),
    special('det-centennial-cream', 'Centennial Cream', 'Centennial', 'Vintage cream and Detroit red with a restrained charcoal edge.', '#F1E3C6', '#CE1126', '#333333'),
  ],
  EDM: [
    heritage('edm-royal-orange', 'Royal Blue Classic', 'Royal Classic', 'The bright royal blue and orange dynasty-era Oilers look.', '1980s heritage', '#003087', '#FF4C00', '#FFFFFF', archivedLogo('EDM_19791980-19851986_light.svg')),
    alternate('edm-navy-copper', 'Navy & Copper', 'Navy Copper', 'Deep navy, copper, silver, and red from the late-1990s identity.', '#041E42', '#B87333', '#A2AAAD', archivedLogo('EDM_19971998-20102011_light.svg')),
    special('edm-oil-drop', 'Oil Drop Gear', 'Oil Drop', 'A metallic navy, silver, and copper special-event palette.', '#071A33', '#A2AAAD', '#B87333'),
  ],
  FLA: [
    heritage('fla-leaping-panther', 'Leaping Panther', 'Leaping Panther', 'The original red, navy, gold, and white South Florida identity.', '1993–2016 heritage', '#C8102E', '#041E42', '#B9975B', archivedLogo('FLA_19992000-20152016_light.svg')),
    alternate('fla-powder-blue', 'Powder Blue', 'Powder Blue', 'A tropical powder-blue alternate with navy, red, and gold.', '#8ED8F8', '#041E42', '#C8102E'),
    special('fla-sunrise-cream', 'Sunrise Cream', 'Sunrise', 'Cream, navy, red, and gold inspired by South Florida sunshine.', '#F3E2C7', '#041E42', '#C8102E'),
  ],
  LAK: [
    heritage('lak-forum-blue-gold', 'Forum Blue & Gold', 'Forum Blue', 'The royal purple and gold identity of the early Kings.', '1967–1988 heritage', '#552583', '#FDB927', '#FFFFFF', archivedLogo('LAK_19671968-19741975_light.svg')),
    alternate('lak-chevron', '90s Chevron', 'Chevron', 'Black, silver, and white from the Gretzky-era crest.', '#111111', '#A2AAAD', '#FFFFFF', archivedLogo('LAK_19881989-19971998_light.svg')),
    special('lak-crown-purple', 'Crown Purple', 'Crown Purple', 'A modern purple, silver, black, and gold crown color rush.', '#4B2E83', '#A2AAAD', '#111111'),
  ],
  MIN: [
    heritage('min-north-stars', 'North Stars Heritage', 'North Stars', 'Minnesota green, yellow, and white shared across state hockey history.', 'Minnesota heritage', '#00843D', '#FFB81C', '#FFFFFF', archivedLogo('MNS_19671968-19841985_light.svg')),
    alternate('min-wheat-red', 'Wheat & Red', 'Wheat Red', 'A warm wheat base with Iron Range red and forest-green trim.', '#EAAA00', '#A6192E', '#154734'),
    special('min-78s', 'The 78s', 'The 78s', 'Green and gold with white, inspired by Minnesota’s newest heritage look.', '#154734', '#FFB81C', '#FFFFFF'),
  ],
  MTL: [
    heritage('mtl-centennial', 'Centennial Maroon', 'Centennial', 'Dark maroon, cream, and royal blue from early Canadiens history.', 'Centennial heritage', '#7A0019', '#F3E2C7', '#192168', archivedLogo('MTL_19191920-19201921_light.svg')),
    alternate('mtl-reverse-blue', 'Reverse Blue', 'Reverse Blue', 'Royal blue takes the lead with red and white supporting stripes.', '#192168', '#AF1E2D', '#FFFFFF'),
    special('mtl-barber-pole', 'Barber Pole Classic', 'Barber Pole', 'A bold historic red, blue, and white striped identity.', '#AF1E2D', '#192168', '#FFFFFF'),
  ],
  NSH: [
    heritage('nsh-navy-mustard', 'Navy & Mustard', 'Navy Mustard', 'The original deep navy and mustard-gold Predators era.', '1998–2011 heritage', '#041E42', '#D9A400', '#A2AAAD', archivedLogo('NSH_19981999-20102011_light.svg')),
    alternate('nsh-smashville-navy', 'Smashville Navy', 'Smashville', 'Navy-first with bright gold and ice-white trim.', '#041E42', '#FFB81C', '#FFFFFF'),
    special('nsh-gold-rush', 'Gold Rush', 'Gold Rush', 'Maximum Nashville gold with navy and silver highlights.', '#FFB81C', '#041E42', '#A2AAAD'),
  ],
  NJD: [
    heritage('njd-christmas', 'Red & Green Classic', 'Red Green', 'The Devils’ original red, green, and white color identity.', '1982–1992 heritage', '#CE1126', '#00843D', '#FFFFFF', archivedLogo('NJD_19821983-19911992_light.svg')),
    alternate('njd-jersey-black', 'Jersey Black', 'Jersey', 'A black alternate with red and white New Jersey detail.', '#111111', '#CE1126', '#FFFFFF'),
    special('njd-scouts', 'Scouts Heritage', 'Scouts', 'Blue, red, gold, and white honoring the franchise’s Kansas City roots.', '#003DA5', '#CE1126', '#FFB81C', archivedLogo('KCS_19741975-19761977_light.svg')),
  ],
  NYI: [
    heritage('nyi-dynasty', 'Dynasty Royal', 'Dynasty', 'Royal blue, orange, and white from the Islanders’ championship era.', '1980s heritage', '#00539B', '#F47D30', '#FFFFFF', archivedLogo('NYI_19721973-19941995_light.svg')),
    alternate('nyi-fisherman', 'Fisherman', 'Fisherman', 'Navy, teal, orange, and silver from the famous mid-1990s identity.', '#003B5C', '#00A6B2', '#F47D30', archivedLogo('NYI_19951996-19961997_light.svg')),
    special('nyi-stadium-navy', 'Stadium Navy', 'Stadium', 'A dark navy and orange outdoor-game color rush.', '#001E3C', '#F47D30', '#FFFFFF'),
  ],
  NYR: [
    heritage('nyr-heritage-shield', 'Heritage Shield', 'Heritage', 'Deep navy, red, cream, and white inspired by early Rangers marks.', 'Original Six heritage', '#001E62', '#CE1126', '#F3E2C7', archivedLogo('NYR_19261927-19341935_light.svg')),
    alternate('nyr-lady-liberty', 'Lady Liberty', 'Lady Liberty', 'Navy, royal blue, red, and silver from the Liberty-era alternate.', '#001E62', '#0038A8', '#CE1126'),
    special('nyr-winter-cream', 'Winter Classic Cream', 'Winter Cream', 'Cream, navy, and red with an outdoor-rink feel.', '#F3E2C7', '#001E62', '#CE1126'),
  ],
  OTT: [
    heritage('ott-original-2d', 'Original 2D', 'Original 2D', 'Black, red, gold, and white from Ottawa’s original modern era.', '1992–2007 heritage', '#111111', '#C8102E', '#C69214', archivedLogo('OTT_19921993-19961997_light.svg')),
    alternate('ott-heritage-o', 'Heritage O', 'Heritage O', 'A black sweater identity centered on red, cream, and gold.', '#111111', '#C8102E', '#F3E2C7'),
    special('ott-centurion-red', 'Centurion Red', 'Centurion', 'Red-first with black, gold, and white for a bold capital-city look.', '#C8102E', '#111111', '#C69214'),
  ],
  PHI: [
    heritage('phi-broad-street', 'Broad Street Classic', 'Broad Street', 'Burnt orange, black, and cream from the Flyers’ early years.', '1970s heritage', '#F74902', '#111111', '#F3E2C7', archivedLogo('PHI_19671968-19981999_light.svg')),
    alternate('phi-black-alternate', 'Black Alternate', 'Black Alt', 'Black leads with orange shoulders and white contrast.', '#111111', '#F74902', '#FFFFFF'),
    special('phi-cooperalls', 'Cooperalls Rush', 'Cooperalls', 'A full black-and-orange 1980s-inspired color rush.', '#050505', '#F74902', '#C4CED4'),
  ],
  PIT: [
    heritage('pit-robo-penguin', 'Robo Penguin', 'Robo Penguin', 'Black, vegas gold, white, and gray from the 1990s identity.', '1992–2002 heritage', '#111111', '#C5B358', '#A2AAAD', archivedLogo('PIT_19921993-19981999_light.svg')),
    alternate('pit-diagonal', 'Diagonal Pittsburgh', 'Diagonal', 'Classic black and athletic gold with the diagonal wordmark feel.', '#111111', '#FCB514', '#FFFFFF'),
    special('pit-blue-cream', 'Blue & Cream Original', 'Blue Cream', 'Powder blue, navy, and cream honoring the earliest Penguins years.', '#7BAFD4', '#041E42', '#F3E2C7', archivedLogo('PIT_19681969-19711972_light.svg')),
  ],
  SEA: [
    heritage('sea-metropolitans', 'Metropolitans Heritage', 'Metropolitans', 'Deep green, red, cream, and white honoring Seattle hockey history.', '1917 heritage', '#004B3F', '#C8102E', '#F3E2C7'),
    alternate('sea-ice-blue', 'Ice Blue Alternate', 'Ice Blue', 'Ice blue leads with deep sea navy and red alert accents.', '#99D9D9', '#001628', '#E9072B'),
    special('sea-deep-sea-red', 'Deep Sea Red', 'Deep Sea Red', 'A red-alert color rush with abyss navy and ice blue.', '#E9072B', '#001628', '#99D9D9'),
  ],
  SJS: [
    heritage('sjs-original-teal', 'Original Teal', 'Original Teal', 'The inaugural teal, black, silver, and white Sharks identity.', '1991–1998 heritage', '#006D75', '#111111', '#A2AAAD', archivedLogo('SJS_19911992-19971998_light.svg')),
    alternate('sjs-stealth', 'Stealth Black', 'Stealth', 'Black, teal, and orange built for a dark-arena look.', '#050505', '#006D75', '#EA7200', customLogo('sjs-alt-fin-circle-v2.png')),
    special('sjs-golden-seals', 'Golden Seals Heritage', 'Golden Seals', 'Kelly green, california gold, and white honoring Bay Area hockey roots.', '#00843D', '#FFB81C', '#FFFFFF', archivedLogo('CGS_19701971-19731974_light.svg')),
  ],
  STL: [
    heritage('stl-trumpet-90s', '90s Trumpet', '90s Trumpet', 'Royal blue, red, yellow, and white from St. Louis’s bold 1990s era.', '1995–1998 heritage', '#00529B', '#C8102E', '#FFB81C', archivedLogo('STL_19891990-19971998_light.svg')),
    alternate('stl-powder-blue', 'Heritage Powder Blue', 'Powder Blue', 'Powder blue, navy, yellow, and white with a classic music-note feel.', '#7BAFD4', '#002F6C', '#FFB81C'),
    special('stl-winter-cream', 'Winter Classic Cream', 'Winter Cream', 'Cream, royal blue, and yellow for an outdoor-rink identity.', '#F3E2C7', '#00529B', '#FFB81C'),
  ],
  TBL: [
    heritage('tbl-black-storm', 'Black Storm', 'Black Storm', 'Black, royal blue, silver, and white from Tampa Bay’s first identity.', '1992–2007 heritage', '#111111', '#0055A5', '#A2AAAD', archivedLogo('TBL_19921993-20002001_light.svg')),
    alternate('tbl-black-blue', 'Black & Blue', 'Black Blue', 'Black-first with electric blue and white lightning accents.', '#050505', '#002868', '#FFFFFF'),
    special('tbl-gasparilla', 'Gasparilla Cream', 'Gasparilla', 'Cream, navy, silver, and electric blue with a Gulf Coast feel.', '#F3E2C7', '#002868', '#A2AAAD'),
  ],
  TOR: [
    heritage('tor-st-pats', 'St. Pats Green', 'St. Pats', 'Kelly green, white, and cream honoring the Toronto St. Patricks.', '1919–1927 heritage', '#00843D', '#FFFFFF', '#F3E2C7', archivedLogo('TSP_19191920-19211922_light.svg')),
    alternate('tor-next-gen-black', 'Next Gen Black', 'Next Gen', 'Black and blue with white for Toronto’s modern alternate identity.', '#111111', '#003E7E', '#FFFFFF'),
    special('tor-arenas', 'Arenas Heritage', 'Arenas', 'Deep blue, vintage white, and silver inspired by Toronto’s earliest club.', '#00205B', '#F3E2C7', '#A2AAAD', archivedLogo('TAN_19171918-19181919_light.svg')),
  ],
  UTA: [
    heritage('uta-hockey-club', 'Utah Hockey Club', 'Hockey Club', 'Black, mountain blue, and white from Utah’s first NHL season.', '2024–2025 heritage', '#010101', '#69B3E7', '#FFFFFF', archivedLogo('UTA_20242025-20242025_light.svg')),
    alternate('uta-ice-blue', 'Mammoth Ice Blue', 'Ice Blue', 'Mountain blue leads with black and snow-white accents.', '#69B3E7', '#010101', '#FFFFFF'),
    special('uta-desert-night', 'Desert Night', 'Desert Night', 'A creative copper, midnight, ice-blue, and white Utah color rush.', '#1E1A2B', '#B87333', '#69B3E7'),
  ],
  VAN: [
    heritage('van-flying-skate', 'Flying Skate', 'Flying Skate', 'Black, red, and yellow from Vancouver’s high-speed 1980s identity.', '1978–1997 heritage', '#111111', '#C8102E', '#FFB81C', archivedLogo('VAN_19781979-19911992_light.svg')),
    alternate('van-millionaires', 'Millionaires Maroon', 'Millionaires', 'Maroon, cream, and white honoring Vancouver’s early champions.', '#6F263D', '#F3E2C7', '#FFFFFF'),
    special('van-west-coast', 'West Coast Orca', 'West Coast', 'Navy, deep red, silver, and white from the early-2000s coast identity.', '#00205B', '#862633', '#A2AAAD'),
  ],
  VGK: [
    heritage('vgk-inaugural', 'Inaugural Steel', 'Inaugural', 'Steel gray, vegas gold, red, and black from the franchise’s first run.', '2017 heritage', '#333F42', '#B9975B', '#C8102E', archivedLogo('VGK_light.svg')),
    alternate('vgk-gold-jersey', 'Gold Jersey', 'Gold Jersey', 'Vegas gold leads with steel gray, black, and red, using the crossed-swords secondary mark.', '#B9975B', '#333F42', '#111111', customLogo('vgk-alt-crossed-swords-v2.png')),
    special('vgk-reverse-red', 'Reverse Retro Red', 'Reverse Red', 'A red-first Las Vegas color rush with gold, black, and white.', '#C8102E', '#B9975B', '#111111'),
  ],
  WSH: [
    heritage('wsh-screaming-eagle', 'Screaming Eagle', 'Screaming Eagle', 'Blue, black, copper, and white from the late-1990s Capitals era.', '1995–2002 heritage', '#002D62', '#111111', '#B87333', archivedLogo('WSH_19951996-20062007_light.svg')),
    alternate('wsh-weagle', 'Weagle Navy', 'Weagle', 'Navy, red, and white built around Washington’s eagle identity.', '#041E42', '#C8102E', '#FFFFFF', archivedLogo('WSH_secondary_light.svg')),
    special('wsh-capital-dome', 'Capital Dome Classic', 'Capital Dome', 'Bright red, royal blue, and white honoring the original Capitals look.', '#C8102E', '#0033A0', '#FFFFFF', archivedLogo('WSH_19741975-19941995_light.svg')),
  ],
  WPG: [
    heritage('wpg-classic-jets', 'Classic Jets', 'Classic Jets', 'Royal blue, red, and white from Winnipeg’s original NHL era.', '1979–1990 heritage', '#005EB8', '#C8102E', '#FFFFFF', archivedLogo('WIN_19791980-19891990_light.svg')),
    alternate('wpg-aviator', 'Aviator Blue', 'Aviator', 'A lighter aviator blue with navy, red, and white details.', '#7BAFD4', '#041E42', '#AC162C'),
    special('wpg-heritage-white', 'Heritage White', 'Heritage White', 'Ice white, navy, royal blue, and red in a classic Winnipeg layout.', '#F7FAFC', '#041E42', '#004C97'),
  ],
};

const NHL_TEAM_VARIANTS = new Map<string, PixelTeamTheme[]>();

NHL_TEAM_VARIANTS.set(RINKRAT_NEUTRAL_ABBREVIATION, [
  buildTheme(RINKRAT_NEUTRAL_PALETTE, {
    id: DEFAULT_TEAM_IDENTITY_VARIANT_ID,
    label: 'RinkRat Neutral',
    shortLabel: 'Neutral',
    description: 'A clean RinkRat palette for managers who have not picked an NHL favorite.',
    kind: 'home',
    unlockRequirement: 'default',
    eraLabel: 'RinkRat',
    accentColor: '#74B9DF',
  }),
]);

for (const palette of NHL_TEAM_PALETTES) {
  NHL_TEAM_VARIANTS.set(palette.abbreviation, [
    buildTheme(palette, {
      id: DEFAULT_TEAM_IDENTITY_VARIANT_ID,
      label: 'Current Home',
      shortLabel: 'Home',
      description: 'The current primary team identity and home-color emphasis.',
      kind: 'home',
      unlockRequirement: 'default',
      eraLabel: 'Current',
    }),
    buildTheme(palette, {
      id: 'current-away',
      label: 'Current Away',
      shortLabel: 'Away',
      description: 'An ice-white version that keeps the club colors as the main accents.',
      kind: 'away',
      unlockRequirement: 'first-line-change',
      eraLabel: 'Current',
      primaryColor: '#F7FAFC',
      secondaryColor: palette.primaryColor,
      tertiaryColor: palette.secondaryColor,
      accentColor: chooseVisibleAccent([
        palette.primaryColor,
        palette.secondaryColor,
        palette.tertiaryColor,
      ]),
    }),
    ...(SPECIAL_TEAM_VARIANTS[palette.abbreviation] ?? []).map((variant) =>
      buildTheme(palette, variant),
    ),
  ]);
}

export const NHL_PIXEL_TEAMS: PixelTeamTheme[] = NHL_TEAM_PALETTES.map(
  (palette) => NHL_TEAM_VARIANTS.get(palette.abbreviation)![0],
);

export const RINKRAT_NEUTRAL_THEME = NHL_TEAM_VARIANTS.get(
  RINKRAT_NEUTRAL_ABBREVIATION,
)![0];

export const USER_SELECTABLE_PIXEL_THEMES: PixelTeamTheme[] = [
  RINKRAT_NEUTRAL_THEME,
  ...NHL_PIXEL_TEAMS,
];

const NHL_TEAM_ABBREVIATIONS = NHL_PIXEL_TEAMS.map((teamTheme) => teamTheme.abbreviation);

function team(
  abbreviation: string,
  name: string,
  primaryColor: string,
  secondaryColor: string,
  tertiaryColor: string,
): PixelTeamPalette {
  return {
    abbreviation,
    name,
    primaryColor,
    secondaryColor,
    tertiaryColor,
    logoUrl: getNhlLogoUrl(abbreviation),
  };
}

function heritage(
  id: string,
  label: string,
  shortLabel: string,
  description: string,
  eraLabel: string,
  primaryColor: string,
  secondaryColor: string,
  tertiaryColor: string,
  logoUrl?: string,
): TeamIdentityVariantDefinition {
  return {
    id,
    label,
    shortLabel,
    description,
    kind: 'heritage',
    unlockRequirement: 'commissioner-mode',
    eraLabel,
    primaryColor,
    secondaryColor,
    tertiaryColor,
    logoUrl,
  };
}

function alternate(
  id: string,
  label: string,
  shortLabel: string,
  description: string,
  primaryColor: string,
  secondaryColor: string,
  tertiaryColor: string,
  logoUrl?: string,
): TeamIdentityVariantDefinition {
  return {
    id,
    label,
    shortLabel,
    description,
    kind: 'alternate',
    unlockRequirement: 'league-explorer',
    eraLabel: 'Alternate',
    primaryColor,
    secondaryColor,
    tertiaryColor,
    logoUrl,
  };
}

function special(
  id: string,
  label: string,
  shortLabel: string,
  description: string,
  primaryColor: string,
  secondaryColor: string,
  tertiaryColor: string,
  logoUrl?: string,
): TeamIdentityVariantDefinition {
  return {
    id,
    label,
    shortLabel,
    description,
    kind: 'special',
    unlockRequirement: 'crowded-schedule',
    eraLabel: 'Special identity',
    primaryColor,
    secondaryColor,
    tertiaryColor,
    logoUrl,
  };
}

function archivedLogo(fileName: string): string {
  return `/assets/team-identity-logos/${fileName}`;
}

function customLogo(fileName: string): string {
  return `/assets/team-identity-logos/custom/${fileName}?v=20260729-2`;
}

function buildTheme(
  palette: PixelTeamPalette,
  variant: TeamIdentityVariantDefinition,
): PixelTeamTheme {
  const primaryColor = variant.primaryColor ?? palette.primaryColor;
  const secondaryColor = variant.secondaryColor ?? palette.secondaryColor;
  const tertiaryColor = variant.tertiaryColor ?? palette.tertiaryColor;
  const accentColor =
    variant.accentColor ?? chooseVisibleAccent([primaryColor, secondaryColor, tertiaryColor]);

  return {
    abbreviation: palette.abbreviation,
    name: palette.name,
    logoUrl: variant.logoUrl ?? palette.logoUrl,
    primaryColor,
    secondaryColor,
    tertiaryColor,
    variantId: variant.id,
    variantLabel: variant.label,
    variantShortLabel: variant.shortLabel ?? variant.label,
    variantDescription: variant.description,
    variantKind: variant.kind,
    unlockRequirement: variant.unlockRequirement,
    eraLabel: variant.eraLabel,
    accentColor,
    highlightColor: accentColor,
    primaryTextColor: getReadableTextColor(primaryColor),
    secondaryTextColor: getReadableTextColor(secondaryColor),
    tertiaryTextColor: getReadableTextColor(tertiaryColor),
  };
}

function normalizeHex(hexColor: string): string {
  const normalized = hexColor.trim().replace('#', '');

  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    return normalized
      .split('')
      .map((character) => `${character}${character}`)
      .join('');
  }

  return /^[0-9a-f]{6}$/i.test(normalized) ? normalized : '000000';
}

function hexToRgb(hexColor: string): [number, number, number] {
  const normalized = normalizeHex(hexColor);

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance(hexColor: string): number {
  const [red, green, blue] = hexToRgb(hexColor).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function getContrastRatio(firstColor: string, secondColor: string): number {
  const firstLuminance = relativeLuminance(firstColor);
  const secondLuminance = relativeLuminance(secondColor);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

export function getReadableTextColor(backgroundColor: string): string {
  return getContrastRatio(backgroundColor, '#FFFFFF') >=
    getContrastRatio(backgroundColor, '#07111D')
    ? '#FFFFFF'
    : '#07111D';
}

function chooseVisibleAccent(colors: string[]): string {
  const identityColor = colors.find(
    (color) => getContrastRatio(color, DARK_APP_SURFACE) >= 3,
  );

  if (identityColor) {
    return identityColor;
  }

  return [...colors].sort(
    (first, second) =>
      getContrastRatio(second, DARK_APP_SURFACE) -
      getContrastRatio(first, DARK_APP_SURFACE),
  )[0];
}

export function hexToRgba(hexColor: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hexColor);
  const safeAlpha = Math.max(0, Math.min(1, alpha));

  return `rgba(${red}, ${green}, ${blue}, ${safeAlpha})`;
}

export function getNhlLogoUrl(abbreviation: string): string {
  const normalizedAbbreviation = abbreviation.trim().toUpperCase();

  if (normalizedAbbreviation === RINKRAT_NEUTRAL_ABBREVIATION) {
    return RINKRAT_NEUTRAL_PALETTE.logoUrl;
  }

  return `/assets/team-identity-logos/${normalizedAbbreviation}_light.svg`;
}

export function getTeamIdentityVariants(
  abbreviation: string | null | undefined,
): PixelTeamTheme[] {
  const normalizedAbbreviation =
    abbreviation?.toUpperCase() || RINKRAT_NEUTRAL_ABBREVIATION;

  return (
    NHL_TEAM_VARIANTS.get(normalizedAbbreviation) ??
    NHL_TEAM_VARIANTS.get(RINKRAT_NEUTRAL_ABBREVIATION)!
  );
}

export function getPixelTeamTheme(
  abbreviation: string | null | undefined,
  variantId?: string | null,
): PixelTeamTheme {
  const variants = getTeamIdentityVariants(abbreviation);

  return (
    variants.find((teamTheme) => teamTheme.variantId === variantId) ??
    variants.find(
      (teamTheme) => teamTheme.variantId === DEFAULT_TEAM_IDENTITY_VARIANT_ID,
    ) ??
    variants[0]
  );
}

export function buildPixelMarquee(offset = 0): PixelLogoItem[] {
  const visibleTeamCount = Math.min(16, NHL_TEAM_ABBREVIATIONS.length);
  const sequence = Array.from(
    { length: visibleTeamCount },
    (_, index) => NHL_TEAM_ABBREVIATIONS[(index + offset) % NHL_TEAM_ABBREVIATIONS.length],
  );

  // Duplicate the same sequence so translateX(-50%) loops seamlessly while
  // keeping the number of mobile DOM nodes and logo requests much smaller.
  return [...sequence, ...sequence].map((abbreviation) => ({
    abbreviation,
    logoUrl: getNhlLogoUrl(abbreviation),
  }));
}

/**
 * Builds one seamless marquee containing every NHL team exactly once per pass.
 * The sequence is duplicated so the shared layout can loop continuously.
 */
export function buildFullPixelMarquee(): PixelLogoItem[] {
  return [...NHL_TEAM_ABBREVIATIONS, ...NHL_TEAM_ABBREVIATIONS].map((abbreviation) => ({
    abbreviation,
    logoUrl: getNhlLogoUrl(abbreviation),
  }));
}
