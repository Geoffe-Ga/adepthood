import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import React, { useEffect, useState } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { STAGE_COLORS } from '../../../design/tokens';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import { STAGE_ORDER, calculateHabitStartDate } from '../HabitUtils';

const formatDate = (date: Date): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const updateStartDates = (habits: Habit[], startDate: Date): Habit[] =>
  habits.map((habit, index) => ({
    ...habit,
    start_date: calculateHabitStartDate(startDate, index),
  }));

interface ReorderItemProps {
  item: Habit;
  drag: () => void;
  isActive: boolean;
}

const ReorderHabitItem = ({ item, drag, isActive }: ReorderItemProps) => (
  <TouchableOpacity
    onLongPress={drag}
    disabled={isActive}
    style={[
      styles.reorderItem,
      isActive && styles.reorderItemActive,
      { borderLeftColor: STAGE_COLORS[item.stage] || '#ccc', borderLeftWidth: 4 },
    ]}
  >
    <View style={styles.reorderItemContent}>
      <Text style={styles.reorderItemText}>
        {item.icon} {item.name} ({item.stage})
      </Text>
      <Text style={styles.reorderItemDate}>{formatDate(new Date(item.start_date))}</Text>
    </View>
  </TouchableOpacity>
);

interface ReorderDatePickerProps {
  startDate: Date;
  showDatePicker: boolean;
  setShowDatePicker: (_v: boolean) => void;
  onDateChange: (_event: DateTimePickerEvent, _date?: Date) => void;
}

const ReorderDatePicker = ({
  startDate,
  showDatePicker,
  setShowDatePicker,
  onDateChange,
}: ReorderDatePickerProps) => (
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
        <DateTimePicker value={startDate} mode="date" display="default" onChange={onDateChange} />
      </Modal>
    )}
  </View>
);

interface ReorderListProps {
  orderedHabits: Habit[];
  onDragEnd: (_data: { data: Habit[] }) => void;
}

const ReorderList = ({ orderedHabits, onDragEnd }: ReorderListProps) => (
  <View style={styles.reorderList}>
    <DraggableFlatList
      style={{ flex: 1 }}
      data={orderedHabits}
      keyExtractor={(item) => (item.id ? item.id.toString() : item.name)}
      renderItem={({ item, drag, isActive }) => (
        <ReorderHabitItem item={item} drag={drag} isActive={isActive} />
      )}
      onDragEnd={onDragEnd}
    />
  </View>
);

interface ReorderBodyProps {
  habits: Habit[];
  visible: boolean;
  onClose: () => void;
  onSaveOrder: (_habits: Habit[]) => void;
}

const ReorderBody = ({ habits, visible, onClose, onSaveOrder }: ReorderBodyProps) => {
  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  useEffect(() => {
    if (!visible || habits.length === 0) return;
    const sortedHabits = [...habits].sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    );
    setOrderedHabits(updateStartDates(sortedHabits, startDate));
  }, [visible, habits, startDate]);

  const handleDragEnd = ({ data }: { data: Habit[] }) => {
    setOrderedHabits(updateStartDates(data, startDate));
  };

  const handleDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowDatePicker(Platform.OS === 'ios');
    if (selectedDate) {
      setStartDate(selectedDate);
      setOrderedHabits(updateStartDates(orderedHabits, selectedDate));
    }
  };

  const handleSave = () => {
    onSaveOrder(orderedHabits);
    onClose();
  };

  return (
    <View style={styles.reorderModalContent}>
      <View style={styles.modalHeader}>
        <Text style={styles.modalTitle}>Reorder Habits</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>×</Text>
        </TouchableOpacity>
      </View>

      <ReorderDatePicker
        startDate={startDate}
        showDatePicker={showDatePicker}
        setShowDatePicker={setShowDatePicker}
        onDateChange={handleDateChange}
      />

      <Text style={styles.reorderInstructions}>
        Drag habits to reorder. Habits 1-8 start 21 days apart, habits 9-10 start 42 days apart.
      </Text>

      <ReorderList orderedHabits={orderedHabits} onDragEnd={handleDragEnd} />

      <TouchableOpacity style={styles.saveOrderButton} onPress={handleSave}>
        <Text style={styles.saveOrderButtonText}>Save Order</Text>
      </TouchableOpacity>
    </View>
  );
};

export const ReorderHabitsModal = ({
  visible,
  habits,
  onClose,
  onSaveOrder,
}: ReorderHabitsModalProps) => (
  <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.modalOverlay}>
      <ReorderBody habits={habits} visible={visible} onClose={onClose} onSaveOrder={onSaveOrder} />
    </View>
  </Modal>
);

export default ReorderHabitsModal;
