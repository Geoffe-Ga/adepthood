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
import { Minus, Pause, Play, Square } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';

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
  WRITING_TIMER_MINIMIZE,
  WRITING_TIMER_MINIMIZE_A11Y,
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
  journalLayout,
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

const JOURNAL_SHEET_MAX_WIDTH = journalLayout.pageMaxWidth + journalLayout.marginColumnWidth;
const TIMER_DOCK_TRACK_MAX_WIDTH = JOURNAL_SHEET_MAX_WIDTH + 2 * (touchTarget.minimum + SPACING.sm);
const TIMER_DOCK_MIN_VIEWPORT_WIDTH = TIMER_DOCK_TRACK_MAX_WIDTH + 2 * SPACING.sm;

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
      style={styles.row}
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
  icon,
  iconOnly = false,
  docked = false,
}: {
  label: string;
  a11yLabel: string;
  onPress: () => void;
  testID: string;
  icon?: React.ReactNode;
  iconOnly?: boolean;
  docked?: boolean;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.control, docked ? styles.controlDocked : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled: false }}
      testID={testID}
    >
      {icon}
      {iconOnly ? null : <Text style={styles.controlLabel}>{label}</Text>}
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
function LiveTimerControls({
  view,
  controls,
  compact,
  docked,
}: {
  view: TimerView;
  controls: RitualControls;
  compact: boolean;
  docked: boolean;
}): React.JSX.Element {
  return (
    <>
      {view.showPause ? (
        <TimerControl
          label={WRITING_TIMER_PAUSE}
          a11yLabel={WRITING_TIMER_PAUSE_A11Y}
          onPress={controls.pause}
          testID="writing-timer-pause"
          icon={<Pause color={colors.paper.inkSoft} size={20} accessible={false} />}
          iconOnly={compact}
          docked={docked}
        />
      ) : null}
      {view.showResume ? (
        <TimerControl
          label={WRITING_TIMER_RESUME}
          a11yLabel={WRITING_TIMER_RESUME_A11Y}
          onPress={controls.resume}
          testID="writing-timer-resume"
          icon={<Play color={colors.paper.inkSoft} size={20} accessible={false} />}
          iconOnly={compact}
          docked={docked}
        />
      ) : null}
      {view.showStop ? (
        <TimerControl
          label={WRITING_TIMER_STOP}
          a11yLabel={WRITING_TIMER_STOP_A11Y}
          onPress={controls.complete}
          testID="writing-timer-stop"
          icon={<Square color={colors.paper.inkSoft} size={18} accessible={false} />}
          iconOnly={compact}
          docked={docked}
        />
      ) : null}
    </>
  );
}

/** The mutually exclusive idle and live controls. */
function TimerControls({
  view,
  controls,
  onStart,
  onMinimize,
  compact,
  docked,
}: {
  view: TimerView;
  controls: RitualControls;
  onStart: () => void;
  onMinimize: () => void;
  compact: boolean;
  docked: boolean;
}): React.JSX.Element {
  if (view.showStart) {
    return (
      <>
        <TimerControl
          label={WRITING_TIMER_START}
          a11yLabel={WRITING_TIMER_START_A11Y}
          onPress={onStart}
          testID="writing-timer-start"
          icon={<Play color={colors.paper.inkSoft} size={20} accessible={false} />}
          iconOnly
          docked={docked}
        />
        <TimerControl
          label={WRITING_TIMER_MINIMIZE}
          a11yLabel={WRITING_TIMER_MINIMIZE_A11Y}
          onPress={onMinimize}
          testID="writing-timer-minimize"
          icon={<Minus color={colors.paper.inkSoft} size={20} accessible={false} />}
          iconOnly
          docked={docked}
        />
      </>
    );
  }
  return <LiveTimerControls view={view} controls={controls} compact={compact} docked={docked} />;
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

interface TimerPillProps {
  compact: boolean;
  docked: boolean;
  idle: boolean;
  minutes: number;
  view: TimerView;
  controls: RitualControls;
  onStart: () => void;
  onMinimize: () => void;
  onChooseMinutes: (_minutes: number) => void;
}

function TimerReadout({ view, docked }: { view: TimerView; docked: boolean }): React.JSX.Element {
  return (
    <Text
      style={[styles.readout, docked ? styles.readoutDocked : null]}
      numberOfLines={1}
      accessibilityRole="text"
      accessibilityLabel={`${WRITING_TIMER_A11Y_LABEL}: ${view.readoutA11yLabel}`}
      testID="writing-timer-readout"
    >
      {view.readout}
    </Text>
  );
}

/** The paper pill itself, shared by its expanded and desk-side mounts. */
function TimerPill({
  compact,
  docked,
  idle,
  minutes,
  view,
  controls,
  onStart,
  onMinimize,
  onChooseMinutes,
}: TimerPillProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.pill,
        compact ? styles.pillCompact : styles.pillExpanded,
        docked ? styles.pillDocked : null,
      ]}
      pointerEvents="auto"
      testID="writing-timer-pill"
    >
      <View
        style={[styles.row, docked ? styles.rowDocked : null]}
        testID="writing-timer-row-readout"
      >
        <TimerReadout view={view} docked={docked} />
        {compact && idle ? null : (
          <TimerControls
            view={view}
            controls={controls}
            onStart={onStart}
            onMinimize={onMinimize}
            compact={compact}
            docked={docked}
          />
        )}
      </View>
      {!compact && view.showPresets ? (
        <PresetRow minutes={minutes} onChoose={onChooseMinutes} />
      ) : null}
    </View>
  );
}

