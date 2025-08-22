import React, { useState } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import { Calendar, type DateData } from 'react-native-calendars';

import { STAGE_COLORS } from '../../../constants/stageColors';
import styles from '../Habits.styles';
import type { MissedDaysModalProps } from '../Habits.types';

export const MissedDaysModal = ({
  visible,
  habit,
  missedDays,
  onClose,
  onBackfill,
  onNewStartDate,
}: MissedDaysModalProps) => {
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  if (!habit || missedDays.length === 0) return null;

  const handleBackfill = () => {
    if (habit.id) {
      onBackfill(habit.id, missedDays);
      onClose();
    }
  };

  const handleSelectNewDate = () => {
    setShowCalendar(true);
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.missedDaysContent}>
          <Text style={styles.missedDaysTitle}>Missed you!</Text>
          <Text style={styles.missedDaysSubtitle}>
            We missed {missedDays.length} day
            {missedDays.length !== 1 ? 's' : ''} for '{habit.name}'.
          </Text>
          <Text style={styles.missedDaysQuestion}>
            Did you keep up with '{habit.name}' while you were gone?
          </Text>
          {showCalendar ? (
            <Calendar
              onDayPress={handleDateSelect}
              markedDates={{
                // Default to an empty key if parsing fails to satisfy typing
                [selectedDateString ?? '']: {
                  selected: true,
                  selectedColor: STAGE_COLORS[habit.stage],
                },
              }}
              minDate={new Date().toISOString()}
            />
          ) : (
            <View style={styles.missedDaysButtons}>
              <TouchableOpacity
                style={[styles.missedDaysButton, styles.yesButton]}
                onPress={handleBackfill}
              >
                <Text style={styles.missedDaysButtonText}>Yes, I did it!</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.missedDaysButton, styles.resetButton]}
                onPress={handleSelectNewDate}
              >
                <Text style={styles.missedDaysButtonText}>Set new start date</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.missedDaysButton, styles.cancelButton]}
                onPress={onClose}
              >
                <Text style={styles.missedDaysButtonText}>Just continue</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
};

export default MissedDaysModal;
