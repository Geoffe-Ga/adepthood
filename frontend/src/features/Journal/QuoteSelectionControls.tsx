/**
 * The controls a multi-select fold-in wears (#2885), shared by the sources
 * panel and the Promoted quotes screen so both speak the same way:
 *
 * - ``SelectionHeader``: enter/leave selection mode, and while in it, Select all
 *   and Clear all (with an optional visible note naming what Select all covers);
 * - ``QuoteFoldBar``: the one primary action, rendered by each caller OUTSIDE
 *   its scroll so it stays in view however long the list is.
 *
 * react-native-web drops ``accessibilityState``, so the bar's disabled state is
 * also written as ``aria-disabled`` there, and the note is tied to Select all
 * with ``aria-describedby`` rather than an ``accessibilityHint`` the web drops.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  CANCEL_SELECTING_LABEL,
  CLEAR_ALL_LABEL,
  SELECT_ALL_LABEL,
  SELECT_QUOTES_LABEL,
} from './quoteFoldCopy';

import { webDescribedBy, webDisabledState } from '@/components/webAria';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  surface,
  touchTarget,
  uiType,
} from '@/design/tokens';

/** One quiet text control: a link-weight action at least a touch target tall. */
function TextControl({
  label,
  onPress,
  testID,
  describedBy,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  describedBy?: string;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.control}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      {...webDescribedBy(describedBy)}
    >
      <Text style={styles.controlText}>{label}</Text>
    </TouchableOpacity>
  );
}

export interface SelectionHeaderProps {
  selecting: boolean;
  onToggleMode: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  /** A visible line beneath Select all saying what it covers, when that needs saying. */
  selectAllNote?: string;
  /** Prefix for every control's testID (and the note's id). */
  testIDPrefix: string;
}

/** Enter/leave selection mode; while selecting, Select all and Clear all beside it. */
export function SelectionHeader({
  selecting,
  onToggleMode,
  onSelectAll,
  onClear,
  selectAllNote,
  testIDPrefix,
}: SelectionHeaderProps): React.JSX.Element {
  const noteId = `${testIDPrefix}-select-all-note`;
  return (
    <View>
      <View style={styles.headerRow}>
        <TextControl
          label={selecting ? CANCEL_SELECTING_LABEL : SELECT_QUOTES_LABEL}
          onPress={onToggleMode}
          testID={`${testIDPrefix}-select-toggle`}
        />
        {selecting ? (
          <>
            <TextControl
              label={SELECT_ALL_LABEL}
              onPress={onSelectAll}
              testID={`${testIDPrefix}-select-all`}
              describedBy={selectAllNote == null ? undefined : noteId}
            />
            <TextControl
              label={CLEAR_ALL_LABEL}
              onPress={onClear}
              testID={`${testIDPrefix}-clear-all`}
            />
          </>
        ) : null}
      </View>
      {selecting && selectAllNote != null ? (
        <Text style={styles.note} nativeID={noteId} testID={noteId}>
          {selectAllNote}
        </Text>
      ) : null}
    </View>
  );
}

export interface QuoteFoldBarProps {
  label: string;
  /** How many quotes are checked; the action is disabled at zero. */
  count: number;
  /** Rest the action regardless of the count (a batch is already on the wire). */
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}

/** The fixed primary action beneath a selection. Disabled, and said so, at zero. */
export function QuoteFoldBar({
  label,
  count,
  disabled: resting = false,
  onPress,
  testID = 'quote-fold-action',
}: QuoteFoldBarProps): React.JSX.Element {
  const disabled = resting || count === 0;
  return (
    <View style={styles.bar}>
      <TouchableOpacity
        style={[styles.action, disabled && styles.actionDisabled]}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        testID={testID}
        {...webDisabledState(disabled)}
      >
        <Text style={styles.actionText}>{label}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** A disabled action keeps its words legible but reads as resting. */
const DISABLED_OPACITY = 0.5;

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACING.md,
  },
  control: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  controlText: {
    ...editorialType.action,
    color: accent.primary,
  },
  note: {
    ...editorialType.caption,
    color: ink.soft,
    paddingBottom: SPACING.sm,
  },
  bar: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: surface.raised,
  },
  action: {
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: accent.primary,
  },
  actionDisabled: {
    opacity: DISABLED_OPACITY,
  },
  actionText: {
    ...uiType.button,
    color: accent.onPrimary,
  },
});
