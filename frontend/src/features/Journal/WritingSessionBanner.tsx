/**
 * ``WritingSessionBanner`` — one sentence about a writing session that ran its
 * length, and a way to put it away.
 *
 * Inline, never a modal: the writer has just finished writing and the page is
 * theirs, so nothing seizes it. The note states what happened and offers only
 * dismissal — no count of sessions, no praise, and no invitation to start
 * another, because a finished session is not a reason to begin one.
 *
 * The ``children`` slot is where a later offer (saving the session as a habit,
 * or as a practice) attaches. It exists so those offers land here, on a surface
 * that renders once, rather than inside the pill that repaints ten times a
 * second while a session runs.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { RESONANCE_BUTTON_CLEARANCE, WRITING_TIMER_PILL_MAX_HEIGHT } from './JournalEntry.styles';
import type { WritingSessionResult } from './writingSession';
import {
  WRITING_SESSION_DISMISS,
  WRITING_SESSION_DISMISS_A11Y,
  writingSessionSummary,
} from './writingTimerCopy';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  journalSheet,
  spacing,
  touchTarget,
} from '@/design/tokens';

export interface WritingSessionBannerProps {
  result: WritingSessionResult;
  onDismiss: () => void;
  children?: React.ReactNode;
}

function WritingSessionBanner({
  result,
  onDismiss,
  children,
}: WritingSessionBannerProps): React.JSX.Element {
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite" testID="writing-session-banner">
      <Text style={styles.summary}>{writingSessionSummary(result.elapsedMinutes)}</Text>
      {children}
      <TouchableOpacity
        style={styles.dismiss}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={WRITING_SESSION_DISMISS_A11Y}
        accessibilityState={{ disabled: false }}
        testID="writing-session-banner-dismiss"
      >
        <Text style={styles.dismissLabel}>{WRITING_SESSION_DISMISS}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Warm paper tone in the page's own margin rhythm — a note, not an alert.
   *
   * The bottom margin is load-bearing, not rhythm: this is an in-flow box at
   * the foot of the same column the timer and the resonance button float over,
   * so without it the opaque resonance button paints across most of the Close
   * target the writer is meant to use to put the note away — and across
   * whatever a later lane hangs in the children slot beneath the text.
   */
  banner: {
    marginHorizontal: journalSheet.deskPaddingH,
    marginTop: spacing(1),
    marginBottom: RESONANCE_BUTTON_CLEARANCE + WRITING_TIMER_PILL_MAX_HEIGHT,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: colors.paper.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.sheetEdge,
  },
  summary: {
    ...editorialType.note,
    color: colors.paper.ink,
  },
  dismiss: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
  },
  dismissLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default WritingSessionBanner;
