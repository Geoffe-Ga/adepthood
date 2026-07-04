import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { parseISODate, toISODate } from '../../../components/DatePicker';
import { STAGE_COLORS } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import { calculateHabitStartDate, stageAtIndex } from '../HabitUtils';

import ModalHeader from './ModalHeader';

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
  index: number;
  drag: () => void;
  isActive: boolean;
}

const ReorderHabitItem = ({ item, index, drag, isActive }: ReorderItemProps) => {
  const stage = stageAtIndex(index);
  const color = STAGE_COLORS[stage] ?? '#ccc';
  return (
    <TouchableOpacity
      onLongPress={drag}
      disabled={isActive}
      style={[
        styles.reorderItem,
        isActive && styles.reorderItemActive,
        { borderLeftColor: color, borderLeftWidth: 4 },
      ]}
    >
      <View style={styles.reorderItemContent}>
        <Text style={styles.reorderItemText}>
          {item.icon} {item.name} ({stage})
        </Text>
        <Text style={styles.reorderItemDate}>{formatDate(new Date(item.start_date))}</Text>
      </View>
    </TouchableOpacity>
  );
};

interface ReorderDateButtonProps {
  startDate: Date;
  onOpenPicker: () => void;
  onSelectDate: (_date: Date) => void;
}

// Web fallback: react-native-modal-datetime-picker is a no-op on web.
const WebDateButton = ({
  startDate,
  onSelectDate,
}: Pick<ReorderDateButtonProps, 'startDate' | 'onSelectDate'>) => (
  <View style={[styles.datePickerButton, { position: 'relative' }]} testID="reorder-start-date">
    <Text style={styles.datePickerButtonText}>{formatDate(startDate)}</Text>
    <input
      aria-label="First habit start date"
      data-testid="reorder-start-date-input"
      type="date"
      value={toISODate(startDate)}
      onChange={(e) => {
        if (e.target.value) onSelectDate(parseISODate(e.target.value));
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        opacity: 0,
        cursor: 'pointer',
        border: 0,
        padding: 0,
        margin: 0,
      }}
    />
  </View>
);

const ReorderDateButton = ({ startDate, onOpenPicker, onSelectDate }: ReorderDateButtonProps) => (
  <View style={styles.datePickerContainer}>
    <Text style={styles.datePickerLabel}>First Habit Start Date:</Text>
    {Platform.OS === 'web' ? (
      <WebDateButton startDate={startDate} onSelectDate={onSelectDate} />
    ) : (
      <TouchableOpacity
        testID="reorder-start-date"
        style={styles.datePickerButton}
        onPress={onOpenPicker}
      >
        <Text style={styles.datePickerButtonText}>{formatDate(startDate)}</Text>
      </TouchableOpacity>
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
      renderItem={({ item, drag, isActive, getIndex }) => (
        <ReorderHabitItem item={item} index={getIndex() ?? 0} drag={drag} isActive={isActive} />
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

  // Seed only on the open transition; preserve parent order (sort_order).
  useEffect(() => {
    const justOpened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!justOpened || habits.length === 0) return;
    setOrderedHabits(updateStartDates(habits, startDate));
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
  onSelectDate: (_d: Date) => void;
  onDragEnd: (_a: { data: Habit[] }) => void;
  onSave: () => void;
}

const ReorderBody = ({
  onClose,
  orderedHabits,
  startDate,
  onOpenPicker,
  onSelectDate,
  onDragEnd,
  onSave,
}: ReorderBodyProps) => (
  <View style={styles.reorderModalContent}>
    <ModalHeader title="Reorder Habits" onClose={onClose} />
    <ReorderDateButton
      startDate={startDate}
      onOpenPicker={onOpenPicker}
      onSelectDate={onSelectDate}
    />
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
            onSelectDate={state.handleConfirmDate}
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
