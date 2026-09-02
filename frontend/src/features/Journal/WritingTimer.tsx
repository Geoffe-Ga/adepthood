/**
 * ``WritingTimer`` — the floating offer to write for a set length of time.
 *
 * Hosts the ritual engine, and is deliberately a leaf. The engine ticks ten
 * times a second, so whatever holds it re-renders ten times a second; putting
 * it inside the writing column would mean re-rendering both text fields and the
 * live word count under the writer's hands. Mounted instead as a screen-level
 * sibling — the same placement, and the same reason, as the floating resonance
 * button beside it — nothing but this pill repaints while a session runs.
 *
 * The session is bell-free on purpose: ``cuesForMeditation`` defaults
 * ``start_bell`` and ``end_bell`` to true, so a bare meditation config would
 * schedule a gong at 0:00 and again at the end. A writing page is not a
 * meditation cushion; all three flags are set false rather than left to the
 * silent default adapters to swallow.
 *
 * Stop is ``complete()``, never ``cancel()``: cancel resets to the initial
 * state and throws the elapsed time away, and a writer who stops early still
 * wrote for however long they wrote.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  RESONANCE_BUTTON_CLEARANCE,
  WRITING_TIMER_PILL_PADDING_V,
  WRITING_TIMER_ROW_GAP,
  WRITING_TIMER_ROW_HEIGHT,
} from './JournalEntry.styles';
import type { WritingSessionResult } from './writingSession';
import {
  DEFAULT_WRITING_MINUTES,
  WRITING_DURATION_PRESET_MINUTES,
  toWritingSessionResult,
} from './writingSession';
import {
  WRITING_TIMER_A11Y_LABEL,
  WRITING_TIMER_PAUSE,
  WRITING_TIMER_PAUSE_A11Y,
  WRITING_TIMER_PRESET_GROUP_LABEL,
  WRITING_TIMER_RESUME,
  WRITING_TIMER_RESUME_A11Y,
  WRITING_TIMER_START,
  WRITING_TIMER_START_A11Y,
  WRITING_TIMER_STOP,
  WRITING_TIMER_STOP_A11Y,
  writingTimerPresetA11yLabel,
  writingTimerPresetLabel,
} from './writingTimerCopy';
import type { TimerView } from './writingTimerView';
import { describeTimer, nextDurationMinutes } from './writingTimerView';

import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  journalSheet,
  shadows,
  touchTarget,
} from '@/design/tokens';
import type {
  EngineDeps,
  EngineStatus,
  MeditationTimerConfig,
  RitualControls,
} from '@/features/Practice/engine/types';
import { useRitualEngine } from '@/features/Practice/engine/useRitualEngine';

/** A stable empty deps object, so the default never changes identity per render. */
const NO_DEPS: EngineDeps = {};

export interface WritingTimerProps {
  /** The length the timer opens at; the writer can change it before starting. */
  initialMinutes?: number;
  /** Called once per finished session, however the session ended. */
  onComplete: (result: WritingSessionResult) => void;
  /** The engine's clock and adapter seam; tests inject it, production does not. */
  deps?: EngineDeps;
}

