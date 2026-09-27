/**
 * The shared pieces of a first-press explainer: the "don’t show this again"
 * checkbox and the pair of equal arms beneath it, plus the card's title and
 * body faces.
 *
 * Two dialogs use them — the resonance spend disclosure and the promote-a-quote
 * note — and both make the same promise: backing out is never the harder
 * gesture, and a reader who wants the note to keep appearing does nothing to
 * keep it. Stating that shape once keeps the two from drifting apart.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  BORDER_RADIUS,
  colors,
  editorialType,
  journalLayout,
  spacing,
  touchTarget,
} from '@/design/tokens';

/** Faded, not hidden: an arm that cannot act yet still says what it would do. */
const DISABLED_ARM_OPACITY = 0.45;

export interface DontShowAgainCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  label: string;
  accessibilityLabel: string;
  testID: string;
}

/** The tick box, as a real checkbox rather than a pressable label. */
export function DontShowAgainCheckbox({
  checked,
  onToggle,
  label,
  accessibilityLabel,
  testID,
}: DontShowAgainCheckboxProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={explainerStyles.checkboxRow}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      // react-native-web reads the checked state only from aria-checked, not
      // from accessibilityState, so without it a browser reads every box unticked.
      aria-checked={checked}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Text style={explainerStyles.checkboxMark}>{checked ? '✓' : ' '}</Text>
      <Text style={explainerStyles.checkboxLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

/** One arm's words, for the eye and for assistive tech, and its handle. */
export interface ExplainerArm {
  label: string;
  accessibilityLabel: string;
  testID: string;
  onPress: () => void;
}

export interface ExplainerActionPairProps {
  cancel: ExplainerArm;
  proceed: ExplainerArm;
  /** Hold the proceeding arm back (the resonance payer is not known yet). */
  proceedDisabled?: boolean;
}

/**
 * The two arms, side by side and the same size.
 *
 * Its own component so the fact that they are one row of equal halves is
 * stated once, in one place, rather than being a property of how a card
 * happens to be laid out. Only the fill differs, and it names which arm moves
 * forward — not which one we would rather the reader took.
 */
export function ExplainerActionPair({
  cancel,
  proceed,
  proceedDisabled = false,
}: ExplainerActionPairProps): React.JSX.Element {
  return (
    <View style={explainerStyles.actions}>
      <TouchableOpacity
        style={explainerStyles.action}
        onPress={cancel.onPress}
        accessibilityRole="button"
        accessibilityLabel={cancel.accessibilityLabel}
        testID={cancel.testID}
      >
        <Text style={explainerStyles.cancelLabel}>{cancel.label}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          explainerStyles.action,
          explainerStyles.proceed,
          proceedDisabled && explainerStyles.proceedDisabled,
        ]}
        onPress={proceed.onPress}
        disabled={proceedDisabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: proceedDisabled }}
        accessibilityLabel={proceed.accessibilityLabel}
        testID={proceed.testID}
      >
        <Text style={explainerStyles.proceedLabel}>{proceed.label}</Text>
      </TouchableOpacity>
    </View>
  );
}

export const explainerStyles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth,
    alignSelf: 'center',
  },
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(1),
    minHeight: touchTarget.minimum,
    marginTop: spacing(1),
  },
  checkboxMark: {
    ...editorialType.action,
    color: colors.paper.ink,
    minWidth: spacing(2.5),
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.paper.inkSoft,
    borderRadius: BORDER_RADIUS.sm,
  },
  checkboxLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
    flexShrink: 1,
  },
  /** Both arms in one row; ``action`` below gives each of them the same half. */
  actions: {
    flexDirection: 'row',
    gap: spacing(1),
    marginTop: spacing(1.5),
  },
  action: {
    flex: 1,
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
  },
  proceed: {
    backgroundColor: colors.primary,
  },
  proceedDisabled: {
    opacity: DISABLED_ARM_OPACITY,
  },
  proceedLabel: {
    ...editorialType.action,
    color: colors.text.light,
  },
  cancelLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
  },
});
