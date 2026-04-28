import { Audio } from 'expo-av';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, Vibration, View } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

type TimerState = 'idle' | 'running' | 'paused' | 'completed';

interface PracticeTimerProps {
  durationMinutes: number;
  // BUG-FE-PRACTICE-101 / -105: emit wall-clock ISO timestamps the
  // backend can validate (BUG-PRACTICE-006), not a setInterval-derived
  // count that drifts when the JS timer is throttled in the background.
  onComplete: (_startedAt: Date, _endedAt: Date) => void;
  onCancel: () => void;
}

const KEEP_AWAKE_TAG = 'practice-timer';
const TIMER_INTERVAL_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

async function playSound(source: number): Promise<void> {
  try {
    const { sound } = await Audio.Sound.createAsync(source);
    await sound.playAsync();
    setTimeout(() => {
      sound.unloadAsync();
    }, 3000);
  } catch (err) {
    console.warn('Audio playback failed, falling back to vibration:', err);
    Vibration.vibrate(200);
  }
}

const SOUND_END = require('../../../assets/sounds/bell-end.mp3');
const SOUND_HALF = require('../../../assets/sounds/bell-half.mp3');
const SOUND_START = require('../../../assets/sounds/bell-start.mp3');

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const secs = totalSeconds % SECONDS_PER_MINUTE;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// --- Hook: timer state management ---

function useTimerState(totalSeconds: number) {
  const [remaining, setRemaining] = useState(totalSeconds);
  const [state, setState] = useState<TimerState>('idle');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const halfwayPlayedRef = useRef(false);
  // Wall-clock anchor: every render derives ``remaining`` from
  // ``Date.now()`` against this ref, so a backgrounded JS timer cannot
  // under-report (BUG-FE-PRACTICE-101).  ``effectiveStartMsRef`` is
  // shifted forward across pause/resume so it always represents the
  // moment the *current* run logically started.
  const effectiveStartMsRef = useRef<number | null>(null);
  const pauseStartMsRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const elapsed = totalSeconds - remaining;
  const progress = totalSeconds > 0 ? elapsed / totalSeconds : 0;

  return {
    remaining,
    setRemaining,
    state,
    setState,
    intervalRef,
    halfwayPlayedRef,
    effectiveStartMsRef,
    pauseStartMsRef,
    clearTimer,
    progress,
  };
}

// --- Hook: timer actions ---

function useStartPauseResume(totalSeconds: number, ts: ReturnType<typeof useTimerState>) {
  const {
    setState,
    setRemaining,
    halfwayPlayedRef,
    effectiveStartMsRef,
    pauseStartMsRef,
    clearTimer,
  } = ts;

  const handleStart = useCallback(() => {
    setState('running');
    halfwayPlayedRef.current = false;
    setRemaining(totalSeconds);
    effectiveStartMsRef.current = Date.now();
    pauseStartMsRef.current = null;
    playSound(SOUND_START);
    activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  }, [
    totalSeconds,
    setState,
    setRemaining,
    halfwayPlayedRef,
    effectiveStartMsRef,
    pauseStartMsRef,
  ]);

  const handlePause = useCallback(() => {
    pauseStartMsRef.current = Date.now();
    setState('paused');
    clearTimer();
  }, [pauseStartMsRef, setState, clearTimer]);

  const handleResume = useCallback(() => {
    // Slide the start anchor forward by the paused interval so the
    // visible count-down resumes exactly where it left off and the
    // wall-clock duration submitted on completion never includes the
    // pause window.
    if (pauseStartMsRef.current !== null && effectiveStartMsRef.current !== null) {
      effectiveStartMsRef.current += Date.now() - pauseStartMsRef.current;
    }
    pauseStartMsRef.current = null;
    setState('running');
  }, [effectiveStartMsRef, pauseStartMsRef, setState]);

  return { handleStart, handlePause, handleResume };
}

