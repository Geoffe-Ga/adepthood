import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

/** Tallest the open results list grows before it scrolls internally. */
const PANEL_MAX_HEIGHT = 280;

/** Optional secondary tag shown on the closed trigger (e.g. a sense name). */
export interface DropdownBadge {
  text: string;
  testID: string;
}

export interface SearchableDropdownProps {
  /** Container handle. */
  testID: string;
  triggerTestID: string;
  panelTestID: string;
  searchTestID: string;
  /** Text shown on the collapsed trigger — the current selection. */
  triggerLabel: string;
  badge?: DropdownBadge;
  placeholder: string;
  /** Stable label for the search field; placeholders aren't read reliably. */
  searchAccessibilityLabel: string;
  open: boolean;
  query: string;
  onToggle: () => void;
  onQueryChange: (next: string) => void;
  /** Static slot rendered above the scrolling results (e.g. a create row). */
  createSlot?: React.ReactNode;
  /** Scrolling results — grouped option rows / empty state. */
  children: React.ReactNode;
}

/**
 * Presentational chrome for a searchable dropdown: a collapsed trigger with
 * an optional badge, and—when open—a search box, a static create slot, and a
 * scrolling results region. Selection, filtering and "create your own" logic
 * live in the consumer so the same chrome can sit over a static catalogue
 * ({@link GroundingDropdown}) or a server-backed tag library (TagPicker).
 */
const SearchableDropdown = (props: SearchableDropdownProps): React.JSX.Element => (
  <View testID={props.testID}>
    <Trigger
      testID={props.triggerTestID}
      label={props.triggerLabel}
      badge={props.badge}
      open={props.open}
      onPress={props.onToggle}
    />
    {props.open && (
      <View style={styles.panel} testID={props.panelTestID}>
        <TextInput
          style={styles.search}
          value={props.query}
          onChangeText={props.onQueryChange}
          placeholder={props.placeholder}
          accessibilityLabel={props.searchAccessibilityLabel}
          autoCorrect={false}
          testID={props.searchTestID}
        />
        {props.createSlot}
        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {props.children}
        </ScrollView>
      </View>
    )}
  </View>
);

interface TriggerProps {
  testID: string;
  label: string;
  badge?: DropdownBadge;
  open: boolean;
  onPress: () => void;
}

const Trigger = ({ testID, label, badge, open, onPress }: TriggerProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={`Choose an option, currently ${label}`}
    accessibilityState={{ expanded: open }}
    onPress={onPress}
    style={styles.trigger}
    testID={testID}
  >
    <Text style={styles.triggerLabel} numberOfLines={1}>
      {label}
    </Text>
    <View style={styles.triggerRight}>
      {badge !== undefined && (
        <Text style={styles.badge} testID={badge.testID}>
          {badge.text}
        </Text>
      )}
      <Text style={styles.caret}>{open ? '▲' : '▼'}</Text>
    </View>
  </TouchableOpacity>
);

/** Uppercase section header inside the results list. */
export const DropdownGroupHeader = ({ label }: { label: string }): React.JSX.Element => (
  <Text accessibilityRole="header" style={styles.groupHeader}>
    {label}
  </Text>
);

export interface DropdownOptionRowProps {
  label: string;
  caption?: string;
  onPress: () => void;
  testID: string;
  accessibilityLabel: string;
  selected?: boolean;
}

/** One selectable option row — a bold label over an optional caption. */
export const DropdownOptionRow = ({
  label,
  caption,
  onPress,
  testID,
  accessibilityLabel,
  selected = false,
}: DropdownOptionRowProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ selected }}
    onPress={onPress}
    style={[styles.optionRow, selected && styles.optionRowSelected]}
    testID={testID}
  >
    <Text style={styles.optionLabel}>{label}</Text>
    {caption !== undefined && caption !== '' && (
      <Text style={styles.optionCaption} numberOfLines={1}>
        {caption}
      </Text>
    )}
  </TouchableOpacity>
);

/** "No matches" placeholder shown when the filtered results are empty. */
export const DropdownEmptyState = ({
  label,
  testID,
}: {
  label: string;
  testID: string;
}): React.JSX.Element => (
  <Text style={styles.empty} testID={testID}>
    {label}
  </Text>
);

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    backgroundColor: colors.background.card,
    gap: SPACING.sm,
  },
  triggerLabel: { color: colors.text.primary, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  triggerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  badge: {
    color: colors.text.secondaryAccessible,
    fontSize: 12,
    fontWeight: '600',
    overflow: 'hidden',
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
  },
  caret: { color: colors.text.secondaryAccessible, fontSize: 11 },
  panel: {
    marginTop: SPACING.xs,
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.card,
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  search: {
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    color: colors.text.primary,
    fontSize: 14,
    backgroundColor: colors.background.primary,
  },
  results: { maxHeight: PANEL_MAX_HEIGHT },
  groupHeader: {
    color: colors.text.tertiaryAccessible,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: SPACING.xs,
    marginBottom: 2,
  },
  optionRow: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  optionRowSelected: { backgroundColor: colors.background.accent },
  optionLabel: { color: colors.text.primary, fontSize: 14, fontWeight: '500' },
  optionCaption: { color: colors.text.secondaryAccessible, fontSize: 12 },
  empty: { color: colors.text.secondaryAccessible, fontSize: 13, padding: SPACING.sm },
});

/** Create-slot styles shared so each consumer's "create your own" matches. */
export const dropdownCreateStyles = StyleSheet.create({
  section: {
    backgroundColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  row: { paddingVertical: SPACING.xs, paddingHorizontal: SPACING.xs },
  rowText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  /** Dim an action that is present but not yet actionable (e.g. empty form). */
  disabled: { opacity: 0.4 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.xs },
  controlsLabel: { color: colors.text.secondaryAccessible, fontSize: 12, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.background.card,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    color: colors.text.primary,
    fontSize: 13,
    backgroundColor: colors.background.primary,
  },
  error: { color: colors.danger, fontSize: 12 },
});

export default SearchableDropdown;
