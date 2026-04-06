import React, { useState } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import { Calendar, type DateData } from 'react-native-calendars';

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

const MissedDaysBody = ({
  habit,
  missedDays,
  onClose,
  onBackfill,
  onNewStartDate,
}: MissedDaysBodyProps) => {
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());

  const handleBackfill = () => {
    if (habit.id) {
      onBackfill(habit.id, missedDays);
      onClose();
    }
  };

  const handleDateSelect = (date: DateData) => {
    setSelectedDate(new Date(date.dateString));
    setShowCalendar(false);
    if (habit.id) {
      onNewStartDate(habit.id, new Date(date.dateString));
      onClose();
    }
  };

  const selectedDateString = selectedDate.toISOString().split('T')[0]!;

  return (
    <View style={styles.missedDaysContent}>
      <MissedDaysText habitName={habit.name} missedCount={missedDays.length} />
      {showCalendar ? (
        <Calendar
          onDayPress={handleDateSelect}
          markedDates={{
            [selectedDateString ?? '']: {
              selected: true,
              selectedColor: STAGE_COLORS[habit.stage],
            },
          }}
          minDate={new Date().toISOString()}
        />
      ) : (
        <MissedDaysActions
          onBackfill={handleBackfill}
          onSelectNewDate={() => setShowCalendar(true)}
          onClose={onClose}
        />
      )}
    </View>
  );
};

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