function useTimerActions(
  totalSeconds: number,
  ts: ReturnType<typeof useTimerState>,
  onCancel: () => void,
) {
  const {
    setState,
    setRemaining,
    halfwayPlayedRef,
    effectiveStartMsRef,
    pauseStartMsRef,
    clearTimer,
  } = ts;
  const { handleStart, handlePause, handleResume } = useStartPauseResume(totalSeconds, ts);

  const handleCancel = useCallback(() => {
    clearTimer();
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    setState('idle');
    setRemaining(totalSeconds);
    halfwayPlayedRef.current = false;
    effectiveStartMsRef.current = null;
    pauseStartMsRef.current = null;
    onCancel();
  }, [
    clearTimer,
    setState,
    setRemaining,
    halfwayPlayedRef,
    effectiveStartMsRef,
    pauseStartMsRef,
    onCancel,
    totalSeconds,
  ]);

  const tick = useCallback(() => {
    const startMs = effectiveStartMsRef.current;
    if (startMs === null) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / MS_PER_SECOND));
    setRemaining(Math.max(0, totalSeconds - elapsedSec));
  }, [effectiveStartMsRef, setRemaining, totalSeconds]);

  return { handleStart, handlePause, handleResume, handleCancel, tick };
}

// --- Hook: timer effects ---

