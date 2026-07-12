/**
 * The navigation section pinned at the top of every screen drawer: one row per
 * enabled primary destination (from ``NAV_DESTINATIONS``), the current screen
 * highlighted, followed by a hairline divider that separates it from the screen's
 * own drawer contents. Optional depth rings appear only while their toggle is on,
 * subscribed live so a ring flip adds or removes its row without a manual refresh.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import DrawerItem from './DrawerItem';

import { accent, ink, SPACING, surface } from '@/design/tokens';
import type { RootTabParamList } from '@/navigation/BottomTabs';
import { NAV_DESTINATIONS, type NavDestinationRing } from '@/navigation/destinations';
import { useAppNavigation } from '@/navigation/hooks';
import {
  selectEnableCourse,
  selectEnableHabits,
  selectEnablePractices,
  useDepthPreferencesStore,
} from '@/store/useDepthPreferencesStore';

/** Size (px) of the leading lucide icon on each nav row. */
const NAV_ICON_SIZE = 24;
/** Stroke width of the leading lucide icon on each nav row. */
const NAV_ICON_STROKE = 2;

type TabNavigation = ReturnType<typeof useAppNavigation>;

/**
 * Per-route navigate thunks. Literal ``navigate('Name')`` calls type-check under
 * React Navigation's distributive signature where a union route name does not, so
 * each destination gets its own explicit thunk instead of a single dynamic call.
 */
const NAVIGATE_BY_NAME: Readonly<Record<keyof RootTabParamList, (nav: TabNavigation) => void>> = {
  Journal: (nav) => nav.navigate('Journal'),
  Habits: (nav) => nav.navigate('Habits'),
  Practice: (nav) => nav.navigate('Practice'),
  Course: (nav) => nav.navigate('Course'),
  Map: (nav) => nav.navigate('Map'),
};

export interface DrawerNavSectionProps {
  /** The screen the drawer belongs to; its row renders selected. */
  currentScreen: keyof RootTabParamList;
  /** Called after a row navigates, so the host can close the drawer. */
  onNavigate: () => void;
}

/**
 * Renders the drawer's primary-navigation rows plus a trailing hairline divider.
 * Only destinations whose depth ring is enabled (or that have no ring) are shown,
 * and the ``currentScreen`` row is marked selected.
 */
export default function DrawerNavSection({
  currentScreen,
  onNavigate,
}: DrawerNavSectionProps): React.JSX.Element {
  const navigation = useAppNavigation();
  const enableHabits = useDepthPreferencesStore(selectEnableHabits);
  const enablePractices = useDepthPreferencesStore(selectEnablePractices);
  const enableCourse = useDepthPreferencesStore(selectEnableCourse);

  const enabledByRing: Readonly<Record<NavDestinationRing, boolean>> = {
    habits: enableHabits,
    practices: enablePractices,
    course: enableCourse,
  };

  const visible = NAV_DESTINATIONS.filter(
    (destination) => destination.ring === undefined || enabledByRing[destination.ring],
  );

  return (
    <View>
      {visible.map((destination) => {
        const Icon = destination.icon;
        const isCurrent = destination.name === currentScreen;
        return (
          <DrawerItem
            key={destination.name}
            testID={`drawer-nav-${destination.name}`}
            label={destination.label}
            selected={isCurrent}
            icon={
              <Icon
                color={isCurrent ? accent.primary : ink.muted}
                size={NAV_ICON_SIZE}
                strokeWidth={NAV_ICON_STROKE}
              />
            }
            onPress={() => {
              NAVIGATE_BY_NAME[destination.name](navigation);
              onNavigate();
            }}
          />
        );
      })}
      <View testID="drawer-nav-divider" style={styles.divider} />
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: surface.hairline,
    marginVertical: SPACING.sm,
  },
});
