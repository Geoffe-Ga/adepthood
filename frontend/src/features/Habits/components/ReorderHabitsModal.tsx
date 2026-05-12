import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { STAGE_COLORS } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import { STAGE_ORDER, calculateHabitStartDate } from '../HabitUtils';

// Lazy require so jest (which doesn't transform this ES-module package) can load this file.
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

interface ReorderDateButtonProps {
  startDate: Date;
  onOpenPicker: () => void;
}

const ReorderDateButton = ({ startDate, onOpenPicker }: ReorderDateButtonProps) => (
  <View style={styles.datePickerContainer}>
    <Text style={styles.datePickerLabel}>First Habit Start Date:</Text>
    <TouchableOpacity
      testID="reorder-start-date"
      style={styles.datePickerButton}
      onPress={onOpenPicker}
    >
      <Text style={styles.datePickerButtonText}>{formatDate(startDate)}</Text>
    </TouchableOpacity>
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

interface ReorderHookInput {
  habits: Habit[];
  visible: boolean;
  onClose: () => void;
  onSaveOrder: (_habits: Habit[]) => void;
}

const useReorderState = ({
  habits,
  visible,
  onClose,
  onSaveOrder,
}: ReorderHookInput): ReorderState => {
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const setProgramStartDate = useProgramStore((s) => s.setProgramStartDate);

  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState<Date>(() => programStartDate ?? new Date());
  const [pickerVisible, setPickerVisible] = useState(false);
  const wasVisibleRef = useRef(false);

  useEffect(() => {
    if (!visible && programStartDate) setStartDate(programStartDate);
  }, [visible, programStartDate]);

  // Reset the picker flag when the parent modal closes so that an
  // ``onRequestClose`` dismissal (Android back button) doesn't leave
  // ``pickerVisible=true`` and spring the picker open on re-render.
  useEffect(() => {
    if (!visible) setPickerVisible(false);
  }, [visible]);

  // BUG-FE-HABIT-204: only seed the ordered list on the open transition;
  // re-firing on every startDate change clobbered manual drags.
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
      // Master-date write-through: every consumer that derives week/stage updates.
      setProgramStartDate(selectedDate);
    },
    handleCancelDate: () => setPickerVisible(false),
    handleSave: () => {
      onSaveOrder(orderedHabits);
      onClose();
    },
  };
};

interface ReorderBodyProps {
  onClose: () => void;
  orderedHabits: Habit[];
  startDate: Date;
  onOpenPicker: () => void;
  onDragEnd: (_a: { data: Habit[] }) => void;
  onSave: () => void;
}

const ReorderBody = ({
  onClose,
  orderedHabits,
  startDate,
  onOpenPicker,
  onDragEnd,
  onSave,
}: ReorderBodyProps) => (
  <View style={styles.reorderModalContent}>
    <View style={styles.modalHeader}>
      <Text style={styles.modalTitle}>Reorder Habits</Text>
      <TouchableOpacity onPress={onClose} style={styles.closeButton}>
        <Text style={styles.closeButtonText}>×</Text>
      </TouchableOpacity>
    </View>
    <ReorderDateButton startDate={startDate} onOpenPicker={onOpenPicker} />
    <Text style={styles.reorderInstructions}>
      Drag habits to reorder. Habits 1-8 start 21 days apart, habits 9-10 start 42 days apart.
    </Text>
    <ReorderList orderedHabits={orderedHabits} onDragEnd={onDragEnd} />
    <TouchableOpacity style={styles.saveOrderButton} onPress={onSave}>
      <Text style={styles.saveOrderButtonText}>Save Order</Text>
    </TouchableOpacity>
  </View>
);

// Mount the picker as a SIBLING of the parent <Modal>: iOS animates nested UIViewController modals underneath the parent, hiding them.
export const ReorderHabitsModal = ({
  visible,
  habits,
  onClose,
  onSaveOrder,
}: ReorderHabitsModalProps) => {
  const state = useReorderState({ habits, visible, onClose, onSaveOrder });
  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <View testID="reorder-modal-overlay" style={styles.modalOverlay}>
          <ReorderBody
            onClose={onClose}
            orderedHabits={state.orderedHabits}
            startDate={state.startDate}
            onOpenPicker={() => state.setPickerVisible(true)}
            onDragEnd={state.handleDragEnd}
            onSave={state.handleSave}
          />
        </View>
      </Modal>
      <DateTimePickerModal
        isVisible={visible && state.pickerVisible}
        mode="date"
        date={state.startDate}
        // No ``minimumDate``: the master anchor must accept past dates.
        onConfirm={state.handleConfirmDate}
        onCancel={state.handleCancelDate}
      />
    </>
  );
};

export default ReorderHabitsModal;
