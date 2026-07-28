export const PROFILE_ICON_CATEGORY_IDS = [
  'rink-rats',
  'jerseys',
  'misc-hockey',
] as const;

export type ProfileIconCategoryId = (typeof PROFILE_ICON_CATEGORY_IDS)[number];

export interface ProfileIconCategory {
  id: ProfileIconCategoryId;
  label: string;
  eyebrow: string;
  description: string;
}

export const PROFILE_ICON_CATEGORIES: readonly ProfileIconCategory[] = [
  {
    id: 'rink-rats',
    label: 'Rink Rats',
    eyebrow: 'Original Characters',
    description: 'Skaters, goalies, captains, and crease creatures from the RinkRat universe.',
  },
  {
    id: 'jerseys',
    label: 'Jerseys',
    eyebrow: 'Custom Sweaters',
    description: 'Fifteen original pixel jerseys with fictional colors, striping, and crest designs.',
  },
  {
    id: 'misc-hockey',
    label: 'Misc Hockey',
    eyebrow: 'Around the Rink',
    description: 'Equipment, officials, rink machinery, trophies, and other hockey favorites.',
  },
] as const;

export const PROFILE_ICON_IDS = [
  'emerald-visor',
  'red-line-rat',
  'purple-sniper',
  'teal-captain',
  'whiteout-goalie',
  'crease-split',
  'blue-line-blaster',
  'open-ice-hit',
  'masked-veteran',
  'water-break',
  'jersey-neon-diamond',
  'jersey-arcade-viper',
  'jersey-red-chevron',
  'jersey-royal-crest',
  'jersey-forest-cross',
  'jersey-speed-stripes',
  'jersey-north-star',
  'jersey-emerald-starburst',
  'jersey-pine-star',
  'jersey-violet-crystal',
  'jersey-ice-orbit',
  'jersey-wing-rush',
  'jersey-blue-compass',
  'jersey-frost-vortex',
  'jersey-teal-tide',
  'hockey-referee',
  'hockey-ice-resurfacer',
  'hockey-goalie-mask',
  'hockey-skates',
  'hockey-crossed-sticks',
  'hockey-visor-helmet',
  'hockey-goal-light',
  'hockey-goalie-gear',
  'hockey-championship-cup',
  'hockey-bench-gear',
] as const;

export type ProfileIconId = (typeof PROFILE_ICON_IDS)[number];

export interface ProfileIconOption {
  id: ProfileIconId;
  categoryId: ProfileIconCategoryId;
  label: string;
  description: string;
  assetPath: string;
  alt: string;
}

export const DEFAULT_PROFILE_ICON_ID: ProfileIconId = 'emerald-visor';

