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
 *
 * What the slot promises about its own lifetime, because an offer mounted in it
 * can be halfway through an interaction: it goes away without the writer
 * touching it in exactly three cases — they close the note; a later session runs
 * its full length and this note is replaced by one about that session; or they
 * finish the entry, which drops the screen out of edit mode and unmounts the
 * writing surfaces entirely. Nothing else removes it. Starting a session,
 * pausing or resuming one, changing the length, and stopping a session early all
 * leave a mounted offer standing, so no offer is ever torn down by an event that
 * reported nothing.
 *
 * Two consequences for whatever lands here. Key offer state to the result it is
 * about rather than to the mount: replacement swaps ``result`` underneath a slot
 * that stays mounted, and state left over from the previous session would then
 * be shown beside a newer session's sentence. And treat the offer as one the
 * writer may never be given again — it is the invitation, not the record, so
 * commit on the tap rather than staging input inside the slot.
 *
 * An occupant that removes itself under the writer's finger (the link-a-habit
 * note's "Don't show again", #3006) would drop keyboard and screen-reader focus
 * with it. ``useFocusBannerClose`` hands that focus to the note's own Close,
 * which is always mounted while the note is.
 */
import React, { createContext, useCallback, useContext, useRef } from 'react';
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
import { moveAccessibilityFocus } from '@/utils/accessibilityFocus';

/** Moves focus to the enclosing note's Close; a no-op outside a note. */
const FocusCloseContext = createContext<() => void>(() => undefined);

/** For a slot occupant that removes itself: hand focus to the note's Close. */
export function useFocusBannerClose(): () => void {
  return useContext(FocusCloseContext);
}

export interface WritingSessionBannerProps {
  result: WritingSessionResult;
  onDismiss: () => void;
  /** Whether the timer occupies its floating rail beneath this note. */
  clearsFloatingTimer?: boolean;
  children?: React.ReactNode;
}

function WritingSessionBanner({
  result,
  onDismiss,
  clearsFloatingTimer = true,
  children,
}: WritingSessionBannerProps): React.JSX.Element {
  const closeRef = useRef<View>(null);
  const focusClose = useCallback(() => moveAccessibilityFocus(closeRef.current), []);
  return (
    <View
      style={[styles.banner, clearsFloatingTimer && styles.bannerWithFloatingTimer]}
      accessibilityLiveRegion="polite"
      testID="writing-session-banner"
    >
      <Text style={styles.summary}>{writingSessionSummary(result.elapsedMinutes)}</Text>
      <FocusCloseContext.Provider value={focusClose}>{children}</FocusCloseContext.Provider>
      <TouchableOpacity
        ref={closeRef}
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
   * While the timer floats, the larger bottom margin is load-bearing rather
   * than rhythm: without it the pill paints across the Close target and any
   * offer in the children slot. Once the idle timer expands back into flow,
   * only the ordinary note-to-control rhythm remains.
   */
  banner: {
    marginHorizontal: journalSheet.deskPaddingH,
    marginTop: spacing(1),
    marginBottom: spacing(1),
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: colors.paper.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.sheetEdge,
  },
  bannerWithFloatingTimer: {
    marginBottom: RESONANCE_BUTTON_CLEARANCE + WRITING_TIMER_PILL_MAX_HEIGHT,
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
