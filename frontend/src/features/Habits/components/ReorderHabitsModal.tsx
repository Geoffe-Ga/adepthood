import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { STAGE_COLORS } from '../../../design/tokens';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import { STAGE_ORDER, calculateHabitStartDate } from '../HabitUtils';

// ``react-native-modal-datetime-picker`` ships as ES modules and isn't in the
// jest ``transformIgnorePatterns`` allowlist. Mirror the lazy-require pattern
// from ``src/components/DatePicker.tsx`` so screen tests that transitively
// import this modal don't blow up at module-load time, while production still
// gets the real picker with confirm/cancel affordances (fixes the iOS
// app-seize bug where the previous ``<Modal><DateTimePicker/></Modal>`` had
// no way to be dismissed).
let DateTimePickerModal: ComponentType<Record<string, unknown>> = () => null;
if (Platform.OS !== 'web') {
  try {
    DateTimePickerModal = require('react-native-modal-datetime-picker').default;
  } catch {
    DateTimePickerModal = () => null;
  }
}

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
  pickerVisible: boolean;
  onOpenPicker: () => void;
  onConfirm: (_date: Date) => void;
  onCancel: () => void;
}

const ReorderDatePicker = ({
  startDate,
  pickerVisible,
  onOpenPicker,
  onConfirm,
  onCancel,
}: ReorderDatePickerProps) => (
  <View style={styles.datePickerContainer}>
    <Text style={styles.datePickerLabel}>First Habit Start Date:</Text>
    <TouchableOpacity
      testID="reorder-start-date"
      style={styles.datePickerButton}
      onPress={onOpenPicker}
    >
      <Text style={styles.datePickerButtonText}>{formatDate(startDate)}</Text>
    </TouchableOpacity>
    <DateTimePickerModal
      isVisible={pickerVisible}
      mode="date"
      date={startDate}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
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

interface ReorderState {
  orderedHabits: Habit[];
  startDate: Date;
  pickerVisible: boolean;
  setPickerVisible: (_v: boolean) => void;
  handleDragEnd: (_a: { data: Habit[] }) => void;
  handleConfirmDate: (_d: Date) => void;
  handleCancelDate: () => void;
  handleSave: () => void;
}

const useReorderState = ({
  habits,
  visible,
  onClose,
  onSaveOrder,
}: ReorderBodyProps): ReorderState => {
  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState(new Date());
  const [pickerVisible, setPickerVisible] = useState(false);
  const wasVisibleRef = useRef(false);

  // BUG-FE-HABIT-204: initialise the ordering only on the open transition;
  // the previous implementation re-fired on every ``startDate`` change and
  // clobbered the user's drag.  Date-picker changes go through
  // ``handleConfirmDate`` below, which calls ``updateStartDates`` directly,
  // so the start-date propagation handled by PR #302's dedicated effect is
  // already covered here without a second effect.
  useEffect(() => {
    const justOpened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!justOpened || habits.length === 0) return;
    const sortedHabits = [...habits].sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    );
    setOrderedHabits(updateStartDates(sortedHabits, startDate));
  }, [visible, habits, startDate]);

  return {
    orderedHabits,
    startDate,
    pickerVisible,
    setPickerVisible,
    handleDragEnd: ({ data }) => setOrderedHabits(updateStartDates(data, startDate)),
    handleConfirmDate: (selectedDate) => {
      setPickerVisible(false);
      setStartDate(selectedDate);
      setOrderedHabits((prev) => updateStartDates(prev, selectedDate));
    },
    handleCancelDate: () => setPickerVisible(false),
    handleSave: () => {
      onSaveOrder(orderedHabits);
      onClose();
    },
  };
};

const ReorderBody = (props: ReorderBodyProps) => {
  const s = useReorderState(props);
  return (
    <View style={styles.reorderModalContent}>
      <View style={styles.modalHeader}>
        <Text style={styles.modalTitle}>Reorder Habits</Text>
        <TouchableOpacity onPress={props.onClose} style={styles.closeButton}>
          <Text style={styles.closeButtonText}>×</Text>
        </TouchableOpacity>
      </View>
      <ReorderDatePicker
        startDate={s.startDate}
        pickerVisible={s.pickerVisible}
        onOpenPicker={() => s.setPickerVisible(true)}
        onConfirm={s.handleConfirmDate}
        onCancel={s.handleCancelDate}
      />
      <Text style={styles.reorderInstructions}>
        Drag habits to reorder. Habits 1-8 start 21 days apart, habits 9-10 start 42 days apart.
      </Text>
      <ReorderList orderedHabits={s.orderedHabits} onDragEnd={s.handleDragEnd} />
      <TouchableOpacity style={styles.saveOrderButton} onPress={s.handleSave}>
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