export const PROFILE_ICONS: readonly ProfileIconOption[] = [
  {
    id: 'emerald-visor',
    categoryId: 'rink-rats',
    label: 'Emerald Visor',
    description: 'Gray rink rat with green-and-gold gear, a clear visor, and a missing tooth.',
    assetPath: '/assets/profile-icons/emerald-visor.webp',
    alt: 'Gray rink rat in green and gold hockey gear wearing a clear visor',
  },
  {
    id: 'red-line-rat',
    categoryId: 'rink-rats',
    label: 'Red Line Rat',
    description: 'Gray skater in red, black, and white gear with an ear ring.',
    assetPath: '/assets/profile-icons/red-line-rat.webp',
    alt: 'Gray rink rat skating in red black and white hockey gear',
  },
  {
    id: 'purple-sniper',
    categoryId: 'rink-rats',
    label: 'Purple Sniper',
    description: 'White rink rat firing a quick shot in purple-and-white gear.',
    assetPath: '/assets/profile-icons/purple-sniper.webp',
    alt: 'White rink rat taking a hockey shot in purple and white gear',
  },
  {
    id: 'teal-captain',
    categoryId: 'rink-rats',
    label: 'Teal Captain',
    description: 'Brown captain with a confident grin and teal-and-gold colors.',
    assetPath: '/assets/profile-icons/teal-captain.webp',
    alt: 'Brown rink rat captain in teal and gold hockey gear',
  },
  {
    id: 'whiteout-goalie',
    categoryId: 'rink-rats',
    label: 'Whiteout Goalie',
    description: 'Dark-furred goalie in white gear with sharp red accents.',
    assetPath: '/assets/profile-icons/whiteout-goalie.webp',
    alt: 'Dark-furred rink rat goalie wearing white and red equipment',
  },
  {
    id: 'crease-split',
    categoryId: 'rink-rats',
    label: 'Crease Split',
    description: 'Dark-brown goalie stretching across the crease in black and orange.',
    assetPath: '/assets/profile-icons/crease-split.webp',
    alt: 'Dark-brown rink rat goalie making a split save in black and orange gear',
  },
  {
    id: 'blue-line-blaster',
    categoryId: 'rink-rats',
    label: 'Blue Line Blaster',
    description: 'Brown skater unloading a slap shot in navy and bright yellow.',
    assetPath: '/assets/profile-icons/blue-line-blaster.webp',
    alt: 'Brown rink rat taking a slap shot in navy and yellow hockey gear',
  },
  {
    id: 'open-ice-hit',
    categoryId: 'rink-rats',
    label: 'Open-Ice Hit',
    description: 'A black-and-orange rink rat stopping a rival with a clean body check.',
    assetPath: '/assets/profile-icons/open-ice-hit.webp',
    alt: 'Two rink rats colliding during a hockey game',
  },
  {
    id: 'masked-veteran',
    categoryId: 'rink-rats',
    label: 'Masked Veteran',
    description: 'Relaxed brown goalie in green gear and a classic slasher-style mask.',
    assetPath: '/assets/profile-icons/masked-veteran.webp',
    alt: 'Relaxed rink rat goalie in green gear wearing a white vintage hockey mask',
  },
  {
    id: 'water-break',
    categoryId: 'rink-rats',
    label: 'Water Break',
    description: 'White goalie taking a quick drink in purple-and-white equipment.',
    assetPath: '/assets/profile-icons/water-break.webp',
    alt: 'White rink rat goalie drinking water in purple and white equipment',
  },
  {
    id: 'jersey-neon-diamond',
    categoryId: 'jerseys',
    label: 'Neon Diamond',
    description: 'Black sweater with teal and magenta diamond striping.',
    assetPath: '/assets/profile-icons/jerseys/neon-diamond.webp',
    alt: 'Black teal and magenta fictional pixel hockey jersey',
  },
  {
    id: 'jersey-arcade-viper',
    categoryId: 'jerseys',
    label: 'Arcade Viper',
    description: 'Black sweater with electric lime and purple arcade details.',
    assetPath: '/assets/profile-icons/jerseys/arcade-viper.webp',
    alt: 'Black lime and purple fictional pixel hockey jersey',
  },
  {
    id: 'jersey-red-chevron',
    categoryId: 'jerseys',
    label: 'Red Chevron',
    description: 'Black and deep-red sweater with cream diagonal chevrons.',
    assetPath: '/assets/profile-icons/jerseys/red-chevron.webp',
    alt: 'Black red and cream fictional pixel hockey jersey',
  },
  {
    id: 'jersey-royal-crest',
    categoryId: 'jerseys',
    label: 'Royal Crest',
    description: 'Navy sweater with teal panels and a gold geometric crest.',
    assetPath: '/assets/profile-icons/jerseys/royal-crest.webp',
    alt: 'Navy teal and gold fictional pixel hockey jersey',
  },
  {
    id: 'jersey-forest-cross',
    categoryId: 'jerseys',
    label: 'Forest Cross',
    description: 'Deep green and charcoal sweater with copper crossed blades.',
    assetPath: '/assets/profile-icons/jerseys/forest-cross.webp',
    alt: 'Green charcoal and copper fictional pixel hockey jersey',
  },
  {
    id: 'jersey-speed-stripes',
    categoryId: 'jerseys',
    label: 'Speed Stripes',
    description: 'White sweater with energetic red and ice-blue diagonal striping.',
    assetPath: '/assets/profile-icons/jerseys/speed-stripes.webp',
    alt: 'White red and blue fictional pixel hockey jersey',
  },
  {
    id: 'jersey-north-star',
    categoryId: 'jerseys',
    label: 'North Star',
    description: 'White, royal-blue, and copper sweater with a compass crest.',
    assetPath: '/assets/profile-icons/jerseys/north-star.webp',
    alt: 'White blue and copper fictional pixel hockey jersey',
  },
  {
    id: 'jersey-emerald-starburst',
    categoryId: 'jerseys',
    label: 'Emerald Starburst',
    description: 'Emerald and cream sweater centered on a bright gold starburst.',
    assetPath: '/assets/profile-icons/jerseys/emerald-starburst.webp',
    alt: 'Emerald cream and gold fictional pixel hockey jersey',
  },
  {
    id: 'jersey-pine-star',
    categoryId: 'jerseys',
    label: 'Pine Star',
    description: 'Pine-green sweater with cream sleeves and a clean gold star.',
    assetPath: '/assets/profile-icons/jerseys/pine-star.webp',
    alt: 'Green cream and gold fictional pixel hockey jersey',
  },
  {
    id: 'jersey-violet-crystal',
    categoryId: 'jerseys',
    label: 'Violet Crystal',
    description: 'Lavender sweater with midnight shoulders and a crystal crest.',
    assetPath: '/assets/profile-icons/jerseys/violet-crystal.webp',
    alt: 'Lavender navy and white fictional pixel hockey jersey',
  },
  {
    id: 'jersey-ice-orbit',
    categoryId: 'jerseys',
    label: 'Ice Orbit',
    description: 'Ice-blue and navy sweater with an original circular puck crest.',
    assetPath: '/assets/profile-icons/jerseys/ice-orbit.webp',
    alt: 'Ice blue navy and white fictional pixel hockey jersey',
  },
  {
    id: 'jersey-wing-rush',
    categoryId: 'jerseys',
    label: 'Wing Rush',
    description: 'White sweater with red and blue speed-wing graphics.',
    assetPath: '/assets/profile-icons/jerseys/wing-rush.webp',
    alt: 'White red and blue fictional pixel hockey jersey with wing crest',
  },
  {
    id: 'jersey-blue-compass',
    categoryId: 'jerseys',
    label: 'Blue Compass',
    description: 'Royal-blue sweater with white shoulders and a copper compass.',
    assetPath: '/assets/profile-icons/jerseys/blue-compass.webp',
    alt: 'Blue white and orange fictional pixel hockey jersey',
  },
  {
    id: 'jersey-frost-vortex',
    categoryId: 'jerseys',
    label: 'Frost Vortex',
    description: 'White and powder-blue sweater with a navy swirling crest.',
    assetPath: '/assets/profile-icons/jerseys/frost-vortex.webp',
    alt: 'White powder blue and navy fictional pixel hockey jersey',
  },
  {
    id: 'jersey-teal-tide',
    categoryId: 'jerseys',
    label: 'Teal Tide',
    description: 'Black and teal sweater with silver bands and a curling wave.',
    assetPath: '/assets/profile-icons/jerseys/teal-tide.webp',
    alt: 'Black teal and silver fictional pixel hockey jersey',
  },
  {
    id: 'hockey-referee',
    categoryId: 'misc-hockey',
    label: 'The Ref',
    description: 'Striped official with orange armbands, helmet, and whistle.',
    assetPath: '/assets/profile-icons/misc-hockey/referee.webp',
    alt: 'Pixel art ice hockey referee wearing a striped jersey and helmet',
  },
  {
    id: 'hockey-ice-resurfacer',
    categoryId: 'misc-hockey',
    label: 'Ice Resurfacer',
    description: 'A blue-and-white rink machine ready for another clean sheet.',
    assetPath: '/assets/profile-icons/misc-hockey/ice-resurfacer.webp',
    alt: 'Pixel art blue and white ice resurfacing machine',
  },
  {
    id: 'hockey-goalie-mask',
    categoryId: 'misc-hockey',
    label: 'Goalie Mask',
    description: 'Classic white cage mask framed by a deep arena-blue glow.',
    assetPath: '/assets/profile-icons/misc-hockey/goalie-mask.webp',
    alt: 'Pixel art white hockey goalie mask and cage',
  },
  {
    id: 'hockey-skates',
    categoryId: 'misc-hockey',
    label: 'Fresh Steel',
    description: 'A clean pair of black skates with bright white laces and steel.',
    assetPath: '/assets/profile-icons/misc-hockey/hockey-skates.webp',
    alt: 'Pixel art pair of black ice hockey skates',
  },
  {
    id: 'hockey-crossed-sticks',
    categoryId: 'misc-hockey',
    label: 'Crossed Sticks',
    description: 'Two taped sticks and a puck in a classic hockey emblem.',
    assetPath: '/assets/profile-icons/misc-hockey/crossed-sticks.webp',
    alt: 'Pixel art crossed hockey sticks and puck emblem',
  },
  {
    id: 'hockey-visor-helmet',
    categoryId: 'misc-hockey',
    label: 'Modern Visor',
    description: 'Navy player helmet with a large clear visor.',
    assetPath: '/assets/profile-icons/misc-hockey/visor-helmet.webp',
    alt: 'Pixel art navy hockey helmet with clear visor',
  },
  {
    id: 'hockey-goal-light',
    categoryId: 'misc-hockey',
    label: 'Goal Light',
    description: 'Red goal frame, puck, and a glowing lamp after the score.',
    assetPath: '/assets/profile-icons/misc-hockey/goal-light.webp',
    alt: 'Pixel art hockey goal with puck and glowing red goal light',
  },
  {
    id: 'hockey-goalie-gear',
    categoryId: 'misc-hockey',
    label: 'Goalie Gear',
    description: 'White-and-navy blocker, leg pad, and catcher set.',
    assetPath: '/assets/profile-icons/misc-hockey/goalie-gear.webp',
    alt: 'Pixel art hockey goalie pads blocker and catcher',
  },
  {
    id: 'hockey-championship-cup',
    categoryId: 'misc-hockey',
    label: 'Championship Cup',
    description: 'A silver fantasy hockey trophy backed by four crossed sticks.',
    assetPath: '/assets/profile-icons/misc-hockey/championship-cup.webp',
    alt: 'Pixel art silver hockey championship trophy with crossed sticks',
  },
  {
    id: 'hockey-bench-gear',
    categoryId: 'misc-hockey',
    label: 'Bench Gear',
    description: 'Gloves, tape, puck, and water bottle packed for game night.',
    assetPath: '/assets/profile-icons/misc-hockey/bench-gear.webp',
    alt: 'Pixel art hockey gloves tape puck and water bottle',
  },
] as const;

