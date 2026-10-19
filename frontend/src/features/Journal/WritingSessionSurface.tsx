/**
 * ``WritingSessionSurface`` — the quiet mount point for timed writing.
 *
 * Holds the one piece of state a finished session leaves behind and decides
 * what, if anything, to say about it. Kept apart from {@link WritingTimer}
 * deliberately: the timer repaints ten times a second while a session runs, and
 * this does not repaint at all until a session ends. Anything a later lane
 * hangs off a finished session — an offer to keep it as a habit, or as a
 * practice — belongs here or in the banner's ``children``, not in the ticking
 * leaf.
 *
 * A full session gets a note back; an early stop gets one only after its
 * measured habit log confirms. Stopping early is
 * the writer saying they are done, and remarking on that would be the page
 * commenting on a decision it was not asked about — the elapsed time is still
 * reported to whatever consumes the session either way. That is a decision
 * about what to SAY, not about what a session is worth: a later lane that wants
 * early-stopped sessions reads them off the timer directly rather than
 * loosening this guard.
 *
 * So a standing note is replaced only by a newer note, and otherwise goes away
 * only when the writer closes it. A session with nothing to report leaves the
 * note alone rather than clearing it — having nothing to say is not grounds to
 * destroy a report that already exists, and a note that offers only dismissal
 * must not dismiss itself. It is also the rule the rest of the surface already
 * kept: starting a second session, pausing it, resuming it and changing its
 * length all leave a standing note untouched, and the early stop was the single
 * deviation.
 *
 * The cost of that choice, accepted knowingly: after a finished session and
 * then an abandoned one, the note describes a session two sessions back. It
 * stays true, it stays one tap from gone, and a stale sentence is a smaller
 * harm than an offer that disappears under the writer's thumb.
 *
 * What this buys the banner's ``children`` slot is written out in
 * {@link WritingSessionBanner}.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';

import {
  RESONANCE_BUTTON_CLEARANCE,
  WRITING_BAND_LOWERED_CLEARANCE,
  WRITING_TIMER_CLEARANCE,
} from './JournalEntry.styles';
import type { LoggedWritingSession, WritingSessionResult } from './writingSession';
import WritingSessionBanner from './WritingSessionBanner';
import WritingTimer from './WritingTimer';

import { SPACING, journalSheet } from '@/design/tokens';
import type { EngineDeps } from '@/features/Practice/engine/types';

export interface WritingSessionSurfaceProps {
  /** A confirmed log may also give an early-stopped session a factual note. */
  loggedSession?: LoggedWritingSession;
  /** The length the timer opens at; the writer can change it before starting. */
  initialMinutes?: number;
  /** Keep floating controls inside the writing desk when Sources occupy a side pane. */
  rightInset?: number;
  /**
   * Begin the session on mount, because the page was opened in order to run it.
   *
   * Passed straight through to {@link WritingTimer}, whose prop carries the
   * reason it exists and the reason it is never a default.
   */
  autoStart?: boolean;
  /**
   * Every finished session, INCLUDING one the writer stopped early.
   *
   * Distinct from the note above, which speaks only for a session that ran its
   * whole length. That guard is about what the page SAYS; a session stopped at
   * twelve minutes of twenty is still twelve minutes of writing, and a consumer
   * recording it against a practice needs to hear about it. Reported before the
   * note is decided, so the two can never disagree about whether a session
   * happened.
   */
  onSession?: (_result: WritingSessionResult) => void;
  /**
   * What to hang in the note's ``children`` slot for a session that finished.
   *
   * A render prop rather than an import, so this module keeps the scope floor
   * ``writingTimerScope`` holds it to: an offer that saves a habit or a
   * practice reaches a store and the server, and it is the hosting screen that
   * supplies it. Absent, the note is exactly what it was — a sentence and a
   * way to close it.
   */
  renderOffer?: (_result: WritingSessionResult) => React.ReactNode;
  /** Reserve the measured note and timer together in the page scroller. */
  onClearanceChange?: (_clearance: number) => void;
  /** Reserve an untouched phone timer outside the paper instead of inside its scroller. */
  onIdleDockHeightChange?: (_height: number) => void;
  /** The engine's clock and adapter seam; tests inject it, production does not. */
  deps?: EngineDeps;
}

/**
 * A finished session, plus a number that changes for every session reported.
 *
 * The number is what keys the offer. Two sessions of the same length produce
 * equal results, and the banner is REPLACED rather than remounted, so without
 * it an offer halfway through an interaction would carry its state across onto
 * a sentence about a different session — which is precisely what
 * ``WritingSessionBanner``'s docstring tells the slot's occupant not to allow.
 */
