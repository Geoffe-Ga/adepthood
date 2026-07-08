/**
 * ``StageSelector`` — the one chip strip for choosing an APTITUDE stage.
 *
 * The catalog filter, the create-wizard assignment field, and the detail
 * re-assign picker all render the same 1..10 stage chips with slightly
 * different chrome. This component unifies them behind a ``variant`` so the
 * chip set, the a11y labels, and the ``Skip`` affordance live in one place:
 *
 * - ``radio``  — wizard field; radio semantics with a leading ``Skip`` chip.
 * - ``filter`` — catalog filter; button semantics, caller-formatted labels.
 * - ``picker`` — detail re-assign; button boxes that grey out while assigning.
 *
 * Pure data → UI: ``onSelect`` (and optional ``onSkip``) are the only outputs;
 * the caller owns the selection state.
 */

import React from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { stageRange } from '../constants';

import { BORDER_RADIUS, SPACING, accent, editorialType, ink, surface } from '@/design/tokens';

/** Minimum width of a ``picker`` stage box so single-digit numbers stay tappable. */
const STAGE_BOX_MIN_WIDTH = 36;

type StageVariant = 'radio' | 'filter' | 'picker';

export interface StageSelectorProps {
  variant: StageVariant;
  onSelect: (stage: number) => void;
  selectedStage?: number | null;
  onSkip?: () => void;
  disabled?: boolean;
  formatLabel?: (stage: number) => string;
  testIDPrefix: string;
  rowTestID?: string;
  rowStyle?: StyleProp<ViewStyle>;
}

/** A single resolved chip; all variant/branching decisions are made upstream. */
interface StageChipProps {
  role: 'radio' | 'button';
  accessibilityLabel: string;
  accessibilityState: { selected: boolean } | { disabled: boolean };
  style: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
  label: string;
  onPress: (() => void) | undefined;
  testID: string;
}

const StageChip = ({
  role,
  accessibilityLabel,
  accessibilityState,
  style,
  textStyle,
  label,
  onPress,
  testID,
}: StageChipProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole={role}
    accessibilityLabel={accessibilityLabel}
    accessibilityState={accessibilityState}
    onPress={onPress}
    style={style}
    testID={testID}
  >
    <Text style={textStyle}>{label}</Text>
  </TouchableOpacity>
);

/** A logical stage chip before variant chrome (role/state/styles) is applied. */
interface StageItem {
  key: string;
  testID: string;
  visibleLabel: string;
  accessibilityLabel: string;
  selected: boolean;
  onPress: (() => void) | undefined;
}

/** Flatten the selector props into the ordered chip list (Skip first, then 1..10). */
const buildStageItems = ({
  onSelect,
  selectedStage,
  onSkip,
  disabled,
  formatLabel,
  testIDPrefix,
}: {
  onSelect: (stage: number) => void;
  selectedStage: number | null | undefined;
  onSkip: (() => void) | undefined;
  disabled: boolean;
  formatLabel: ((stage: number) => string) | undefined;
  testIDPrefix: string;
}): StageItem[] => {
  const items: StageItem[] = [];
  if (onSkip !== undefined) {
    items.push({
      key: 'skip',
      testID: `${testIDPrefix}-skip`,
      visibleLabel: 'Skip',
      accessibilityLabel: 'Stage Skip',
      selected: selectedStage === null,
      onPress: onSkip,
    });
  }
  for (const n of stageRange()) {
    items.push({
      key: String(n),
      testID: `${testIDPrefix}-${n}`,
      visibleLabel: formatLabel !== undefined ? formatLabel(n) : String(n),
      accessibilityLabel: `Stage ${n}`,
      selected: selectedStage === n,
      onPress: disabled ? undefined : () => onSelect(n),
    });
  }
  return items;
};

/** Apply the ``picker`` chrome: button box that greys out and drops onPress when disabled. */
const renderPickerChip = (item: StageItem, disabled: boolean): React.JSX.Element => (
  <StageChip
    key={item.key}
    role="button"
    accessibilityLabel={item.accessibilityLabel}
    accessibilityState={{ disabled }}
    style={[styles.pickerBox, disabled && styles.pickerDisabled]}
    textStyle={styles.pickerText}
    label={item.visibleLabel}
    onPress={item.onPress}
    testID={item.testID}
  />
);

/** Apply the ``radio``/``filter`` chrome: selectable pill with variant-specific text. */
const renderSelectableChip = (item: StageItem, variant: StageVariant): React.JSX.Element => {
  const isRadio = variant === 'radio';
  const role = isRadio ? 'radio' : 'button';
  const baseTextStyle = isRadio ? styles.radioText : styles.filterText;
  return (
    <StageChip
      key={item.key}
      role={role}
      accessibilityLabel={item.accessibilityLabel}
      accessibilityState={{ selected: item.selected }}
      style={[styles.chip, item.selected && styles.chipSelected]}
      textStyle={[baseTextStyle, item.selected && styles.selectedText]}
      label={item.visibleLabel}
      onPress={item.onPress}
      testID={item.testID}
    />
  );
};

const StageSelector = ({
  variant,
  onSelect,
  selectedStage = undefined,
  onSkip,
  disabled = false,
  formatLabel,
  testIDPrefix,
  rowTestID,
  rowStyle,
}: StageSelectorProps): React.JSX.Element => {
  const items = buildStageItems({
    onSelect,
    selectedStage,
    onSkip,
    disabled,
    formatLabel,
    testIDPrefix,
  });
  return (
    <View style={[styles.row, rowStyle]} testID={rowTestID}>
      {items.map((item) =>
        variant === 'picker'
          ? renderPickerChip(item, disabled)
          : renderSelectableChip(item, variant),
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  chipSelected: { backgroundColor: accent.primary, borderColor: accent.primary },
  selectedText: { color: accent.onPrimary },
  radioText: { ...editorialType.note, color: ink.primary },
  filterText: { fontSize: 12, color: ink.primary, fontWeight: '600' },
  pickerBox: {
    minWidth: STAGE_BOX_MIN_WIDTH,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: surface.sunken,
    alignItems: 'center',
  },
  pickerText: { color: ink.primary, fontWeight: '700' },
  pickerDisabled: { opacity: 0.5 },
});

export default StageSelector;
