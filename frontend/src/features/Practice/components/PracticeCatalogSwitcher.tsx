/**
 * `PracticeCatalogSwitcher` — the centered `Practice | Catalog` text-tab pair
 * at the top of the dark Practice player. Selecting a tab swaps the surface
 * below in place (no push navigation); the player hides the switcher entirely
 * while a session is running or paused.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SPACING, editorialType, onShowcase, touchTarget } from '@/design/tokens';

/** The two in-place surfaces the Practice player can show. */
export type PracticeTab = 'practice' | 'catalog';

export interface PracticeCatalogSwitcherProps {
  /** The tab whose surface is currently shown. */
  active: PracticeTab;
  /** Fired with the pressed tab's id (also fires for the already-active tab). */
  onChange: (tab: PracticeTab) => void;
}

/** Underline thickness marking the active tab. */
const ACTIVE_UNDERLINE_WIDTH = 2;

const TABS: ReadonlyArray<{ id: PracticeTab; label: string }> = [
  { id: 'practice', label: 'Practice' },
  { id: 'catalog', label: 'Catalog' },
];

/** Centered tablist of two text tabs for the dark player ground. */
export default function PracticeCatalogSwitcher({
  active,
  onChange,
}: PracticeCatalogSwitcherProps): React.JSX.Element {
  return (
    <View accessibilityRole="tablist" style={styles.tablist} testID="practice-tab-switcher">
      {TABS.map(({ id, label }) => {
        const selected = id === active;
        return (
          <TouchableOpacity
            key={id}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            onPress={() => onChange(id)}
            style={[styles.tab, selected && styles.tabActive]}
            testID={`practice-tab-${id}`}
          >
            <Text style={[styles.label, selected ? styles.labelActive : styles.labelInactive]}>
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tablist: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SPACING.xl,
  },
  tab: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    // Every tab carries the underline slot so activating one never shifts the row.
    borderBottomWidth: ACTIVE_UNDERLINE_WIDTH,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: onShowcase.primary },
  label: { ...editorialType.action },
  labelActive: { color: onShowcase.primary },
  labelInactive: { color: onShowcase.muted },
});