interface StandingNote {
  message?: string;
  result: WritingSessionResult;
  ordinal: number;
}

function useBandClearance(
  onClearanceChange: WritingSessionSurfaceProps['onClearanceChange'],
  onIdleDockHeightChange: WritingSessionSurfaceProps['onIdleDockHeightChange'],
  scrollWholeSurface: boolean,
  lift: number,
  idleDocked: boolean,
) {
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);
  const reportLayout = useCallback((event: LayoutChangeEvent) => {
    setVisibleHeight(event.nativeEvent.layout.height);
  }, []);
  useEffect(() => {
    if (idleDocked) {
      onClearanceChange?.(0);
      if (visibleHeight !== null) onIdleDockHeightChange?.(visibleHeight + SPACING.md);
      return;
    }
    onIdleDockHeightChange?.(0);
    if (visibleHeight === null) return;
    onClearanceChange?.(
      Math.max(scrollWholeSurface ? 0 : WRITING_TIMER_CLEARANCE, visibleHeight + lift + SPACING.md),
    );
  }, [
    idleDocked,
    lift,
    onClearanceChange,
    onIdleDockHeightChange,
    scrollWholeSurface,
    visibleHeight,
  ]);
  useEffect(
    () => () => {
      onIdleDockHeightChange?.(0);
    },
    [onIdleDockHeightChange],
  );
  return reportLayout;
}

