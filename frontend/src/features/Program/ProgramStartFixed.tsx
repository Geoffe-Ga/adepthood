import React from 'react';
import { Text, View } from 'react-native';

import { messageForCode } from '../../api/errorMessages';
import styles from '../Habits/Habits.styles';

/**
 * What a start-date picker shows once begin-again has fixed the date (#3097):
 * the date itself, read-only, and the same reason the server's 409 gives, so
 * the person is never offered a control that can only be refused.
 */
export const PROGRAM_START_FIXED_COPY =
  messageForCode('program_start_fixed_after_first_cycle') ?? '';

const formatDay = (date: Date): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

interface ProgramStartFixedProps {
  label: string;
  date: Date;
}

export const ProgramStartFixed = ({ label, date }: ProgramStartFixedProps): React.JSX.Element => (
  <View style={styles.startDateContainer} testID="program-start-fixed">
    <Text style={styles.startDateLabel}>
      {label} {formatDay(date)}
    </Text>
    <Text style={styles.onboardingSubtitle}>{PROGRAM_START_FIXED_COPY}</Text>
  </View>
);
