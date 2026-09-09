import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { Button } from '../../../components/Button';
import { parseISODate, toISODate } from '../../../components/DatePicker';
import { colors, STAGE_COLORS, SPACING } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
import { MAX_HABITS } from '../constants';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import {
  calculateHabitStartDate,
  carryoverSlot,
  formatStageRange,
  isCarryoverHabit,
  stageAtIndex,
  stageRangeForPage,
} from '../HabitUtils';
import { displaySlots } from '../services/habitOrdering';

import ModalHeader from './ModalHeader';

const SAVE_ORDER_LABEL = 'Save Order';
const SAVING_LABEL = 'Saving\u2026';

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

const groupBySignedRange = (habits: Habit[]): Habit[] => [
  ...habits.filter(isCarryoverHabit),
  ...habits.filter((habit) => !isCarryoverHabit(habit)),
];

interface ReorderItemProps {
  item: Habit;
  slot: number;
  drag: () => void;
  isActive: boolean;
  staticWebRow?: boolean;
}

const ReorderHabitItem = ({
  item,
  slot,
  drag,
  isActive,
  staticWebRow = false,
}: ReorderItemProps) => {
  const stage = stageAtIndex(slot);
  const color = STAGE_COLORS[stage] ?? colors.neutral;
  const displayedPosition = slot < 0 ? slot : slot + 1;
  const content = (
    <View style={styles.reorderItemContent}>
      <View style={styles.reorderItemIdentity}>
        <Text style={styles.reorderDragHandle} accessibilityElementsHidden>
          ⠿
        </Text>
        <Text style={styles.reorderPosition}>{displayedPosition}</Text>
        <Text style={styles.reorderItemText}>
          {item.icon} {item.name} ({stage})
        </Text>
      </View>
      <Text style={styles.reorderItemDate}>{formatDate(new Date(item.start_date))}</Text>
    </View>
  );
  const itemStyle = [
    styles.reorderItem,
    isActive && styles.reorderItemActive,
    { borderLeftColor: color, borderLeftWidth: 4 },
  ];

  // The browser wrapper owns pointer, native drag, and keyboard interaction.
  // Rendering another button inside it would announce a misleading long-press
  // action and create nested interactive controls for assistive technology.
  if (staticWebRow) return <View style={itemStyle}>{content}</View>;

  return (
    <TouchableOpacity
      onLongPress={drag}
      delayLongPress={150}
      disabled={isActive}
      accessibilityRole="button"
      accessibilityLabel={`Move ${item.name}, position ${displayedPosition}`}
      accessibilityHint="Long press and drag to a new position or range"
      style={itemStyle}
    >
      {content}
    </TouchableOpacity>
  );
};

interface ReorderPageEntry {
  kind: 'page';
  key: string;
  page: number;
  isProgramStart: boolean;
}

interface ReorderHabitEntry {
  kind: 'habit';
  key: string;
  habit: Habit;
  slot: number;
}

type ReorderEntry = ReorderPageEntry | ReorderHabitEntry;

const pageEntry = (page: number, isProgramStart = false): ReorderPageEntry => ({
  kind: 'page',
  key: `page:${page}`,
  page,
  isProgramStart,
});

const habitEntry = (habit: Habit, slot: number): ReorderHabitEntry => ({
  kind: 'habit',
  key: `habit:${habit.id}`,
  habit,
  slot,
});

/**
 * Materialize the same signed ranges as the Habits screen inside one scrollable
 * drag surface. Empty invite ranges are intentional drop targets: the first
 * negative range always exists, and a full positive lap exposes the next one.
 */
const buildReorderEntries = (habits: Habit[]): ReorderEntry[] => {
  const carryover = habits.filter(isCarryoverHabit);
  const program = habits.filter((habit) => !isCarryoverHabit(habit));
  const entries: ReorderEntry[] = [pageEntry(-1)];

  carryover.forEach((habit, index) => {
    if (index > 0 && index % MAX_HABITS === 0) {
      entries.push(pageEntry(-(index / MAX_HABITS + 1)));
    }
    entries.push(habitEntry(habit, carryoverSlot(index)));
  });
  if (carryover.length > 0 && carryover.length % MAX_HABITS === 0) {
    entries.push(pageEntry(-(carryover.length / MAX_HABITS + 1)));
  }

  entries.push(pageEntry(0, true));
  program.forEach((habit, index) => {
    if (index > 0 && index % MAX_HABITS === 0) {
      entries.push(pageEntry(index / MAX_HABITS));
    }
    entries.push(habitEntry(habit, index));
  });
  if (program.length > 0 && program.length % MAX_HABITS === 0) {
    entries.push(pageEntry(program.length / MAX_HABITS));
  }
  return entries;
};