/** The four lengths, offered as a row while the timer is at rest. */
function PresetRow({
  minutes,
  onChoose,
}: {
  minutes: number;
  onChoose: (next: number) => void;
}): React.JSX.Element {
  return (
    <View
      style={[styles.row, styles.presetRow]}
      accessibilityRole="radiogroup"
      accessibilityLabel={WRITING_TIMER_PRESET_GROUP_LABEL}
      testID="writing-timer-row-presets"
    >
      {WRITING_DURATION_PRESET_MINUTES.map((option) => (
        <TouchableOpacity
          key={option}
          style={[styles.preset, option === minutes ? styles.presetSelected : null]}
          onPress={() => onChoose(option)}
          accessibilityRole="radio"
          accessibilityLabel={writingTimerPresetA11yLabel(option)}
          accessibilityState={{ selected: option === minutes }}
          testID={`writing-timer-preset-${option}`}
        >
          <Text style={styles.presetLabel} numberOfLines={1}>
            {writingTimerPresetLabel(option)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

/** One control in the pill, at the 44dp touch floor. */
function TimerControl({
  label,
  a11yLabel,
  onPress,
  testID,
}: {
  label: string;
  a11yLabel: string;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.control}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled: false }}
      testID={testID}
    >
      <Text style={styles.controlLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Whichever of start / pause / resume / stop the current state offers.
 *
 * A fragment, not a row of its own: the controls sit beside the readout on the
 * pill's first row, which is what keeps the pill's height a count of rows
 * rather than a consequence of how much fits across a given phone.
 */
function TimerControls({
  view,
  controls,
}: {
  view: TimerView;
  controls: RitualControls;
}): React.JSX.Element {
  return (
    <>
      {view.showStart ? (
        <TimerControl
          label={WRITING_TIMER_START}
          a11yLabel={WRITING_TIMER_START_A11Y}
          onPress={controls.start}
          testID="writing-timer-start"
        />
      ) : null}
      {view.showPause ? (
        <TimerControl
          label={WRITING_TIMER_PAUSE}
          a11yLabel={WRITING_TIMER_PAUSE_A11Y}
          onPress={controls.pause}
          testID="writing-timer-pause"
        />
      ) : null}
      {view.showResume ? (
        <TimerControl
          label={WRITING_TIMER_RESUME}
          a11yLabel={WRITING_TIMER_RESUME_A11Y}
          onPress={controls.resume}
          testID="writing-timer-resume"
        />
      ) : null}
      {view.showStop ? (
        <TimerControl
          label={WRITING_TIMER_STOP}
          a11yLabel={WRITING_TIMER_STOP_A11Y}
          onPress={controls.complete}
          testID="writing-timer-stop"
        />
      ) : null}
    </>
  );
}

interface SessionReport {
  status: EngineStatus;
  elapsedMs: number;
  minutes: number;
  controls: RitualControls;
  onComplete: (result: WritingSessionResult) => void;
}

/**
 * Report a finished session exactly once, on the edge into ``complete``.
 *
 * The engine lands both a countdown that reached zero and a session the writer
 * stopped on the same status, so the edge — not the status — is the event. The
 * timer then cancels itself back to rest, which is what lets a second session
 * begin in the same mount without carrying anything over from the first.
 */
function useSessionReport({
  status,
  elapsedMs,
  minutes,
  controls,
  onComplete,
}: SessionReport): void {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = status;
    if (previous === 'complete' || status !== 'complete') return;
    onCompleteRef.current(toWritingSessionResult({ plannedMinutes: minutes, elapsedMs }));
    controls.cancel();
  }, [status, elapsedMs, minutes, controls]);
}

/**
 * The engine config for a writing session of the given length.
 *
 * Every bell is explicitly off. ``cuesForMeditation`` defaults ``start_bell``
 * and ``end_bell`` to true, so a bare meditation config would schedule a gong
 * at 0:00 and again at the end — silent today only because the engine
 * substitutes no-op adapters when a caller passes none. Relying on that would
 * put a meditation gong one prop away from the writing page.
 */
function useWritingConfig(minutes: number): MeditationTimerConfig {
  return useMemo(
    () => ({
      mode: 'meditation_timer',
      duration_minutes: minutes,
      start_bell: false,
      halfway_bell: false,
      end_bell: false,
    }),
    [minutes],
  );
}

function WritingTimer({
  initialMinutes = DEFAULT_WRITING_MINUTES,
  onComplete,
  deps = NO_DEPS,
}: WritingTimerProps): React.JSX.Element {
  const [minutes, setMinutes] = useState(initialMinutes);
  const [state, controls] = useRitualEngine(useWritingConfig(minutes), deps);
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  const view = describeTimer({
    status: state.status,
    remainingMs: state.remainingMs,
    minutes,
  });
  useSessionReport({
    status: state.status,
    elapsedMs: state.elapsedMs,
    minutes,
    controls,
    onComplete,
  });
  const chooseMinutes = useCallback((next: number) => {
    setMinutes((current) => nextDurationMinutes(statusRef.current, current, next));
  }, []);
  return (
    <View style={styles.floatingWrapper} pointerEvents="box-none">
      <View style={styles.pill} pointerEvents="auto" testID="writing-timer-pill">
        <View style={styles.row} testID="writing-timer-row-readout">
          <Text
            style={styles.readout}
            numberOfLines={1}
            accessibilityRole="text"
            accessibilityLabel={`${WRITING_TIMER_A11Y_LABEL}: ${view.readoutA11yLabel}`}
            testID="writing-timer-readout"
          >
            {view.readout}
          </Text>
          <TimerControls view={view} controls={controls} />
        </View>
        {view.showPresets ? <PresetRow minutes={minutes} onChoose={chooseMinutes} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Stacked above the resonance button's band rather than sharing it: the
   * resonance wrapper spans the page edge to edge, so "the other side of the
   * same row" is the same row. ``box-none`` keeps this band from becoming the
   * next thing that swallows a tap meant for something below it.
   */
  floatingWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: RESONANCE_BUTTON_CLEARANCE,
  },
  /**
   * A column of fixed-height rows, spanning the band rather than sizing itself
   * to its contents. Deliberately NOT a wrapping row: laid out that way the
   * readout, four presets and Start come to roughly 452dp in this face at this
   * size, so every phone reflowed it onto two or three rows and the page
   * reserved space for one. A column of known rows has a height that does not
   * depend on the width it is given.
   */
  pill: {
    flexDirection: 'column',
    gap: WRITING_TIMER_ROW_GAP,
    marginHorizontal: journalSheet.deskPaddingH,
    paddingVertical: WRITING_TIMER_PILL_PADDING_V,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xl,
    backgroundColor: colors.paper.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    ...shadows.small,
  },
  /** One row of the pill. Fixed height, so the pill's own height is countable. */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    height: WRITING_TIMER_ROW_HEIGHT,
  },
  readout: {
    ...editorialType.action,
    color: colors.paper.ink,
    // Takes the slack on its row, so the controls sit at the trailing edge and
    // a changing readout never shifts them.
    flex: 1,
  },
  presetRow: {
    justifyContent: 'space-between',
  },
  /**
   * Presets share their row's width instead of demanding their own. ``flex: 1``
   * is what lets four of them compress onto a narrow phone rather than pushing
   * the row wider than the screen; the touch-target minimum is the floor they
   * compress to.
   */
  preset: {
    flex: 1,
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
  },
  presetSelected: {
    backgroundColor: colors.paper.anchorHighlight,
    borderColor: colors.paper.inkSoft,
  },
  /**
   * A preset is pressed, so its label is interactive text and takes the
   * interactive face rather than the 13px caption face, which sits below the
   * tappable floor and is for metadata the reader only ever looks at.
   */
  presetLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
  control: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  controlLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default WritingTimer;
