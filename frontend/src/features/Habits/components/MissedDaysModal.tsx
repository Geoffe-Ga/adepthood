import React, { useState } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import { Calendar, type DateData } from 'react-native-calendars';

import { parseISODate, toISODate } from '../../../components/DatePicker';
import { STAGE_COLORS } from '../../../design/tokens';
import styles from '../Habits.styles';
import type { MissedDaysModalProps } from '../Habits.types';

interface MissedDaysActionsProps {
  onBackfill: () => void;
  onSelectNewDate: () => void;
  onClose: () => void;
}

const MissedDaysActions = ({ onBackfill, onSelectNewDate, onClose }: MissedDaysActionsProps) => (
  <View style={styles.missedDaysButtons}>
    <TouchableOpacity style={[styles.missedDaysButton, styles.yesButton]} onPress={onBackfill}>
      <Text style={styles.missedDaysButtonText}>Yes, I did it!</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={[styles.missedDaysButton, styles.resetButton]}
      onPress={onSelectNewDate}
    >
      <Text style={styles.missedDaysButtonText}>Set new start date</Text>
    </TouchableOpacity>
    <TouchableOpacity style={[styles.missedDaysButton, styles.cancelButton]} onPress={onClose}>
      <Text style={styles.missedDaysButtonText}>Just continue</Text>
    </TouchableOpacity>
  </View>
);

interface MissedDaysBodyProps {
  habit: NonNullable<MissedDaysModalProps['habit']>;
  missedDays: Date[];
  onClose: () => void;
  onBackfill: MissedDaysModalProps['onBackfill'];
  onNewStartDate: MissedDaysModalProps['onNewStartDate'];
}

const MissedDaysText = ({ habitName, missedCount }: { habitName: string; missedCount: number }) => {
  const pluralSuffix = missedCount !== 1 ? 's' : '';
  return (
    <>
      <Text style={styles.missedDaysTitle}>Missed you!</Text>
      <Text style={styles.missedDaysSubtitle}>
        {`We missed ${missedCount} day${pluralSuffix} for '${habitName}'.`}
      </Text>
      <Text style={styles.missedDaysQuestion}>
        {`Did you keep up with '${habitName}' while you were gone?`}
      </Text>
    </>
  );
};

/**
 * BUG-FE-HABIT-202: holds the user's calendar pick until they confirm.
 * Tapping a day used to immediately wipe every prior completion -- the
 * confirm step makes the data-loss explicit.
 */
const useResetFlow = (
  habit: { id?: number },
  onNewStartDate: MissedDaysModalProps['onNewStartDate'],
  onClose: () => void,
) => {
  const [pendingDate, setPendingDate] = useState<Date | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showCalendar, setShowCalendar] = useState(false);
  const onPick = (date: DateData) => {
    const picked = parseISODate(date.dateString);
    setSelectedDate(picked);
    setPendingDate(picked);
  };
  const onConfirm = () => {
    if (pendingDate && habit.id) {
      onNewStartDate(habit.id, pendingDate);
      setPendingDate(null);
      setShowCalendar(false);
      onClose();
    }
  };
  return {
    pendingDate,
    selectedDate,
    showCalendar,
    setShowCalendar,
    onPick,
    onConfirm,
    onCancel: () => setPendingDate(null),
  };
};

const MissedDaysBody = ({
  habit,
  missedDays,
  onClose,
  onBackfill,
  onNewStartDate,
}: MissedDaysBodyProps) => {
  const reset = useResetFlow(habit, onNewStartDate, onClose);

  const handleBackfill = () => {
    if (habit.id) {
      onBackfill(habit.id, missedDays);
      onClose();
    }
  };

  const selectedDateString = toISODate(reset.selectedDate);

  return (
    <View style={styles.missedDaysContent}>
      <MissedDaysText habitName={habit.name} missedCount={missedDays.length} />
      {reset.pendingDate ? (
        <ResetConfirmation
          habitName={habit.name}
          pendingDate={reset.pendingDate}
          onConfirm={reset.onConfirm}
          onCancel={reset.onCancel}
        />
      ) : reset.showCalendar ? (
        <Calendar
          onDayPress={reset.onPick}
          markedDates={{
            [selectedDateString]: {
              selected: true,
              selectedColor: STAGE_COLORS[habit.stage],
            },
          }}
          minDate={toISODate(new Date())}
        />
      ) : (
        <MissedDaysActions
          onBackfill={handleBackfill}
          onSelectNewDate={() => reset.setShowCalendar(true)}
          onClose={onClose}
        />
      )}
    </View>
  );
};

interface ResetConfirmationProps {
  habitName: string;
  pendingDate: Date;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ResetConfirmation = ({
  habitName,
  pendingDate,
  onConfirm,
  onCancel,
}: ResetConfirmationProps) => (
  <View style={styles.missedDaysButtons}>
    <Text style={styles.missedDaysQuestion} testID="reset-confirm-warning">
      {`Reset start date for '${habitName}' to ${pendingDate.toDateString()}? This wipes every prior completion.`}
    </Text>
    <TouchableOpacity
      style={[styles.missedDaysButton, styles.resetButton]}
      onPress={onConfirm}
      testID="reset-confirm-yes"
    >
      <Text style={styles.missedDaysButtonText}>Yes, reset and erase progress</Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={[styles.missedDaysButton, styles.cancelButton]}
      onPress={onCancel}
      testID="reset-confirm-cancel"
    >
      <Text style={styles.missedDaysButtonText}>Cancel</Text>
    </TouchableOpacity>
  </View>
);

export const MissedDaysModal = ({
  visible,
  habit,
  missedDays,
  onClose,
  onBackfill,
  onNewStartDate,
}: MissedDaysModalProps) => {
  if (!habit || missedDays.length === 0) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <MissedDaysBody
          habit={habit}
          missedDays={missedDays}
          onClose={onClose}
          onBackfill={onBackfill}
          onNewStartDate={onNewStartDate}
        />
      </View>
    </Modal>
  );
};

export default MissedDaysModal;
