/** Shared dismiss/reopen/close affordance for the raised reflection cards — shared chrome, per-variant color/margin. */
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import type { StyleProp, TextStyle, View } from 'react-native';

import { SPACING, accent, editorialType, ink, touchTarget } from '@/design/tokens';

/**
 * The press-target treatments that share this affordance's chrome. ``dismiss``
 * is the muted collapse control that sits below a card's body; ``reopen`` is the
 * accent-toned restore control that sits flush (no top margin) where the collapsed
 * card left off; ``close`` is an icon-only X pinned to the card's top-right corner
 * (#2862; #2860 specifies the same variant for the other reflection cards).
 */
export type ReflectionDismissVariant = 'dismiss' | 'reopen' | 'close';

/** The icon size of the close X, in dp — the hit area around it stays 44dp. */
export const CLOSE_ICON_SIZE = 20;

interface SharedProps {
  accessibilityLabel: string;
  testID: string;
  onPress: () => void;
  /** The pressable host view, so a caller can hand focus to it. */
  ref?: React.Ref<View>;
}

/** A text control: the label is required, and may take an extra text face. */
interface TextVariantProps extends SharedProps {
  /** Chrome treatment; defaults to the muted ``dismiss`` control. */
  variant?: 'dismiss' | 'reopen';
  label: string;
  /** Appended after the variant's face, e.g. to lift a label to the interactive floor. */
  textStyle?: StyleProp<TextStyle>;
}

/** The icon-only X: no label, so the accessibility label is the only name it has. */
interface CloseVariantProps extends SharedProps {
  variant: 'close';
}

export type ReflectionDismissProps = TextVariantProps | CloseVariantProps;

function ReflectionDismiss(props: ReflectionDismissProps): React.JSX.Element {
  const { accessibilityLabel, testID, onPress, ref } = props;
  if (props.variant === 'close') {
    return (
      <TouchableOpacity
        ref={ref}
        style={[styles.control, styles.closeControl]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        <X color={ink.soft} size={CLOSE_ICON_SIZE} accessible={false} />
      </TouchableOpacity>
    );
  }
  const isReopen = props.variant === 'reopen';
  return (
    <TouchableOpacity
      ref={ref}
      style={[styles.control, isReopen && styles.reopenControl]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <Text
        style={[styles.text, isReopen ? styles.reopenText : styles.dismissText, props.textStyle]}
      >
        {props.label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  control: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reopenControl: {
    marginTop: 0,
  },
  closeControl: {
    position: 'absolute',
    top: 0,
    right: 0,
    marginTop: 0,
    paddingHorizontal: 0,
  },
  text: {
    ...editorialType.note,
    fontWeight: '600',
  },
  dismissText: {
    color: ink.soft,
  },
  reopenText: {
    color: accent.primary,
  },
});

export default ReflectionDismiss;
