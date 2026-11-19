import React from 'react';
import { Text, View } from 'react-native';

import { messageForCode } from '../../api/errorMessages';
import styles from '../Habits/Habits.styles';

import { pendingPassLockCopy } from './passCopy';

/**
 * What a start-date picker shows once begin-again has fixed the date (#3097):
 * the date itself, read-only, and the same reason the server's 409 gives, so
 * the person is never offered a control that can only be refused.
 */
export const PROGRAM_START_FIXED_COPY =
  messageForCode('program_start_fixed_after_first_cycle') ?? '';

const formatDay = (date: Date): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Why the start date is shown rather than offered: a pending next pass (#3728),
 * which a correction would drop, else the begin-again fix.
 */
export const programStartLockedCopy = (pendingPassDay: string | null): string =>
  pendingPassDay === null ? PROGRAM_START_FIXED_COPY : pendingPassLockCopy(pendingPassDay);

interface ProgramStartFixedProps {
  label: string;
  date: Date;
  /** The pending next pass's day, when that is what locks the date. */
  pendingPassDay?: string | null;
}

export const ProgramStartFixed = ({
  label,
  date,
  pendingPassDay = null,
}: ProgramStartFixedProps): React.JSX.Element => (
  <View style={styles.startDateContainer} testID="program-start-fixed">
    <Text style={styles.startDateLabel}>
      {label} {formatDay(date)}
    </Text>
    <Text style={styles.onboardingSubtitle}>{programStartLockedCopy(pendingPassDay)}</Text>
  </View>
);
