import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import type { RitualControls, RitualState } from '../../engine/types';
import RitualControlsBar from '../RitualControlsBar';
import { useSessionSurface } from '../sessionSurface';

import { PrimaryButton } from './PrimaryButton';
import { SessionContainer } from './SessionContainer';
import { SessionTimerLabel } from './SessionTimerLabel';

import { BORDER_RADIUS, SPACING } from '@/design/tokens';

/** Long-press dwell before the timer-hidden cancel fires, in ms. */
const LONG_PRESS_MS = 800;

interface TestIDs {
  view: string;
  timer: string;
  begin: string;
  cancelLongpress: string;
}

interface Props {
  state: RitualState;
  controls: RitualControls;
  hideTimer: boolean;
  face: React.ReactNode;
  completeFooter?: React.ReactNode;
  testIDs: TestIDs;
}

/** Shared card/timer/footer scaffold for the single-card meditation views. */
export const MeditationCardShell = ({
  state,
  controls,
  hideTimer,
  face,
  completeFooter,
  testIDs,
}: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  const showTimer =
    state.status === 'paused' ||
    state.status === 'complete' ||
    (state.status === 'running' && !hideTimer);
  return (
    <SessionContainer testID={testIDs.view}>
      {face}
      {showTimer && <SessionTimerLabel ms={state.remainingMs ?? 0} testID={testIDs.timer} />}
      <ShellFooter
        state={state}
        controls={controls}
        hideTimer={hideTimer}
        completeFooter={completeFooter}
        testIDs={testIDs}
        cancelTint={surface.textMuted}
      />
    </SessionContainer>
  );
};

interface FooterProps {
  state: RitualState;
  controls: RitualControls;
  hideTimer: boolean;
  completeFooter?: React.ReactNode;
  testIDs: TestIDs;
  /** Surface-aware tint for the timer-hidden long-press cancel affordance. */
  cancelTint: string;
}

const ShellFooter = ({
  state,
  controls,
  hideTimer,
  completeFooter,
  testIDs,
  cancelTint,
}: FooterProps): React.JSX.Element => {
  if (state.status === 'idle') {
    return (
      <PrimaryButton
        label="Begin meditation"
        accessibilityLabel="Begin meditation"
        onPress={controls.start}
        testID={testIDs.begin}
      />
    );
  }
  if (state.status === 'running' && hideTimer) {
    return (
      <Pressable
        style={[styles.longCancel, { borderColor: cancelTint }]}
        onLongPress={controls.cancel}
        delayLongPress={LONG_PRESS_MS}
        testID={testIDs.cancelLongpress}
        accessibilityRole="button"
        accessibilityLabel="Long-press to cancel meditation"
        accessibilityHint="Hold to end the sit early without revealing the timer."
      >
        <Text style={[styles.longCancelText, { color: cancelTint }]}>Hold to cancel</Text>
      </Pressable>
    );
  }
  if (state.status === 'complete' && completeFooter !== undefined) {
    return <>{completeFooter}</>;
  }
  // running (timer visible), paused, or complete without a custom footer.
  return <RitualControlsBar status={state.status} controls={controls} startLabel="Begin" />;
};

const styles = StyleSheet.create({
  longCancel: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
  },
  longCancelText: { fontSize: 13, letterSpacing: 1 },
});
