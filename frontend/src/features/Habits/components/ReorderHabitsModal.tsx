import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { STAGE_COLORS } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
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

interface ReorderBodyProps {
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
}: ReorderBodyProps): ReorderState => {
  // Seed from the program-wide master date so the picker reflects the
  // user's existing anchor on re-open.  ``programStartDate`` is the
  // single source of truth for "when does the program start" (drives
  // BotMason week, active practice, course unlock, current map stage);
  // updating it here propagates to every consumer.
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const setProgramStartDate = useProgramStore((s) => s.setProgramStartDate);

  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState<Date>(() => programStartDate ?? new Date());
  const [pickerVisible, setPickerVisible] = useState(false);
  const wasVisibleRef = useRef(false);

  // Keep the modal's local startDate aligned with the store while the
  // modal is closed, so re-opening reflects an out-of-band change (e.g.
  // future onboarding flow that also writes the program anchor).
  useEffect(() => {
    if (!visible && programStartDate) setStartDate(programStartDate);
  }, [visible, programStartDate]);

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
      // Master-date write-through: every consumer that derives week/stage
      // from ``programStartDate`` re-renders on the next paint.
      setProgramStartDate(selectedDate);
    },
    handleCancelDate: () => setPickerVisible(false),
    handleSave: () => {
      onSaveOrder(orderedHabits);
      onClose();
    },
  };
};

const ReorderBody = (props: ReorderBodyProps & ReorderState) => (
  <View style={styles.reorderModalContent}>
    <View style={styles.modalHeader}>
      <Text style={styles.modalTitle}>Reorder Habits</Text>
      <TouchableOpacity onPress={props.onClose} style={styles.closeButton}>
        <Text style={styles.closeButtonText}>×</Text>
      </TouchableOpacity>
    </View>
    <ReorderDateButton
      startDate={props.startDate}
      onOpenPicker={() => props.setPickerVisible(true)}
    />
    <Text style={styles.reorderInstructions}>
      Drag habits to reorder. Habits 1-8 start 21 days apart, habits 9-10 start 42 days apart.
    </Text>
    <ReorderList orderedHabits={props.orderedHabits} onDragEnd={props.handleDragEnd} />
    <TouchableOpacity style={styles.saveOrderButton} onPress={props.handleSave}>
      <Text style={styles.saveOrderButtonText}>Save Order</Text>
    </TouchableOpacity>
  </View>
);

/**
 * Mounting the ``DateTimePickerModal`` as a *sibling* of the outer RN
 * ``<Modal>`` -- not as a descendant -- is the load-bearing structural
 * choice that makes the picker actually appear on iOS during habit
 * edit mode.  React Native's ``<Modal>`` on iOS uses a native
 * ``UIViewController`` presentation; any modal mounted inside an
 * already-presented modal animates *underneath* the parent and is
 * invisible to the user (this is the bug the previous fix in PR #299
 * left behind).  By rendering the picker outside the parent modal,
 * ``react-native-modal-datetime-picker``'s own
 * ``presentationStyle: overFullScreen`` modal stacks above everything
 * else and is reachable.
 */
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
        <View style={styles.modalOverlay}>
          <ReorderBody
            habits={habits}
            visible={visible}
            onClose={onClose}
            onSaveOrder={onSaveOrder}
            {...state}
          />
        </View>
      </Modal>
      <DateTimePickerModal
        isVisible={visible && state.pickerVisible}
        mode="date"
        date={state.startDate}
        // Intentionally NO ``minimumDate`` -- the program anchor MUST
        // accept past dates so a user who already started the journey
        // can backdate their start to land on the right week today.
        onConfirm={state.handleConfirmDate}
        onCancel={state.handleCancelDate}
      />
    </>
  );
};

export default ReorderHabitsModal;