function useStandingNote(
  onSession: WritingSessionSurfaceProps['onSession'],
  loggedSession: WritingSessionSurfaceProps['loggedSession'],
) {
  const [note, setNote] = useState<StandingNote | null>(null);
  const latest = useRef<WritingSessionResult | null>(null);
  const dismissed = useRef<WritingSessionResult | null>(null);
  const dismiss = useCallback(() => {
    dismissed.current = latest.current;
    setNote(null);
  }, []);
  // Keep the timer callback stable while delivering the latest session listener.
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const record = useCallback((result: WritingSessionResult) => {
    latest.current = result;
    dismissed.current = null;
    onSessionRef.current?.(result);
    if (!result.reachedFullDuration) return;
    setNote((previous) => ({ result, ordinal: (previous?.ordinal ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (
      !loggedSession ||
      loggedSession.result !== latest.current ||
      loggedSession.result === dismissed.current
    )
      return;
    setNote((previous) => ({
      result: loggedSession.result,
      message: loggedSession.message,
      ordinal:
        previous?.result === loggedSession.result ? previous.ordinal : (previous?.ordinal ?? 0) + 1,
    }));
  }, [loggedSession]);
  return { note, dismiss, record };
}

/** The height a lowered band gains by giving up its resonance-sized lift. */
const LIFT_GIVEN_UP = RESONANCE_BUTTON_CLEARANCE - WRITING_BAND_LOWERED_CLEARANCE;
/** Match the page's single-column breakpoint: below it, there is no side rail for an idle card. */
export const IDLE_TIMER_DOCK_MAX_WIDTH = 600;

function useIdleTimerDock(): { idleDocked: boolean; beginFloatingSession: () => void } {
  const [hasStarted, setHasStarted] = useState(false);
  const idleDocked = useWindowDimensions().width < IDLE_TIMER_DOCK_MAX_WIDTH && !hasStarted;
  const beginFloatingSession = useCallback(() => setHasStarted(true), []);
  return { idleDocked, beginFloatingSession };
}

function useBandBounds() {
  // The band's height as it would be at the full lift, whichever lift it was
  // measured at, so lowering it can never feed back into the decision to lower.
  const [liftedHeight, setLiftedHeight] = useState(Infinity);
  const [contentHeight, setContentHeight] = useState(0);
  // Measure the unshrunk note, offers and clock: enlarged text and an open
  // picker need their real height, rather than a count of nominal targets.
  const lowered = contentHeight > liftedHeight;
  const loweredRef = useRef(lowered);
  loweredRef.current = lowered;
  const scrollWholeSurface = contentHeight > liftedHeight + (lowered ? LIFT_GIVEN_UP : 0);
  const reportBandLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    setLiftedHeight(loweredRef.current ? measured - LIFT_GIVEN_UP : measured);
  }, []);
  const reportContentSize = useCallback((_width: number, height: number) => {
    setContentHeight(height);
  }, []);
  const lift = lowered ? WRITING_BAND_LOWERED_CLEARANCE : RESONANCE_BUTTON_CLEARANCE;
  return { scrollWholeSurface, lift, reportBandLayout, reportContentSize };
}

function StandingSessionNote({
  note,
  dismiss,
  scrollWholeSurface,
  renderOffer,
}: {
  note: StandingNote | null;
  dismiss: () => void;
  scrollWholeSurface: boolean;
  renderOffer: WritingSessionSurfaceProps['renderOffer'];
}): React.JSX.Element | null {
  if (note === null) return null;
  return (
    <WritingSessionBanner
      result={note.result}
      onDismiss={dismiss}
      scrollWholeSurface={scrollWholeSurface}
      loggedMessage={note.message}
    >
      {renderOffer === undefined || !note.result.reachedFullDuration ? null : (
        <React.Fragment key={note.ordinal}>{renderOffer(note.result)}</React.Fragment>
      )}
    </WritingSessionBanner>
  );
}

function writingBandStyle(idleDocked: boolean, rightInset: number, lift: number) {
  return [
    styles.band,
    idleDocked ? styles.idleDock : null,
    { right: rightInset, bottom: idleDocked ? 0 : lift },
  ];
}

function useWritingBandLayout(
  onClearanceChange: WritingSessionSurfaceProps['onClearanceChange'],
  onIdleDockHeightChange: WritingSessionSurfaceProps['onIdleDockHeightChange'],
) {
  const { idleDocked, beginFloatingSession } = useIdleTimerDock();
  const bounds = useBandBounds();
  const reportLayout = useBandClearance(
    onClearanceChange,
    onIdleDockHeightChange,
    bounds.scrollWholeSurface,
    bounds.lift,
    idleDocked,
  );
  return { ...bounds, idleDocked, beginFloatingSession, reportLayout };
}

function WritingSessionSurface({
  loggedSession,
  initialMinutes,
  rightInset = 0,
  autoStart,
  renderOffer,
  onSession,
  onClearanceChange,
  onIdleDockHeightChange,
  deps,
}: WritingSessionSurfaceProps): React.JSX.Element {
  const { note, dismiss, record } = useStandingNote(onSession, loggedSession);
  const layout = useWritingBandLayout(onClearanceChange, onIdleDockHeightChange);
  return (
    <View
      style={writingBandStyle(layout.idleDocked, rightInset, layout.lift)}
      pointerEvents="box-none"
      onLayout={layout.reportBandLayout}
      testID="writing-session-band"
    >
      <ScrollView
        style={[styles.content, layout.idleDocked ? styles.idleDockContent : null]}
        scrollEnabled={layout.scrollWholeSurface}
        pointerEvents="box-none"
        onLayout={layout.reportLayout}
        onContentSizeChange={layout.reportContentSize}
        keyboardShouldPersistTaps="handled"
        testID="writing-session-band-content"
      >
        <StandingSessionNote
          note={note}
          dismiss={dismiss}
          scrollWholeSurface={layout.scrollWholeSurface}
          renderOffer={renderOffer}
        />
        <WritingTimer
          initialMinutes={initialMinutes}
          autoStart={autoStart}
          onComplete={record}
          onStart={layout.beginFloatingSession}
          withinBand
          deps={deps}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: '100%',
  },
  band: {
    position: 'absolute',
    // Leave the upper half for page actions. The bottom is a lift applied at
    // render: the resonance-sized baseline, or the lowered gap when the content
    // cannot fit above it. Past even that, the complete surface scrolls,
    // including its summary, Close and timer.
    top: '50%',
    justifyContent: 'flex-end',
    left: 0,
    right: 0,
    paddingHorizontal: journalSheet.deskPaddingH,
  },
  /**
   * An untouched phone timer is a quiet tray below the paper, not an overlay.
   * It gives the writing sheet the remaining flex height and needs no synthetic
   * page clearance because it cannot cover anything inside that sheet.
   */
  idleDock: {
    position: 'absolute',
    // React Native Web does not let `undefined` in a later style clear the
    // band's `top: 50%`; CSS `auto` is the explicit reset that makes this a
    // bottom-sized tray instead of a stretched lower-half overlay.
    top: 'auto',
    bottom: 0,
    paddingBottom: SPACING.md,
  },
  /** In flow, the content defines the tray's height; no absolute band caps it. */
  idleDockContent: {
    flexShrink: 0,
    maxHeight: undefined,
  },
});

export default WritingSessionSurface;