function TimerTrack({
  compact,
  docked,
  children,
}: {
  compact: boolean;
  docked: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  if (docked) {
    return (
      <View style={styles.dockTrack} pointerEvents="box-none" testID="writing-timer-dock-track">
        {children}
      </View>
    );
  }
  if (compact) return <>{children}</>;
  return (
    <View
      style={styles.expandedTrack}
      pointerEvents="box-none"
      testID="writing-timer-expanded-track"
    >
      {children}
    </View>
  );
}

/** Mount the pill full-width at rest or as a trailing-edge compact control. */
function TimerMount({
  compact,
  docked,
  idle,
  onExpand,
  children,
}: {
  compact: boolean;
  docked: boolean;
  idle: boolean;
  onExpand: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const mountedPill =
    compact && idle ? (
      <TouchableOpacity
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel="Open writing timer options"
        testID="writing-timer-compact"
      >
        {children}
      </TouchableOpacity>
    ) : (
      <View testID={compact ? 'writing-timer-compact' : undefined}>{children}</View>
    );
  return (
    <View
      style={[
        styles.floatingWrapper,
        compact ? styles.floatingWrapperCompact : null,
        docked ? styles.floatingWrapperDocked : null,
      ]}
      pointerEvents="box-none"
      testID="writing-timer-wrapper"
    >
      <TimerTrack compact={compact} docked={docked}>
        {mountedPill}
      </TimerTrack>
    </View>
  );
}

function WritingTimer({
  initialMinutes = DEFAULT_WRITING_MINUTES,
  onComplete,
  deps = NO_DEPS,
}: WritingTimerProps): React.JSX.Element {
  const viewportWidth = useWindowDimensions().width;
  const [minutes, setMinutes] = useState(initialMinutes);
  const [compact, setCompact] = useState(false);
  const [state, controls] = useRitualEngine(useWritingConfig(minutes), deps);
  const docked = compact && viewportWidth >= TIMER_DOCK_MIN_VIEWPORT_WIDTH;
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
  const start = useCallback(() => {
    setCompact(true);
    controls.start();
  }, [controls]);
  const expand = useCallback(() => {
    if (state.status === 'idle') setCompact(false);
  }, [state.status]);
  return (
    <TimerMount compact={compact} docked={docked} idle={state.status === 'idle'} onExpand={expand}>
      <TimerPill
        compact={compact}
        docked={docked}
        idle={state.status === 'idle'}
        minutes={minutes}
        view={view}
        controls={controls}
        onStart={start}
        onMinimize={() => setCompact(true)}
        onChooseMinutes={chooseMinutes}
      />
    </TimerMount>
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
  floatingWrapperCompact: {
    left: undefined,
    alignItems: 'flex-end',
    paddingRight: journalSheet.deskPaddingH,
  },
  floatingWrapperDocked: {
    left: 0,
    alignItems: 'stretch',
    paddingRight: 0,
  },
  dockTrack: {
    width: '100%',
    maxWidth: TIMER_DOCK_TRACK_MAX_WIDTH,
    alignSelf: 'center',
    alignItems: 'flex-end',
  },
  expandedTrack: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: journalSheet.deskPaddingH,
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
    paddingVertical: WRITING_TIMER_PILL_PADDING_V,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xl,
    backgroundColor: colors.paper.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    ...shadows.small,
  },
  pillExpanded: {
    width: '100%',
    maxWidth: journalLayout.pageMaxWidth,
  },
  pillCompact: {
    minWidth: 180,
  },
  pillDocked: {
    width: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: 0,
    paddingVertical: 0,
    gap: 0,
    borderRadius: BORDER_RADIUS.md,
  },
  /** One row of the pill. Fixed height, so the pill's own height is countable. */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    height: WRITING_TIMER_ROW_HEIGHT,
  },
  rowDocked: {
    flexDirection: 'column',
    gap: 0,
    height: 'auto',
  },
  readout: {
    ...editorialType.action,
    color: colors.paper.ink,
    // Takes the slack on its row, so the controls sit at the trailing edge and
    // a changing readout never shifts them.
    flex: 1,
  },
  readoutDocked: {
    fontSize: editorialType.action.fontSize,
    fontWeight: '400',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.5,
    width: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    flex: undefined,
    textAlign: 'center',
    textAlignVertical: 'center',
    lineHeight: touchTarget.minimum,
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
    minWidth: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  controlDocked: {
    width: touchTarget.minimum,
    paddingHorizontal: 0,
  },
  controlLabel: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default WritingTimer;
