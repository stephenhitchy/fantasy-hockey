import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILE_ICON_ID,
  getProfileIcon,
  getProfileIconsForCategory,
  PROFILE_ICON_CATEGORIES,
  PROFILE_ICON_IDS,
  PROFILE_ICONS,
} from './profile-icon.data';

describe('RinkRat profile icon catalog', () => {
  it('contains 35 stable unique icons in three categories', () => {
    expect(PROFILE_ICONS).toHaveLength(35);
    expect(PROFILE_ICON_CATEGORIES).toHaveLength(3);
    expect(getProfileIconsForCategory('rink-rats')).toHaveLength(10);
    expect(getProfileIconsForCategory('jerseys')).toHaveLength(15);
    expect(getProfileIconsForCategory('misc-hockey')).toHaveLength(10);
    expect(new Set(PROFILE_ICON_IDS).size).toBe(PROFILE_ICON_IDS.length);
    expect(new Set(PROFILE_ICONS.map((icon) => icon.assetPath)).size).toBe(35);
  });

  it('falls back safely for missing or invalid saved IDs', () => {
    expect(getProfileIcon().id).toBe(DEFAULT_PROFILE_ICON_ID);
    expect(getProfileIcon('not-a-real-icon').id).toBe(DEFAULT_PROFILE_ICON_ID);
  });
});
