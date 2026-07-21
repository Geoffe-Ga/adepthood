/**
 * Public surface of the shared screen-drawer module: the panel, its header-left
 * toggle, a row primitive, the state hook that ties a screen to its drawer, and
 * the reusable search field plus its dependency-free fuzzy matcher.
 */
export { default as ScreenDrawer } from './ScreenDrawer';
export type { ScreenDrawerProps } from './ScreenDrawer';
export { default as DrawerToggle } from './DrawerToggle';
export type { DrawerToggleProps } from './DrawerToggle';
export { default as DrawerItem } from './DrawerItem';
export type { DrawerItemProps } from './DrawerItem';
export { default as DrawerNavSection } from './DrawerNavSection';
export type { DrawerNavSectionProps } from './DrawerNavSection';
export { NAV_ICON_SIZE, NAV_ICON_STROKE } from './navIcon';
export { useScreenDrawer } from './useScreenDrawer';
export type { ScreenDrawerState } from './useScreenDrawer';
export { default as DrawerSearch } from './DrawerSearch';
export type { DrawerSearchProps } from './DrawerSearch';
export { fuzzyMatch, rankMatches } from './fuzzyMatch';
