import React from 'react';
import { Text } from 'react-native';

import type { SpokenTimeDirection } from '../formatTime';
import { formatTime, spokenTime } from '../formatTime';
import { useSessionSurface } from '../sessionSurface';

import { MEDITATION_TIMER_LABEL, SESSION_DISPLAY_MAX_FONT_SCALE } from './sessionStyles';

interface Props {
  ms: number;
  testID: string;
  /** How the readout is spoken to a screen reader; a countdown by default. */
  direction?: SpokenTimeDirection;
}

/** Large tabular mm:ss timer tinted to the active session surface's text. */
export const SessionTimerLabel = ({
  ms,
  testID,
  direction = 'remaining',
}: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  return (
    <Text
      style={[MEDITATION_TIMER_LABEL, { color: surface.text }]}
      testID={testID}
      accessibilityRole="timer"
      accessibilityLabel={spokenTime(ms, direction)}
      accessibilityLiveRegion="polite"
      maxFontSizeMultiplier={SESSION_DISPLAY_MAX_FONT_SCALE}
    >
      {formatTime(ms)}
    </Text>
  );
};
