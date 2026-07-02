import React from 'react';
import { Text } from 'react-native';

import { formatTime } from '../formatTime';
import { useSessionSurface } from '../sessionSurface';

import { MEDITATION_TIMER_LABEL } from './sessionStyles';

interface Props {
  ms: number;
  testID: string;
}

/** Large tabular mm:ss timer tinted to the active session surface's text. */
export const SessionTimerLabel = ({ ms, testID }: Props): React.JSX.Element => {
  const surface = useSessionSurface();
  return (
    <Text style={[MEDITATION_TIMER_LABEL, { color: surface.text }]} testID={testID}>
      {formatTime(ms)}
    </Text>
  );
};
