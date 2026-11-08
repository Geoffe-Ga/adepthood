import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { decorativeHidden } from '../../../components/a11yHidden';
import { Button } from '../../../components/Button';
import { parseISODate, toISODate } from '../../../components/DatePicker';
import { useTheme } from '../../../design/ThemeContext';
import { SPACING } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
import { detectDeviceTimezone } from '../../../utils/dateUtils';
import { commitProgramStart } from '../../Program/programAnchor';
import { ProgramStartFixed } from '../../Program/ProgramStartFixed';
import {
  pickerFloor,
  useProgramStartRange,
  type ProgramStartRange,
} from '../../Program/programStartRange';
import { MAX_HABITS } from '../constants';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps } from '../Habits.types';
import {
  carryoverSlot,
  formatStageRange,
  habitColorAtSlot,
  isCarryoverHabit,
  stageAtIndex,
  stageRangeForPage,
} from '../HabitUtils';
import { layProgramRows } from '../services/habitOrdering';

import { REORDER_HABITS_CLOSE_LABEL } from './modalCloseLabels';
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
 * only (``layProgramRows``), so a carryover habit keeps the date it actually
 * began on and the first program habit starts on the picked day.
 *
 * The picker Date represents a device-calendar selection, not an instant, so
 * its day key is read on the device calendar and re-anchored in the account
 * zone; one Date cannot otherwise preserve the same day across unlike
 * device/account offsets.
 */
