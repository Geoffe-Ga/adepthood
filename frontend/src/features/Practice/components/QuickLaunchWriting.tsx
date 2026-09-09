/**
 * ``QuickLaunchWriting`` — the one tap from a saved ``Journaling`` practice to a
 * page already being written on.
 *
 * Rendered in the player region, where the writer already goes to begin a
 * practice, and rendered ONLY when there is a launch to make: the decision is
 * ``planQuickLaunch``'s, and a ``null`` plan renders nothing at all rather than
 * a disabled control. An affordance nobody can use is chrome, and chrome on
 * this screen would be the app suggesting a depth the writer has not chosen.
 *
 * Nothing here counts, ranks, or reminds. It is a door, open for as long as the
 * practice is theirs, and it says nothing about how often they walk through it.
 *
 * The waiting line beneath it is shown when the practice sits at a stage still
 * ahead on the writer's calendar. The door is open anyway — the writing page is
 * the floor of this product and is never gated — and the line says, before the
 * tap, that a page written now is not counted on the practice yet. That is the
 * same promise ``saveAsPracticeCopy`` makes at the other end of the same flow:
 * say it first, rather than let a 403 say it afterwards.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accentDark,
  editorialType,
  onShowcase,
  touchTarget,
} from '@/design/tokens';
import {
  QUICK_LAUNCH_A11Y,
  QUICK_LAUNCH_LABEL,
  QUICK_LAUNCH_WAITING,
} from '@/features/Journal/quickLaunchCopy';
import type { WritingQuickLaunch } from '@/features/Journal/quickLaunchWriting';

export interface QuickLaunchWritingProps {
  /** What the tap would open, or ``null`` when there is nothing to offer. */
  plan: WritingQuickLaunch | null;
  /** Opens the timed page the plan describes. */
  onBegin: () => void;
}

function QuickLaunchWriting({ plan, onBegin }: QuickLaunchWritingProps): React.JSX.Element | null {
  if (plan === null) return null;
  return (
    <View style={styles.region} testID="practice-quick-launch-region">
      <TouchableOpacity
        style={styles.action}
        onPress={onBegin}
        accessibilityRole="button"
        accessibilityLabel={QUICK_LAUNCH_A11Y}
        testID="practice-quick-launch"
      >
        <Text style={styles.actionLabel}>{QUICK_LAUNCH_LABEL}</Text>
      </TouchableOpacity>
      {plan.userPracticeId === null ? (
        <Text style={styles.waiting} testID="practice-quick-launch-waiting">
          {QUICK_LAUNCH_WAITING}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  region: {
    alignItems: 'center',
    gap: SPACING.xs,
    paddingTop: SPACING.sm,
  },
  /**
   * The dark player's own button shape — an outline in the accent rather than a
   * filled block, so it reads as an offer beside the ritual rather than as the
   * thing the screen came to do.
   */
  action: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: accentDark.primary,
  },
  actionLabel: {
    ...editorialType.action,
    color: accentDark.primary,
  },
  waiting: {
    ...editorialType.caption,
    color: onShowcase.soft,
    textAlign: 'center',
  },
});

export default QuickLaunchWriting;
