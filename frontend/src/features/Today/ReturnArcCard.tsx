/**
 * ``ReturnArcCard`` — the active Return arc: this week's focus, a five-segment
 * progress indicator, and the pause/resume/leave affordances. The person can
 * rest (pause), continue (resume), or set the arc down (leave) at any time with
 * no penalty. Presentational + reduced-motion-safe; tokens only.
 */
import React, { useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { METTA_SESSION_BEGIN, METTA_SESSION_BEGIN_A11Y } from './mettaSessionCopy';
import MettaSessionModal from './MettaSessionModal';
import {
  RETURN_ARC_LEAVE,
  RETURN_ARC_LEAVE_A11Y,
  RETURN_ARC_PAUSE,
  RETURN_ARC_PAUSE_A11Y,
  RETURN_ARC_RESUME,
  RETURN_ARC_RESUME_A11Y,
} from './returnCopy';

import type { ReturnArc, ReturnWeek } from '@/api';
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

/** The Return runs five weeks — one Metta focus each. */
export const RETURN_WEEK_COUNT = 5;

/** Fixed segment indices so each elapsed week fills one visible block. */
const SEGMENTS = Array.from({ length: RETURN_WEEK_COUNT }, (_, index) => index);

const COMPLETED_LABEL = 'completed week';
const REMAINING_LABEL = 'remaining week';

export interface ReturnArcCardProps {
  weeks: ReturnWeek[];
  arc: ReturnArc;
  onPause: () => void;
  onResume: () => void;
  onLeave: () => void;
}

/** The current week's focus copy, guarding against an out-of-range week. */
function currentWeek(weeks: ReturnWeek[], week: number): ReturnWeek | undefined {
  return weeks[week - 1];
}

interface PressHandlers {
  onPressIn: () => void;
  onPressOut: () => void;
}

/** The five-segment week indicator, filling one block per elapsed week. */
function WeekSegments({ week }: { week: number }): React.JSX.Element {
  return (
    <View style={styles.segmentRow}>
      {SEGMENTS.map((index) => {
        const isFilled = index < week;
        return (
          <View
            key={index}
            style={[styles.segment, isFilled ? styles.segmentFilled : styles.segmentEmpty]}
            accessibilityLabel={isFilled ? COMPLETED_LABEL : REMAINING_LABEL}
            testID={`return-week-segment-${index}`}
          />
        );
      })}
    </View>
  );
}

/** The pause-or-resume toggle: rest the arc, or continue it, depending on state. */
function RestToggle({
  paused,
  onPause,
  onResume,
  press,
}: {
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  press: PressHandlers;
}): React.JSX.Element {
  const resumeMode = paused;
  return (
    <TouchableOpacity
      style={styles.action}
      onPress={resumeMode ? onResume : onPause}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      accessibilityRole="button"
      accessibilityLabel={resumeMode ? RETURN_ARC_RESUME_A11Y : RETURN_ARC_PAUSE_A11Y}
      testID={resumeMode ? 'return-arc-resume' : 'return-arc-pause'}
    >
      <Text style={styles.actionText}>{resumeMode ? RETURN_ARC_RESUME : RETURN_ARC_PAUSE}</Text>
    </TouchableOpacity>
  );
}

/** The begin-a-session affordance: opens the optional guided Metta practice. */
function BeginSessionButton({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.action}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={METTA_SESSION_BEGIN_A11Y}
      testID="return-arc-begin-session"
    >
      <Text style={styles.actionText}>{METTA_SESSION_BEGIN}</Text>
    </TouchableOpacity>
  );
}

function ReturnArcCard({
  weeks,
  arc,
  onPause,
  onResume,
  onLeave,
}: ReturnArcCardProps): React.JSX.Element {
  const press = usePressScale(useReducedMotion());
  const focusWeek = currentWeek(weeks, arc.week);
  const [sessionOpen, setSessionOpen] = useState(false);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <View style={styles.card} testID="return-arc-card">
        {focusWeek ? (
          <>
            <Text style={styles.title}>{focusWeek.title}</Text>
            <Text style={styles.framing}>{focusWeek.framing}</Text>
          </>
        ) : null}
        <WeekSegments week={arc.week} />
        <View style={styles.actions}>
          <BeginSessionButton onPress={() => setSessionOpen(true)} />
          <RestToggle paused={arc.paused} onPause={onPause} onResume={onResume} press={press} />
          <TouchableOpacity
            style={styles.leave}
            onPress={onLeave}
            accessibilityRole="button"
            accessibilityLabel={RETURN_ARC_LEAVE_A11Y}
            testID="return-arc-leave"
          >
            <Text style={styles.leaveText}>{RETURN_ARC_LEAVE}</Text>
          </TouchableOpacity>
        </View>
      </View>
      <MettaSessionModal
        visible={sessionOpen}
        focus={arc.focus}
        weekTitle={focusWeek?.title}
        onClose={() => setSessionOpen(false)}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: 3,
    borderLeftColor: colors.tier.clear,
    ...paperShadow.card,
  },
  title: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  framing: {
    ...editorialType.marginNote,
    color: colors.paper.ink,
    marginTop: spacing(1),
  },
  segmentRow: {
    flexDirection: 'row',
    marginTop: spacing(1.5),
  },
  segment: {
    flex: 1,
    height: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    marginRight: spacing(0.5),
  },
  segmentFilled: {
    backgroundColor: colors.tier.clear,
  },
  segmentEmpty: {
    backgroundColor: colors.paper.inkSoft,
    opacity: 0.25,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing(1.5),
    gap: spacing(1),
  },
  action: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.tier.clear,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    ...editorialType.caption,
    color: colors.paper.background,
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
    ...editorialType.caption,
    color: colors.paper.inkSoft,
  },
});

export default ReturnArcCard;
