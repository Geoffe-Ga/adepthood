import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import React, { useEffect, useState } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { STAGE_COLORS } from '../../../constants/stageColors';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import { STAGE_ORDER, calculateHabitStartDate } from '../HabitUtils';

export const ReorderHabitsModal = ({
  visible,
  habits,
  onClose,
  onSaveOrder,
}: ReorderHabitsModalProps) => {
  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  useEffect(() => {
    // Sort habits by stage according to STAGE_ORDER
    if (visible && habits.length > 0) {
      const sortedHabits = [...habits].sort((a, b) => {
        const stageIndexA = STAGE_ORDER.indexOf(a.stage);
        const stageIndexB = STAGE_ORDER.indexOf(b.stage);
        return stageIndexA - stageIndexB;
      });

      // Update start dates based on order
      const updatedHabits = sortedHabits.map((habit, index) => ({
        ...habit,
        start_date: calculateHabitStartDate(startDate, index),
      }));

      setOrderedHabits(updatedHabits);
    }
  }, [visible, habits, startDate]);

  const handleDragEnd = ({ data }: { data: Habit[] }) => {
    // Update dates based on new order
    const updatedHabits = data.map((habit, index) => ({
      ...habit,
      start_date: calculateHabitStartDate(startDate, index),
    }));

    setOrderedHabits(updatedHabits);
  };

  const handleDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowDatePicker(Platform.OS === 'ios');
    if (selectedDate) {
      setStartDate(selectedDate);

      // Update all start dates
      const updatedHabits = orderedHabits.map((habit, index) => ({
        ...habit,
        start_date: calculateHabitStartDate(selectedDate, index),
      }));

      setOrderedHabits(updatedHabits);
    }
  };

  const handleSave = () => {
    onSaveOrder(orderedHabits);
    onClose();
  };

  const formatDate = (date: Date): string => {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.reorderModalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Reorder Habits</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.datePickerContainer}>
            <Text style={styles.datePickerLabel}>First Habit Start Date:</Text>
            <TouchableOpacity
              testID="reorder-start-date"
              style={styles.datePickerButton}
              onPress={() => setShowDatePicker(true)}
            >
              <Text style={styles.datePickerButtonText}>{formatDate(startDate)}</Text>
            </TouchableOpacity>

            {showDatePicker && (
              <Modal transparent testID="reorder-date-picker-modal">
                <DateTimePicker
                  value={startDate}
                  mode="date"
                  display="default"
                  onChange={handleDateChange}
                />
              </Modal>
            )}
          </View>

          <Text style={styles.reorderInstructions}>
            Drag habits to reorder. Habits 1–8 start 21 days apart, habits 9–10 start 42 days apart.
          </Text>

          <View style={styles.reorderList}>
            <DraggableFlatList
              style={{ flex: 1 }}
              data={orderedHabits}
              keyExtractor={(item) => (item.id ? item.id.toString() : Math.random().toString())}
              renderItem={({ item, drag, isActive }) => (
                <TouchableOpacity
                  onLongPress={drag}
                  disabled={isActive}
                  style={[
                    styles.reorderItem,
                    isActive && styles.reorderItemActive,
                    {
                      borderLeftColor: STAGE_COLORS[item.stage] || '#ccc',
                      borderLeftWidth: 4,
                    },
                  ]}
                >
                  <View style={styles.reorderItemContent}>
                    <Text style={styles.reorderItemText}>
                      {item.icon} {item.name} ({item.stage})
                    </Text>
                    <Text style={styles.reorderItemDate}>
                      {formatDate(new Date(item.start_date))}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
              onDragEnd={handleDragEnd}
            />
          </View>

          <TouchableOpacity style={styles.saveOrderButton} onPress={handleSave}>
            <Text style={styles.saveOrderButtonText}>Save Order</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

export default ReorderHabitsModal;