const habitsFromEntries = (entries: ReorderEntry[]): Habit[] => {
  let isCarryover = true;
  const habits: Habit[] = [];
  entries.forEach((entry) => {
    if (entry.kind === 'page') {
      if (entry.isProgramStart) isCarryover = false;
      return;
    }
    habits.push({ ...entry.habit, is_carryover: isCarryover });
  });
  return habits;
};

const isReorderEntry = (value: Habit | ReorderEntry): value is ReorderEntry =>
  'kind' in value && (value.kind === 'page' || value.kind === 'habit');

const ReorderPageMarker = ({ page }: { page: number }) => {
  const range = stageRangeForPage(page, MAX_HABITS);
  const rangeText = formatStageRange(range.start, range.end);
  const title = page < 0 ? 'Before your program' : page === 0 ? 'Your program' : 'Next lap';
  return (
    <View style={styles.reorderPageMarker} accessibilityRole="header">
      <Text style={styles.reorderPageMarkerTitle}>
        {title} · {rangeText}
      </Text>
      <Text style={styles.reorderPageMarkerHint}>Drop a habit below this line.</Text>
    </View>
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
  onDragEnd: (_data: { data: Array<Habit | ReorderEntry> }) => void;
}

interface WebReorderListProps {
  entries: ReorderEntry[];
  onDragEnd: ReorderListProps['onDragEnd'];
}

interface WebReorderEntryProps {
  entry: ReorderEntry;
  index: number;
  isDragged: boolean;
  onPointerStart: (_entry: ReorderHabitEntry) => void;
  onDragStart: (_entry: ReorderHabitEntry, _event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onPointerDrop: (_index: number) => void;
  onNativeDrop: (_index: number, _event: React.DragEvent<HTMLDivElement>) => void;
  onMove: (_entry: ReorderHabitEntry, _index: number, _direction: -1 | 1) => void;
}

const WEB_AUTOSCROLL_EDGE = 72;
const WEB_AUTOSCROLL_STEP = 24;

const scrollDuringWebDrag = (event: React.DragEvent<HTMLDivElement>) => {
  event.preventDefault();
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientY < bounds.top + WEB_AUTOSCROLL_EDGE) {
    event.currentTarget.scrollTop -= WEB_AUTOSCROLL_STEP;
  } else if (event.clientY > bounds.bottom - WEB_AUTOSCROLL_EDGE) {
    event.currentTarget.scrollTop += WEB_AUTOSCROLL_STEP;
  }
};

const webEntryAriaLabel = (entry: ReorderEntry): string => {
  if (entry.kind === 'habit') {
    const position = entry.slot < 0 ? entry.slot : entry.slot + 1;
    return `Move ${entry.habit.name}, position ${position}. Use Arrow Up or Arrow Down, or drag to a range.`;
  }
  const range = stageRangeForPage(entry.page, MAX_HABITS);
  return `Drop in ${formatStageRange(range.start, range.end)}`;
};

const WebReorderEntry = ({
  entry,
  index,
  isDragged,
  onPointerStart,
  onDragStart,
  onDragEnd,
  onPointerDrop,
  onNativeDrop,
  onMove,
}: WebReorderEntryProps) => (
  <div
    draggable={entry.kind === 'habit'}
    role={entry.kind === 'habit' ? 'listitem' : 'separator'}
    tabIndex={entry.kind === 'habit' ? 0 : undefined}
    aria-keyshortcuts={entry.kind === 'habit' ? 'ArrowUp ArrowDown' : undefined}
    aria-label={webEntryAriaLabel(entry)}
    data-range-page={entry.kind === 'page' ? entry.page : undefined}
    onPointerDown={() => entry.kind === 'habit' && onPointerStart(entry)}
    onPointerUp={() => onPointerDrop(index)}
    onKeyDown={(event) => {
      if (entry.kind !== 'habit' || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      onMove(entry, index, event.key === 'ArrowUp' ? -1 : 1);
    }}
    onDragStart={(event) => entry.kind === 'habit' && onDragStart(entry, event)}
    onDragEnd={onDragEnd}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => {
      event.preventDefault();
      onNativeDrop(index, event);
    }}
    style={{ cursor: entry.kind === 'habit' ? 'grab' : 'default', opacity: isDragged ? 0.55 : 1 }}
  >
    {entry.kind === 'page' ? (
      <ReorderPageMarker page={entry.page} />
    ) : (
      <ReorderHabitItem
        item={entry.habit}
        slot={entry.slot}
        drag={() => {}}
        isActive={false}
        staticWebRow
      />
    )}
  </div>
);

const reorderEntry = (
  entries: ReorderEntry[],
  key: string,
  targetIndex: number,
): ReorderEntry[] | null => {
  const sourceIndex = entries.findIndex((entry) => entry.key === key);
  if (sourceIndex < 0 || sourceIndex === targetIndex) return null;
  const reordered = [...entries];
  const [moving] = reordered.splice(sourceIndex, 1);
  if (!moving || moving.kind !== 'habit') return null;
  reordered.splice(Math.max(0, Math.min(targetIndex, reordered.length)), 0, moving);
  return reordered;
};

const useWebReorderDrag = (entries: ReorderEntry[], onDragEnd: ReorderListProps['onDragEnd']) => {
  const draggedKeyRef = useRef<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const cancelDrag = () => {
    draggedKeyRef.current = null;
    setDraggedKey(null);
  };
  useEffect(() => {
    if (typeof window.addEventListener !== 'function') return undefined;
    const cancel = () => {
      draggedKeyRef.current = null;
      setDraggedKey(null);
    };
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointerup', cancel);
    return () => {
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerup', cancel);
    };
  }, []);
  const moveKeyTo = (key: string, targetIndex: number) => {
    const reordered = reorderEntry(entries, key, targetIndex);
    if (!reordered) return;
    cancelDrag();
    onDragEnd({ data: reordered });
  };
  const startPointer = (habit: ReorderHabitEntry) => {
    draggedKeyRef.current = habit.key;
    setDraggedKey(habit.key);
  };
  return { draggedKey, draggedKeyRef, cancelDrag, moveKeyTo, startPointer };
};

/** Browser-native drag events keep web usable even when the gesture-handler
 * long-press recognizer is unavailable. The surrounding list remains the one
 * scroll container, so dragging to either edge can reach every signed range. */
const WebReorderList = ({ entries, onDragEnd }: WebReorderListProps) => {
  const { draggedKey, draggedKeyRef, cancelDrag, moveKeyTo, startPointer } = useWebReorderDrag(
    entries,
    onDragEnd,
  );

  const pointerDropAt = (targetIndex: number) => {
    const key = draggedKeyRef.current;
    if (key) moveKeyTo(key, targetIndex);
  };

  const nativeDropAt = (targetIndex: number, event: React.DragEvent<HTMLDivElement>) => {
    // Chromium emits pointerup before drop. The global pointer cleanup has
    // therefore already cleared the transient ref by the time a real HTML DnD
    // drop arrives. The transfer payload is the browser-owned source of truth
    // for native drag events and survives that lifecycle boundary.
    const key = event.dataTransfer.getData('text/plain') || draggedKeyRef.current;
    if (key) moveKeyTo(key, targetIndex);
  };

  return (
    <div
      data-testid="reorder-list"
      role="list"
      onPointerUp={cancelDrag}
      onPointerCancel={cancelDrag}
      onDragOver={(event) => draggedKeyRef.current && scrollDuringWebDrag(event)}
      style={{ height: '100%', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
    >
      {entries.map((entry, index) => (
        <WebReorderEntry
          key={entry.key}
          entry={entry}
          index={index}
          isDragged={draggedKey === entry.key}
          onPointerStart={startPointer}
          onDragStart={(habit, event) => {
            startPointer(habit);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', habit.key);
          }}
          onDragEnd={cancelDrag}
          onPointerDrop={pointerDropAt}
          onNativeDrop={nativeDropAt}
          onMove={(habit, sourceIndex, direction) => moveKeyTo(habit.key, sourceIndex + direction)}
        />
      ))}
    </div>
  );
};

const ReorderList = ({ orderedHabits, onDragEnd }: ReorderListProps) => {
  const entries = buildReorderEntries(orderedHabits);
  return (
    <View style={styles.reorderList}>
      {Platform.OS === 'web' ? (
        <WebReorderList entries={entries} onDragEnd={onDragEnd} />
      ) : (
        <DraggableFlatList
          testID="reorder-list"
          style={{ flex: 1, minHeight: 0 }}
          data={entries}
          keyExtractor={(entry) => entry.key}
          renderItem={({ item, drag, isActive }) =>
            item.kind === 'page' ? (
              <ReorderPageMarker page={item.page} />
            ) : (
              <ReorderHabitItem
                item={item.habit}
                slot={item.slot}
                drag={drag}
                isActive={isActive}
              />
            )
          }
          autoscrollThreshold={72}
          autoscrollSpeed={160}
          onDragEnd={onDragEnd}
        />
      )}
    </View>
  );
};

interface ReorderState {
  orderedHabits: Habit[];
  startDate: Date;
  pickerVisible: boolean;
  setPickerVisible: (_v: boolean) => void;
  handleDragEnd: ReorderListProps['onDragEnd'];
  handleConfirmDate: (_d: Date) => void;
  handleCancelDate: () => void;
  /** True while the commit is on the wire; drives the busy control. */
  saving: boolean;
  handleSave: () => Promise<void>;
}

interface ReorderHookInput {
  habits: Habit[];
  visible: boolean;
  onClose: () => void;
  onSaveOrder: (_habits: Habit[]) => Promise<void>;
}

/**
 * The commit half of the modal: run the save, hold the affordance for its
 * whole length, and dismiss only once it has settled.
 *
 * ONE COMMIT AT A TIME, and the control says so, rather than the outstanding-act
 * tally the journal fold-in took (#2753). There the concurrency was legitimate:
 * a writer folding several distinct quotes in succession means each one, so a
 * shared boolean would have been lowered by whichever finished first. Save Order
 * is not that shape. It commits the WHOLE list in one act, so a second press
 * during the first cannot mean anything new -- it would re-PUT identical rows --
 * and it would be actively wrong: the rollback snapshot is taken from the store
 * as it stands, which by then already holds the optimistic order, so a later
 * refusal would "restore" the very arrangement that failed.
 *
 * The ref is the guard and the flag is its visible half: ``busy`` already makes
 * the control inert, but two presses inside one tick would both pass a state
 * check before the re-render, which the ref settles synchronously. Mirrors
 * ``CopyToStageDialog``, whose confirm is inert while busy for the same reason.
 */
const useOrderCommit = (
  onSaveOrder: (_habits: Habit[]) => Promise<void>,
  onClose: () => void,
): { saving: boolean; commit: (_ordered: Habit[]) => Promise<void> } => {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const commit = async (ordered: Habit[]): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSaveOrder(ordered);
    } finally {
      savingRef.current = false;
      setSaving(false);
      // Close either way. ``onSaveOrder`` settles rather than failing: a refusal
      // has already alerted and rolled the store back, and the order this modal
      // is still holding is the one that did not take -- staying open would show
      // the person an arrangement the app no longer has.
      onClose();
    }
  };
  return { saving, commit };
};

const useReorderState = ({
  habits,
  visible,
  onClose,
  onSaveOrder,
}: ReorderHookInput): ReorderState => {
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const setProgramStartDate = useProgramStore((s) => s.setProgramStartDate);

  const { saving, commit } = useOrderCommit(onSaveOrder, onClose);
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
    setOrderedHabits(updateStartDates(groupBySignedRange(habits), startDate));
  }, [visible, habits, startDate]);

  return {
    orderedHabits,
    startDate,
    pickerVisible,
    setPickerVisible,
    handleDragEnd: ({ data }) => {
      const nextHabits = data.some(isReorderEntry)
        ? habitsFromEntries(data.filter(isReorderEntry))
        : (data as Habit[]);
      setOrderedHabits(updateStartDates(nextHabits, startDate));
    },
    // Preview only. The restamped rows live here until Save Order, so writing
    // the global anchor now would let a date the user previewed and then
    // abandoned outlive the modal, with no row on disk agreeing with it.
    handleConfirmDate: (selectedDate) => {
      setPickerVisible(false);
      setStartDate(selectedDate);
      setOrderedHabits((prev) => updateStartDates(prev, selectedDate));
    },
    handleCancelDate: () => setPickerVisible(false),
    saving,
    handleSave: () => {
      // The anchor commits with the order it describes: one explicit,
      // authoritative act, outranking anything the load-time self-heal would
      // derive from the rows. Splitting the two is what let an abandoned pick
      // strand every other screen on a date no habit agreed with.
      setProgramStartDate(startDate);
      return commit(orderedHabits);
    },
  };
};

