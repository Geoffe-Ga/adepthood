/** Shared dismiss/reopen/close affordance for the raised reflection cards — shared chrome, per-variant color/margin. */
import { X } from 'lucide-react-native';
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import type { StyleProp, TextStyle, View } from 'react-native';

import { decorativeHidden } from '@/components/a11yHidden';
import { SPACING, accent, editorialType, ink, touchTarget } from '@/design/tokens';

/**
 * The press-target treatments that share this affordance's chrome. ``dismiss``
 * is the muted collapse control that sits below a card's body; ``reopen`` is the
 * accent-toned restore control that sits flush (no top margin) where the collapsed
 * card left off; ``close`` is an icon-only X pinned to the card's top-right corner
 * (#2862; #2860 specifies the same variant for the other reflection cards). The X
 * rests in soft ink and takes the accent while it is held down (#2860).
 */
export type ReflectionDismissVariant = 'dismiss' | 'reopen' | 'close';

/** The icon size of the close X, in dp — the hit area around it stays 44dp. */
export const CLOSE_ICON_SIZE = 20;

/** The close X's ink at rest: quiet, so the decline never competes with the card's own action. */
export const CLOSE_REST_COLOR = ink.soft;

/** The close X's ink while pressed: the accent, so the press is felt before the card goes. */
export const CLOSE_PRESSED_COLOR = accent.primary;

/** The close X's opacity while held: fully opaque, so the accent reads at full strength. */
export const CLOSE_ACTIVE_OPACITY = 1;

/**
 * How far a card's content must keep off its right edge so nothing lies under
 * the corner X. The X is pinned to the card's padding-box corner with a
 * ``touchTarget.minimum`` square hit area; the card's own padding already
 * clears ``cardPadding`` of it, so content needs only the remainder — and none
 * at all once the padding covers the whole hit area.
 */
export function closeCornerReserve(cardPadding: number): number {
  return Math.max(0, touchTarget.minimum - cardPadding);
}

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

/** The icon-only X, holding its own pressed state so the glyph can take the accent. */
function CloseControl({
  accessibilityLabel,
  testID,
  onPress,
  ref,
}: SharedProps): React.JSX.Element {
  const [pressed, setPressed] = useState(false);
  return (
    <TouchableOpacity
      ref={ref}
      style={[styles.control, styles.closeControl]}
      // The accent tint IS the press feedback; the default 0.2 fade would wash it out.
      activeOpacity={CLOSE_ACTIVE_OPACITY}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <X
        color={pressed ? CLOSE_PRESSED_COLOR : CLOSE_REST_COLOR}
        size={CLOSE_ICON_SIZE}
        {...decorativeHidden()}
      />
    </TouchableOpacity>
  );
}

function ReflectionDismiss(props: ReflectionDismissProps): React.JSX.Element {
  const { accessibilityLabel, testID, onPress, ref } = props;
  if (props.variant === 'close') {
    return (
      <CloseControl
        ref={ref}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        onPress={onPress}
      />
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