function useTimerEffects(
  ts: ReturnType<typeof useTimerState>,
  tick: () => void,
  onComplete: (_startedAt: Date, _endedAt: Date) => void,
  totalSeconds: number,
) {
  const {
    state,
    remaining,
    clearTimer,
    setState,
    intervalRef,
    halfwayPlayedRef,
    effectiveStartMsRef,
  } = ts;
  const halfwaySeconds = Math.floor(totalSeconds / 2);

  useEffect(() => {
    if (state !== 'running') return;
    intervalRef.current = setInterval(tick, TIMER_INTERVAL_MS);
    return () => {
      clearTimer();
    };
  }, [state, clearTimer, intervalRef, tick]);

  useEffect(() => {
    if (state === 'running' && remaining <= halfwaySeconds && !halfwayPlayedRef.current) {
      halfwayPlayedRef.current = true;
      playSound(SOUND_HALF);
    }
  }, [remaining, state, halfwayPlayedRef, halfwaySeconds]);

  useEffect(() => {
    if (state !== 'running' || remaining > 0) return;
    clearTimer();
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    setState('completed');
    playSound(SOUND_END);
    Vibration.vibrate([0, 200, 100, 200, 100, 200]);
    const startMs = effectiveStartMsRef.current ?? Date.now() - totalSeconds * MS_PER_SECOND;
    // Cap ended_at to ``startMs + totalSeconds`` so a slightly-late tick
    // can't push the submitted duration above the configured length;
    // the server-side 8h hard cap is the next line of defence.
    const endedAtMs = Math.min(Date.now(), startMs + totalSeconds * MS_PER_SECOND);
    onComplete(new Date(startMs), new Date(endedAtMs));
  }, [remaining, state, clearTimer, setState, totalSeconds, onComplete, effectiveStartMsRef]);

  useEffect(() => {
    return () => {
      clearTimer();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [clearTimer]);
}

// --- Sub-components ---

interface TimerDisplayProps {
  remaining: number;
  progress: number;
  isCompleted: boolean;
}

const TimerDisplay = ({
  remaining,
  progress,
  isCompleted,
}: TimerDisplayProps): React.JSX.Element => (
  <View style={timerStyles.ringContainer}>
    <View style={timerStyles.ring} testID="timer-ring">
      <View style={timerStyles.timeDisplay}>
        <Text style={timerStyles.timeText} testID="time-remaining">
          {formatTime(remaining)}
        </Text>
        {isCompleted && (
          <Text style={timerStyles.completeLabel} testID="timer-complete-label">
            Complete
          </Text>
        )}
      </View>
    </View>
    <View
      style={[timerStyles.progressArc, { opacity: progress }]}
      testID="progress-indicator"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
    />
  </View>
);

const IdleControls = ({ onStart }: { onStart: () => void }): React.JSX.Element => (
  <TouchableOpacity
    style={timerStyles.startButton}
    onPress={onStart}
    testID="start-button"
    accessibilityLabel="Start timer"
    accessibilityRole="button"
  >
    <Text style={timerStyles.startButtonText}>Start</Text>
  </TouchableOpacity>
);

const RunningControls = ({
  onPause,
  onCancel,
}: {
  onPause: () => void;
  onCancel: () => void;
}): React.JSX.Element => (
  <View style={timerStyles.buttonRow}>
    <TouchableOpacity
      style={timerStyles.pauseButton}
      onPress={onPause}
      testID="pause-button"
      accessibilityLabel="Pause timer"
      accessibilityRole="button"
    >
      <Text style={timerStyles.pauseButtonText}>Pause</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={timerStyles.cancelButton}
      onPress={onCancel}
      testID="cancel-button"
      accessibilityLabel="Cancel timer"
      accessibilityRole="button"
    >
      <Text style={timerStyles.cancelButtonText}>Cancel</Text>
    </TouchableOpacity>
  </View>
);

const PausedControls = ({
  onResume,
  onCancel,
}: {
  onResume: () => void;
  onCancel: () => void;
}): React.JSX.Element => (
  <View style={timerStyles.buttonRow}>
    <TouchableOpacity
      style={timerStyles.startButton}
      onPress={onResume}
      testID="resume-button"
      accessibilityLabel="Resume timer"
      accessibilityRole="button"
    >
      <Text style={timerStyles.startButtonText}>Resume</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={timerStyles.cancelButton}
      onPress={onCancel}
      testID="cancel-button"
      accessibilityLabel="Cancel timer"
      accessibilityRole="button"
    >
      <Text style={timerStyles.cancelButtonText}>Cancel</Text>
    </TouchableOpacity>
  </View>
);

interface TimerControlsProps {
  state: TimerState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

const TimerControls = ({
  state,
  onStart,
  onPause,
  onResume,
  onCancel,
}: TimerControlsProps): React.JSX.Element => (
  <View style={timerStyles.controls}>
    {state === 'idle' && <IdleControls onStart={onStart} />}
    {state === 'running' && <RunningControls onPause={onPause} onCancel={onCancel} />}
    {state === 'paused' && <PausedControls onResume={onResume} onCancel={onCancel} />}
  </View>
);

// --- Main component ---

const PracticeTimer: React.FC<PracticeTimerProps> = ({ durationMinutes, onComplete, onCancel }) => {
  const totalSeconds = durationMinutes * SECONDS_PER_MINUTE;
  const ts = useTimerState(totalSeconds);
  const controls = useTimerActions(totalSeconds, ts, onCancel);
  useTimerEffects(ts, controls.tick, onComplete, totalSeconds);

  return (
    <View style={timerStyles.container} testID="practice-timer">
      <TimerDisplay
        remaining={ts.remaining}
        progress={ts.progress}
        isCompleted={ts.state === 'completed'}
      />
      <TimerControls
        state={ts.state}
        onStart={controls.handleStart}
        onPause={controls.handlePause}
        onResume={controls.handleResume}
        onCancel={controls.handleCancel}
      />
    </View>
  );
};

const RING_SIZE = 220;

const timerStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: SPACING.xl,
  },
  ringContainer: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xxl,
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 6,
    borderColor: colors.background.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.medium,
    backgroundColor: colors.background.card,
  },
  progressArc: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 6,
    borderColor: colors.success,
  },
  timeDisplay: {
    alignItems: 'center',
  },
  timeText: {
    fontSize: 42,
    fontWeight: '300',
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  completeLabel: {
    fontSize: 16,
    color: colors.success,
    fontWeight: '600',
    marginTop: SPACING.xs,
  },
  controls: {
    width: '100%',
    alignItems: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  startButton: {
    backgroundColor: colors.primary,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xxl,
    minWidth: 140,
    alignItems: 'center',
  },
  startButtonText: {
    color: colors.text.light,
    fontSize: 18,
    fontWeight: '600',
  },
  pauseButton: {
    backgroundColor: colors.warning,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    minWidth: 120,
    alignItems: 'center',
  },
  pauseButtonText: {
    color: colors.text.light,
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    minWidth: 120,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: '600',
  },
});

export default PracticeTimer;