interface ReorderBodyProps {
  onClose: () => void;
  orderedHabits: Habit[];
  startDate: Date;
  onOpenPicker: () => void;
  onSelectDate: (_d: Date) => void;
  onDragEnd: ReorderListProps['onDragEnd'];
  saving: boolean;
  onSave: () => void;
}

const ReorderBody = ({
  onClose,
  orderedHabits,
  startDate,
  onOpenPicker,
  onSelectDate,
  onDragEnd,
  saving,
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
      Drag by the handle to reorder or cross a range line. Habits 1-8 start 21 days apart; habits
      9-10 start 42 days apart.
    </Text>
    <ReorderList orderedHabits={orderedHabits} onDragEnd={onDragEnd} />
    <Button
      // Label AND accessible name (``Button`` derives one from the other), so
      // the outstanding write is announced rather than only styled; ``busy``
      // carries the state and makes the control inert for its length.
      label={saving ? SAVING_LABEL : SAVE_ORDER_LABEL}
      variant="primary"
      busy={saving}
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
            saving={state.saving}
            onSave={() => {
              // ``handleSave`` settles in a ``finally``, so a rejecting
              // ``onSaveOrder`` still lowers the busy state and closes; this
              // guard only keeps that rejection from surfacing as an unhandled
              // promise, since the caller owns reporting it.
              void state.handleSave().catch(() => undefined);
            }}
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
