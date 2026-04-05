import { Audio } from 'expo-av';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, Vibration, View } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

type TimerState = 'idle' | 'running' | 'paused' | 'completed';

interface PracticeTimerProps {
  durationMinutes: number;
  onComplete: (_minutes: number) => void; // eslint-disable-line no-unused-vars
  onCancel: () => void;
}

const KEEP_AWAKE_TAG = 'practice-timer';
const TIMER_INTERVAL_MS = 1000;
const SECONDS_PER_MINUTE = 60;

/** Play a bundled sound asset. Errors are silently swallowed to avoid crashing the timer. */
async function playSound(source: number): Promise<void> {
  try {
    const { sound } = await Audio.Sound.createAsync(source);
    await sound.playAsync();
    // Unload after a short delay to let the sound finish
    setTimeout(() => {
      sound.unloadAsync();
    }, 3000);
  } catch {
    // Audio playback is best-effort; don't break the timer
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

const PracticeTimer: React.FC<PracticeTimerProps> = ({ durationMinutes, onComplete, onCancel }) => {
  const totalSeconds = durationMinutes * SECONDS_PER_MINUTE;
  const halfwaySeconds = Math.floor(totalSeconds / 2);

  const [remaining, setRemaining] = useState(totalSeconds);
  const [state, setState] = useState<TimerState>('idle');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const halfwayPlayedRef = useRef(false);

  const elapsed = totalSeconds - remaining;
  const progress = totalSeconds > 0 ? elapsed / totalSeconds : 0;

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const handleStart = useCallback(() => {
    setState('running');
    halfwayPlayedRef.current = false;
    setRemaining(totalSeconds);
    playSound(SOUND_START);
    activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  }, [totalSeconds]);

  const handlePause = useCallback(() => {
    setState('paused');
    clearTimer();
  }, [clearTimer]);

  const handleResume = useCallback(() => {
    setState('running');
  }, []);

  const handleCancel = useCallback(() => {
    clearTimer();
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    setState('idle');
    setRemaining(totalSeconds);
    halfwayPlayedRef.current = false;
    onCancel();
  }, [clearTimer, onCancel, totalSeconds]);

  // Tick effect
  useEffect(() => {
    if (state !== 'running') return;

    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          return 0;
        }
        return next;
      });
    }, TIMER_INTERVAL_MS);

    return () => {
      clearTimer();
    };
  }, [state, clearTimer]);

  // Halfway sound effect
  useEffect(() => {
    if (state === 'running' && remaining <= halfwaySeconds && !halfwayPlayedRef.current) {
      halfwayPlayedRef.current = true;
      playSound(SOUND_HALF);
    }
  }, [remaining, state, halfwaySeconds]);

  // Completion effect
  useEffect(() => {
    if (state === 'running' && remaining <= 0) {
      clearTimer();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
      setState('completed');
      playSound(SOUND_END);
      Vibration.vibrate([0, 200, 100, 200, 100, 200]);
      onComplete(durationMinutes);
    }
  }, [remaining, state, clearTimer, durationMinutes, onComplete]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimer();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [clearTimer]);

  return (
    <View style={styles.container} testID="practice-timer">
      {/* Circular progress ring */}
      <View style={styles.ringContainer}>
        <View style={styles.ring} testID="timer-ring">
          <View style={styles.timeDisplay}>
            <Text style={styles.timeText} testID="time-remaining">
              {formatTime(remaining)}
            </Text>
            {state === 'completed' && (
              <Text style={styles.completeLabel} testID="timer-complete-label">
                Complete
              </Text>
            )}
          </View>
        </View>
        {/* Visual progress indicator */}
        <View
          style={[styles.progressArc, { opacity: progress }]}
          testID="progress-indicator"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        />
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        {state === 'idle' && (
          <TouchableOpacity style={styles.startButton} onPress={handleStart} testID="start-button">
            <Text style={styles.startButtonText}>Start</Text>
          </TouchableOpacity>
        )}

        {state === 'running' && (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.pauseButton}
              onPress={handlePause}
              testID="pause-button"
            >
              <Text style={styles.pauseButtonText}>Pause</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={handleCancel}
              testID="cancel-button"
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === 'paused' && (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.startButton}
              onPress={handleResume}
              testID="resume-button"
            >
              <Text style={styles.startButtonText}>Resume</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={handleCancel}
              testID="cancel-button"
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
};

const RING_SIZE = 220;

const styles = StyleSheet.create({
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