const updateStartDates = (habits: Habit[], startDate: Date, userTimezone: string): Habit[] =>
  layProgramRows(habits, toISODate(startDate), userTimezone);

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
  const { accent: activeAccent } = useTheme();
  const color = habitColorAtSlot(slot, activeAccent.primary);
  const displayedPosition = slot < 0 ? slot : slot + 1;
  const content = (
    <View style={styles.reorderItemContent}>
      <View style={styles.reorderItemIdentity}>
        <Text style={styles.reorderDragHandle} {...decorativeHidden()}>
          ⠿
        </Text>
        <Text style={styles.reorderPosition}>{displayedPosition}</Text>
        <Text style={styles.reorderItemText}>
          {item.icon} {item.name} ({stageAtIndex(slot)})
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

  // The browser wrapper owns interaction; another button would be nested and misleading.
  if (staticWebRow)
    return (
      <View testID={`reorder-habit-${item.id}`} style={itemStyle}>
        {content}
      </View>
    );

  return (
    <TouchableOpacity
      onLongPress={drag}
      delayLongPress={150}
      disabled={isActive}
      accessibilityRole="button"
      accessibilityLabel={`Move ${item.name}, position ${displayedPosition}`}
      accessibilityHint="Long press and drag to a new position or range"
      testID={`reorder-habit-${item.id}`}
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
  range: ProgramStartRange;
  notice: string | null;
  onOpenPicker: () => void;
  onSelectDate: (_date: Date) => void;
}

const START_DATE_LABEL = 'First Habit Start Date:';

// Web fallback: react-native-modal-datetime-picker is a no-op on web.
const WebDateButton = ({
  startDate,
  range,
  onSelectDate,
}: Pick<ReorderDateButtonProps, 'startDate' | 'range' | 'onSelectDate'>) => (
  <View style={[styles.datePickerButton, { position: 'relative' }]} testID="reorder-start-date">
    <Text style={styles.datePickerButtonText}>{formatDate(startDate)}</Text>
    <input
      aria-label="First habit start date"
      data-testid="reorder-start-date-input"
      type="date"
      value={toISODate(startDate)}
      min={pickerFloor(range, toISODate(startDate))}
      max={range.maxDay}
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

const ReorderDateButton = ({
  startDate,
  range,
  notice,
  onOpenPicker,
  onSelectDate,
}: ReorderDateButtonProps) => {
  if (range.locked) return <ProgramStartFixed label={START_DATE_LABEL} date={startDate} />;
  return (
    <>
      <View style={styles.datePickerContainer}>
        <Text style={styles.datePickerLabel}>{START_DATE_LABEL}</Text>
        {Platform.OS === 'web' ? (
          <WebDateButton startDate={startDate} range={range} onSelectDate={onSelectDate} />
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
      {notice !== null && (
        <Text
          style={styles.habitError}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="reorder-start-date-notice"
        >
          {notice}
        </Text>
      )}
    </>
  );
};

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
  /** What the start-date picker may offer, or that it is fixed (#3097). */
  range: ProgramStartRange;
  /** Why the last picked date did not save, shown beside the picker. */
  notice: string | null;
}

interface ReorderHookInput {
  habits: Habit[];
  visible: boolean;
  userTimezone?: string;
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
/** May the order be sent? Synchronous when there is no start date to send first. */
type StartDateGate = () => boolean | Promise<boolean>;

const useOrderCommit = (
  onSaveOrder: (_habits: Habit[]) => Promise<void>,
  onClose: () => void,
): {
  saving: boolean;
  commit: (_ordered: Habit[], _before: StartDateGate) => Promise<void>;
} => {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const commit = async (ordered: Habit[], before: StartDateGate): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // ``before`` is the start date's own commit. When the server refuses it the
    // modal stays open on the date that still stands, so the person can pick
    // again rather than lose the chance (#3097); nothing of the order is sent.
    // A gate with nothing to send answers synchronously, so the order is sent
    // in the same tick as the press, exactly as it was before the gate existed.
    let proceed = false;
    try {
      const verdict = before();
      proceed = typeof verdict === 'boolean' ? verdict : await verdict;
      if (proceed) await onSaveOrder(ordered);
    } finally {
      savingRef.current = false;
      setSaving(false);
      // Close either way once the order was sent. ``onSaveOrder`` settles rather
      // than failing: a refusal has already alerted and rolled the store back,
      // and the order this modal is still holding is the one that did not take
      // -- staying open would show the person an arrangement the app no longer
      // has.
      if (proceed) onClose();
    }
  };
  return { saving, commit };
};

interface StartDateGateInput {
  startDate: Date;
  userTimezone: string;
  range: ProgramStartRange;
  /** Put the picker and the previewed rows back on the date that still stands. */
  restore: (_prior: Date) => void;
}

/**
 * The start date commits with the order it describes: one explicit act (#3097).
 * The server moves the anchor first, pessimistically; only once it agrees are
 * the re-laid rows sent. A date the person did not pick in this sitting, an
 * unchanged one, or one fixed by begin-again has nothing to send -- a reorder
 * alone must never re-answer the start date with whatever the picker opened on.
 * A refusal or a dropped connection restores the date that still stands and
 * says why, and the rows are not sent.
 */
const useStartDateGate = ({ startDate, userTimezone, range, restore }: StartDateGateInput) => {
  const programStartDay = useProgramStore((s) => s.programStartDay);
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const [notice, setNotice] = useState<string | null>(null);
  // Whether the person picked a date in this sitting; only then is one sent.
  const [picked, setPicked] = useState(false);
  const gate: StartDateGate = () => {
    const day = toISODate(startDate);
    if (!picked || range.locked || day === programStartDay) return true;
    return commitProgramStart(day, { tz: userTimezone }).then((outcome) => {
      if (outcome.kind === 'saved') return true;
      restore(programStartDate ?? new Date());
      setNotice(outcome.message);
      return false;
    });
  };
  /** A new pick: it will be sent, and the last refusal no longer applies. */
  const markPicked = () => {
    setPicked(true);
    setNotice(null);
  };
  /** The sitting is over: nothing picked, nothing to say. */
  const endSitting = () => {
    setPicked(false);
    setNotice(null);
  };
  return { notice, gate, markPicked, endSitting };
};

/**
 * While the modal is closed, put its sitting back: the picker on the held
 * anchor, no pick made, no stale notice. Resetting the picker flag here is what
 * keeps an ``onRequestClose`` dismissal (Android back button) from leaving
 * ``pickerVisible=true`` and springing the picker open on re-render.
 */
const useClosedReset = (visible: boolean, reset: () => void): void => {
  const latest = useRef(reset);
  latest.current = reset;
  const anchor = useProgramStore((s) => s.programStartDate);
  useEffect(() => {
    if (!visible) latest.current();
  }, [visible, anchor]);
};

/** Seed only on the open transition; preserve parent order (sort_order). */
const useOpenSeed = (visible: boolean, habits: Habit[], seed: (_grouped: Habit[]) => void) => {
  const wasVisibleRef = useRef(false);
  const latest = useRef(seed);
  latest.current = seed;
  useEffect(() => {
    const justOpened = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!justOpened || habits.length === 0) return;
    latest.current(groupBySignedRange(habits));
  }, [visible, habits]);
};

/** The rows a drag left behind, whichever shape the list handed back. */
const droppedHabits = (data: Array<Habit | ReorderEntry>): Habit[] =>
  data.some(isReorderEntry) ? habitsFromEntries(data.filter(isReorderEntry)) : (data as Habit[]);

const useReorderState = ({
  habits,
  visible,
  userTimezone = detectDeviceTimezone(),
  onClose,
  onSaveOrder,
}: ReorderHookInput): ReorderState => {
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const range = useProgramStartRange(userTimezone);
  const { saving, commit } = useOrderCommit(onSaveOrder, onClose);
  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState<Date>(() => programStartDate ?? new Date());
  const [pickerVisible, setPickerVisible] = useState(false);
  const restartFrom = (date: Date) => {
    setStartDate(date);
    setOrderedHabits((prev) => updateStartDates(prev, date, userTimezone));
  };
  const { notice, gate, markPicked, endSitting } = useStartDateGate({
    startDate,
    userTimezone,
    range,
    restore: restartFrom,
  });

  useClosedReset(visible, () => {
    if (programStartDate) setStartDate(programStartDate);
    setPickerVisible(false);
    endSitting();
  });

  useOpenSeed(visible, habits, (seed) =>
    setOrderedHabits(updateStartDates(seed, startDate, userTimezone)),
  );

  return {
    orderedHabits,
    startDate,
    pickerVisible,
    setPickerVisible,
    handleDragEnd: ({ data }) =>
      setOrderedHabits(updateStartDates(droppedHabits(data), startDate, userTimezone)),
    // Preview only. The restamped rows live here until Save Order, so writing
    // the global anchor now would let a date the user previewed and then
    // abandoned outlive the modal, with no row on disk agreeing with it.
    handleConfirmDate: (selectedDate) => {
      setPickerVisible(false);
      markPicked();
      restartFrom(selectedDate);
    },
    handleCancelDate: () => setPickerVisible(false),
    saving,
    handleSave: () => commit(orderedHabits, gate),
    range,
    notice,
  };
};

interface ReorderBodyProps {
  onClose: () => void;
  orderedHabits: Habit[];
  startDate: Date;
  range: ProgramStartRange;
  notice: string | null;
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
  range,
  notice,
  onOpenPicker,
  onSelectDate,
  onDragEnd,
  saving,
  onSave,
}: ReorderBodyProps) => (
  <View testID="reorder-modal-card" style={styles.reorderModalContent}>
    <ModalHeader title="Reorder Habits" onClose={onClose} closeLabel={REORDER_HABITS_CLOSE_LABEL} />
    <ReorderDateButton
      startDate={startDate}
      range={range}
      notice={notice}
      onOpenPicker={onOpenPicker}
      onSelectDate={onSelectDate}
    />
    <Text style={styles.reorderInstructions}>
      Drag by the handle to change the order, or drag a habit across one of the lines to move it to
      a different part of your program. Habits 1-8 start 21 days apart; habits 9-10 start 42 days
      apart.
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
  userTimezone,
  onClose,
  onSaveOrder,
}: ReorderHabitsModalProps) => {
  const state = useReorderState({ habits, visible, userTimezone, onClose, onSaveOrder });
  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <View testID="reorder-modal-overlay" style={styles.modalOverlay}>
          <ReorderBody
            onClose={onClose}
            orderedHabits={state.orderedHabits}
            startDate={state.startDate}
            range={state.range}
            notice={state.notice}
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
        // Clamped to what the server accepts (#3097): nothing after today, and
        // back to the server's floor -- or to the date on display, if earlier.
        minimumDate={parseISODate(pickerFloor(state.range, toISODate(state.startDate)))}
        maximumDate={parseISODate(state.range.maxDay)}
        onConfirm={state.handleConfirmDate}
        onCancel={state.handleCancelDate}
      />
    </>
  );
};

export default ReorderHabitsModal;
