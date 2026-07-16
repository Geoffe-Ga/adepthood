/**
 * ``ReturnCompletionCard`` — the warm close of a finished Return arc: all five
 * foci met, self through all beings. A quiet, reflective set-down rather than a
 * reward or rank, with the single ``set it down`` affordance. Presentational +
 * reduced-motion-safe; tokens only. Reads as a softer sibling of ``ReturnArcCard``.
 */
import React from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  RETURN_ARC_LEAVE,
  RETURN_ARC_LEAVE_A11Y,
  RETURN_COMPLETE_BODY,
  RETURN_COMPLETE_HEADING,
} from './returnCopy';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  paperShadow,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { usePressScale } from '@/hooks/usePressScale';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export interface ReturnCompletionCardProps {
  onLeave: () => void;
}

function ReturnCompletionCard({ onLeave }: ReturnCompletionCardProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID="return-completion-card">
        <Text style={styles.heading} accessibilityRole="header">
          {RETURN_COMPLETE_HEADING}
        </Text>
        <Text style={styles.body}>{RETURN_COMPLETE_BODY}</Text>
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.leave}
            onPress={onLeave}
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            accessibilityRole="button"
            accessibilityLabel={RETURN_ARC_LEAVE_A11Y}
            testID="return-completion-leave"
          >
            <Text style={styles.leaveText}>{RETURN_ARC_LEAVE}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.low,
    ...paperShadow.card,
  },
  heading: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  body: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    marginTop: spacing(1),
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing(1.5),
  },
  leave: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveText: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default ReturnCompletionCard;
