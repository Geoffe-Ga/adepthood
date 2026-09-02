import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { Button } from '../../../components/Button';
import { parseISODate, toISODate } from '../../../components/DatePicker';
import { colors, STAGE_COLORS, SPACING } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import {
  calculateHabitStartDate,
  carryoverSlot,
  isCarryoverHabit,
  stageAtIndex,
} from '../HabitUtils';

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

/**
 * Each row's display slot: program habits count 0, 1, 2... along the cadence,
 * while carryover habits take the mirrored negative slots they are given
 * everywhere else in the app (the first one is -1).
 *
 * The list is mixed, and a carryover habit can sort ahead of every program
 * habit, so a raw row index describes neither partition. Both the date a row is
 * stamped with and the stage it is labelled with are read off this one function,
 * which is what stops a row from announcing a stage that contradicts the date
 * printed beside it.
 */
const displaySlots = (habits: Habit[]): number[] => {
  let programIndex = 0;
  let carryoverIndex = 0;
  return habits.map((habit) => {
    if (isCarryoverHabit(habit)) {
      const slot = carryoverSlot(carryoverIndex);
      carryoverIndex += 1;
      return slot;
    }
    const slot = programIndex;
    programIndex += 1;
    return slot;
  });
};

/**
 * Lay the program cadence out from ``startDate`` -- over the program habits
 * only, counted by their own position among program habits.
 *
 * Stamping by raw row index gave the first carryover habit the date the user
 * picked and pushed the real first program habit a whole stage later, which
 * both destroyed the date the carryover habit actually began on and moved the
 * program's own start away from the picked day. A carryover habit's date is
 * history, not a slot on the cadence, so it is left alone.
 */
const updateStartDates = (habits: Habit[], startDate: Date): Habit[] => {
  const slots = displaySlots(habits);
  return habits.map((habit, index) => {
    const slot = slots[index] ?? 0;
    if (slot < 0) return habit;
    return { ...habit, start_date: calculateHabitStartDate(startDate, slot) };
  });
};

interface ReorderItemProps {
  item: Habit;
  slot: number;
  drag: () => void;
  isActive: boolean;
}

const ReorderHabitItem = ({ item, slot, drag, isActive }: ReorderItemProps) => {
  const stage = stageAtIndex(slot);
  const color = STAGE_COLORS[stage] ?? colors.neutral;
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

const ReorderList = ({ orderedHabits, onDragEnd }: ReorderListProps) => {
  const slots = displaySlots(orderedHabits);
  return (
    <View style={styles.reorderList}>
      <DraggableFlatList
        style={{ flex: 1 }}
        data={orderedHabits}
        keyExtractor={(item) => (item.id ? item.id.toString() : item.name)}
        renderItem={({ item, drag, isActive, getIndex }) => (
          <ReorderHabitItem
            item={item}
            slot={slots[getIndex() ?? 0] ?? 0}
            drag={drag}
            isActive={isActive}
          />
        )}
        onDragEnd={onDragEnd}
      />
    </View>
  );
};

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
    // Preview only. The restamped rows live here until Save Order, so writing
    // the global anchor now would let a date the user previewed and then
    // abandoned outlive the modal, with no row on disk agreeing with it.
    handleConfirmDate: (selectedDate) => {
      setPickerVisible(false);
      setStartDate(selectedDate);
      setOrderedHabits((prev) => updateStartDates(prev, selectedDate));
    },
    handleCancelDate: () => setPickerVisible(false),
    handleSave: () => {
      // The anchor commits with the order it describes: one explicit,
      // authoritative act, outranking anything the load-time self-heal would
      // derive from the rows. Splitting the two is what let an abandoned pick
      // strand every other screen on a date no habit agreed with.
      setProgramStartDate(startDate);
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
  <View testID="reorder-modal-card" style={styles.reorderModalContent}>
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
    <Button
      label="Save Order"
      variant="primary"
      onPress={onSave}
      testID="reorder-save-order"
      style={{ marginTop: SPACING.lg, alignSelf: 'stretch' }}
    />
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