// Kept as a compatibility export for existing imports while the picker now shows every category.
export const RINK_RAT_PROFILE_ICONS = PROFILE_ICONS;

const PROFILE_ICON_BY_ID = new Map<ProfileIconId, ProfileIconOption>(
  PROFILE_ICONS.map((icon) => [icon.id, icon] as const),
);

export function isProfileIconId(value: unknown): value is ProfileIconId {
  return typeof value === 'string' && PROFILE_ICON_BY_ID.has(value as ProfileIconId);
}

export function getProfileIcon(profileIconId?: string | null): ProfileIconOption {
  if (isProfileIconId(profileIconId)) {
    return PROFILE_ICON_BY_ID.get(profileIconId) as ProfileIconOption;
  }

  return PROFILE_ICON_BY_ID.get(DEFAULT_PROFILE_ICON_ID) as ProfileIconOption;
}

export function getProfileIconsForCategory(
  categoryId: ProfileIconCategoryId,
): readonly ProfileIconOption[] {
  return PROFILE_ICONS.filter((icon) => icon.categoryId === categoryId);
}

export function getRandomProfileIconId(): ProfileIconId {
  const values = new Uint32Array(1);

  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(values);
    return PROFILE_ICON_IDS[values[0] % PROFILE_ICON_IDS.length];
  }

  return PROFILE_ICON_IDS[Math.floor(Math.random() * PROFILE_ICON_IDS.length)];
}

export function getSeededProfileIconId(seed: string): ProfileIconId {
  let hash = 2166136261;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return PROFILE_ICON_IDS[(hash >>> 0) % PROFILE_ICON_IDS.length];
}
