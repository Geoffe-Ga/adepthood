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
  /**
   * Whether to say why the date is fixed. False while a next pass is pending
   * in the first cycle (#3747): the date is shown, not offered, because that
   * pass's own day is offered beside it instead -- there is no fix to explain.
   */
  showReason?: boolean;
}

export const ProgramStartFixed = ({
  label,
  date,
  showReason = true,
}: ProgramStartFixedProps): React.JSX.Element => (
  <View style={styles.startDateContainer} testID="program-start-fixed">
    <Text style={styles.startDateLabel}>
      {label} {formatDay(date)}
    </Text>
    {showReason && <Text style={styles.onboardingSubtitle}>{PROGRAM_START_FIXED_COPY}</Text>}
  </View>
);
