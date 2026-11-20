import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Modal, Platform, Text, TouchableOpacity, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';

import { decorativeHidden } from '../../../components/a11yHidden';
import { Button } from '../../../components/Button';
import { parseISODate, toISODate } from '../../../components/DatePicker';
import { useTheme } from '../../../design/ThemeContext';
import { SPACING } from '../../../design/tokens';
import { useProgramStore } from '../../../store/useProgramStore';
import { dayKeyInTZ, detectDeviceTimezone } from '../../../utils/dateUtils';
import { commitProgramStart } from '../../Program/programAnchor';
import { PROGRAM_START_FIXED_COPY, ProgramStartFixed } from '../../Program/ProgramStartFixed';
import {
  pickerFloor,
  useProgramStartRange,
  type ProgramStartRange,
} from '../../Program/programStartRange';
import { usePendingPassPick, type PendingPassPick } from '../../Program/usePendingPassPick';
import { MAX_HABITS } from '../constants';
import styles from '../Habits.styles';
import type { Habit, ReorderHabitsModalProps, SaveHabitOrder } from '../Habits.types';
import {
  carryoverSlot,
  formatStageRange,
  habitColorAtSlot,
  isCarryoverHabit,
  stageAtIndex,
  stageRangeForPage,
} from '../HabitUtils';
import { HABIT_ROWS_NOT_MOVED_COPY, PASS_HABITS_NOT_MOVED_COPY } from '../services/habitManager';
import { isRecalculated, layProgramRows, recalculatePassRows } from '../services/habitOrdering';

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

/**
 * The first day the program rows already hold, as a device-calendar Date like
 * the picker's, or null when no program row is held. Carryover rows and demo
 * tiles carry no program date, so they are skipped.
 */
const heldRowsStart = (habits: readonly Habit[], tz: string): Date | null => {
  const times = habits
    .filter((habit) => !isCarryoverHabit(habit) && habit.isDemoSeed !== true)
    .map((habit) => new Date(habit.start_date).getTime())
    .filter((time) => !Number.isNaN(time));
  if (times.length === 0) return null;
  return parseISODate(dayKeyInTZ(new Date(Math.min(...times)), tz));
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
 * The carryover side of the list, in time order: the deepest range first and
 * -1 last, so it sits directly above the program and the whole surface reads
 * as one line from the furthest past to the next lap.
 *
 * The store keeps carryover nearest-first (index 0 is -1), so each range is
 * walked from its deepest filled slot back towards the program. A range's
 * marker leads its rows, and a completely full deepest range earns one more
 * empty marker above it -- with no carryover at all that is the single -1
 * range, which is why the first negative range always exists as a drop target.
 */
const buildCarryoverEntries = (carryover: readonly Habit[]): ReorderEntry[] => {
  const contentPages = Math.ceil(carryover.length / MAX_HABITS);
  const entries: ReorderEntry[] = [];
  if (carryover.length % MAX_HABITS === 0) entries.push(pageEntry(-(contentPages + 1)));
  for (let page = contentPages; page >= 1; page -= 1) {
    entries.push(pageEntry(-page));
    const deepest = Math.min(carryover.length, page * MAX_HABITS) - 1;
    for (let index = deepest; index >= (page - 1) * MAX_HABITS; index -= 1) {
      const habit = carryover[index];
      if (habit !== undefined) entries.push(habitEntry(habit, carryoverSlot(index)));
    }
  }
  return entries;
};

/**
 * Materialize the same signed ranges as the Habits screen inside one scrollable
 * drag surface. Empty invite ranges are intentional drop targets: the first
 * negative range always exists, and a full positive lap exposes the next one.
 */
const buildReorderEntries = (habits: Habit[]): ReorderEntry[] => {
  const program = habits.filter((habit) => !isCarryoverHabit(habit));
  const entries: ReorderEntry[] = buildCarryoverEntries(habits.filter(isCarryoverHabit));

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

/**
 * Read a dragged list back into store order. Rows above the program marker are
 * carryover and are displayed deepest-first, so they are reversed back to the
 * nearest-first order the store and ``sort_order`` keep.
 */
const habitsFromEntries = (entries: ReorderEntry[]): Habit[] => {
  let isCarryover = true;
  const carryover: Habit[] = [];
  const program: Habit[] = [];
  entries.forEach((entry) => {
    if (entry.kind === 'page') {
      if (entry.isProgramStart) isCarryover = false;
      return;
    }
    (isCarryover ? carryover : program).push({ ...entry.habit, is_carryover: isCarryover });
  });
  return [...carryover.reverse(), ...program];
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
  /** The pending next pass, whose day is offered instead of a correction (#3747). */
  pass: PendingPassPick;
  notice: string | null;
  /** Whether a program habit keeps its own date while the pass is pending (#3762). */
  keptHabits: boolean;
  onOpenPicker: () => void;
  onSelectDate: (_date: Date) => void;
  onSelectPassDate: (_date: Date) => void;
}

const START_DATE_LABEL = 'First Habit Start Date:';
const PASS_DATE_LABEL = 'Next Pass Begins:';
/**
 * While a pass is pending, an unlocked habit keeps its own start date (#3762):
 * only the locked habits waiting for the pass cascade from its day. Said once,
 * when there is such a habit, since its row then shows a date of its own.
 */
export const KEPT_HABITS_COPY = "Habits you've already begun keep their own start dates.";

/** Whether ``habits`` holds a program habit that keeps its own date (#3762). */
const holdsKeptHabit = (habits: readonly Habit[]): boolean =>
  habits.some(
    (habit) => !isCarryoverHabit(habit) && habit.isDemoSeed !== true && !isRecalculated(habit),
  );

interface WebDateButtonProps {
  date: Date;
  range: Pick<ProgramStartRange, 'minDay' | 'maxDay'>;
  /** ``reorder-start-date`` or ``reorder-pass-date``; the input adds ``-input``. */
  testID: string;
  ariaLabel: string;
  onSelectDate: (_date: Date) => void;
}

// Web fallback: react-native-modal-datetime-picker is a no-op on web.
const WebDateButton = ({ date, range, testID, ariaLabel, onSelectDate }: WebDateButtonProps) => (
  <View style={[styles.datePickerButton, { position: 'relative' }]} testID={testID}>
    <Text style={styles.datePickerButtonText}>{formatDate(date)}</Text>
    <input
      aria-label={ariaLabel}
      data-testid={`${testID}-input`}
      type="date"
      value={toISODate(date)}
      min={pickerFloor(range, toISODate(date))}
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

type DateRowProps = Omit<WebDateButtonProps, 'onSelectDate'> & {
  label: string;
  rowStyle?: StyleProp<ViewStyle>;
  onOpenPicker: () => void;
  onSelectDate: (_date: Date) => void;
};

/** A labelled date control: a date input on web, a button opening the picker elsewhere. */
const DateRow = ({ label, rowStyle, onOpenPicker, ...button }: DateRowProps) => (
  <View style={[styles.datePickerContainer, rowStyle]}>
    <Text style={styles.datePickerLabel}>{label}</Text>
    {Platform.OS === 'web' ? (
      <WebDateButton {...button} />
    ) : (
      <TouchableOpacity
        testID={button.testID}
        style={styles.datePickerButton}
        onPress={onOpenPicker}
        accessibilityRole="button"
        accessibilityLabel={button.ariaLabel}
      >
        <Text style={styles.datePickerButtonText}>{formatDate(button.date)}</Text>
      </TouchableOpacity>
    )}
  </View>
);

const DateNotice = ({ notice }: { notice: string | null }) =>
  notice === null ? null : (
    <Text
      style={styles.habitError}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="reorder-start-date-notice"
    >
      {notice}
    </Text>
  );

/**
 * While a next pass is pending (#3747): the pending day, offered in the pass
 * window with what saving it will do said beforehand. The running start is not
 * offered -- a correction would drop the pending pass -- and, since kept habits
 * hold their own dates, no "first habit" date is shown either (#3762): the
 * waiting habits cascade from the day picked here, and each row shows its own.
 */
const PendingPassDate = ({
  range,
  pass,
  notice,
  keptHabits,
  onOpenPicker,
  onSelectPassDate,
}: Omit<ReorderDateButtonProps, 'onSelectDate' | 'startDate'>) => (
  <>
    {range.locked && <Text style={styles.onboardingSubtitle}>{PROGRAM_START_FIXED_COPY}</Text>}
    <DateRow
      label={PASS_DATE_LABEL}
      rowStyle={styles.reorderPassRow}
      date={parseISODate(pass.day)}
      range={pass.range}
      testID="reorder-pass-date"
      ariaLabel="Next pass start date"
      onOpenPicker={onOpenPicker}
      onSelectDate={onSelectPassDate}
    />
    <Text style={styles.reorderPassSentence} testID="reorder-pass-sentence">
      {pass.sentence}
    </Text>
    {keptHabits && (
      <Text style={styles.reorderPassSentence} testID="reorder-pass-kept-hint">
        {KEPT_HABITS_COPY}
      </Text>
    )}
    <DateNotice notice={notice} />
  </>
);

const ReorderDateButton = (props: ReorderDateButtonProps) => {
  const { startDate, range, pass, notice, onOpenPicker, onSelectDate } = props;
  if (pass.held !== null) return <PendingPassDate {...props} />;
  if (range.locked) return <ProgramStartFixed label={START_DATE_LABEL} date={startDate} />;
  return (
    <>
      <DateRow
        label={START_DATE_LABEL}
        date={startDate}
        range={range}
        testID="reorder-start-date"
        ariaLabel="First habit start date"
        onOpenPicker={onOpenPicker}
        onSelectDate={onSelectDate}
      />
      <DateNotice notice={notice} />
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
  /** A pick of the pending pass's day (#3747): previewed until Save Order. */
  handleConfirmPassDate: (_d: Date) => void;
  handleCancelDate: () => void;
  /** True while the commit is on the wire; drives the busy control. */
  saving: boolean;
  handleSave: () => Promise<void>;
  /** What the start-date picker may offer, or that it is fixed (#3097). */
  range: ProgramStartRange;
  /** Why the last picked date did not save, shown beside the picker. */
  notice: string | null;
  /** The pending next pass, whose day is offered instead of a correction (#3747). */
  pass: PendingPassPick;
}

interface ReorderHookInput {
  habits: Habit[];
  visible: boolean;
  userTimezone?: string;
  onClose: () => void;
  onSaveOrder: SaveHabitOrder;
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

/** The start date's half of one sitting, as the commit needs it. */
interface StartDateSitting {
  /** The start date's own commit, run before the order is sent. */
  gate: StartDateGate;
  /** Whether a start date was saved in this sitting, so the rows are owed to it. */
  anchorSaved: () => boolean;
  /** Say the date saved but the habits did not move to match (#3707). */
  rowsUnsaved: () => void;
}

const useOrderCommit = (
  onSaveOrder: SaveHabitOrder,
  onClose: () => void,
): {
  saving: boolean;
  commit: (_ordered: Habit[], _sitting: StartDateSitting) => Promise<void>;
} => {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const commit = async (ordered: Habit[], sitting: StartDateSitting): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // ``gate`` is the start date's own commit. When the server refuses it the
    // modal stays open on the date that still stands, so the person can pick
    // again rather than lose the chance (#3097); nothing of the order is sent.
    // A gate with nothing to send answers synchronously, so the order is sent
    // in the same tick as the press, exactly as it was before the gate existed.
    let proceed = false;
    let rowsOwed = false;
    try {
      const verdict = sitting.gate();
      proceed = typeof verdict === 'boolean' ? verdict : await verdict;
      if (proceed) {
        const anchorSaved = sitting.anchorSaved();
        // A rejection is a save that did not land, the same as ``false``.
        const landed = await onSaveOrder(ordered, { anchorSaved }).catch(() => false);
        rowsOwed = anchorSaved && !landed;
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
      // Close once the order was sent. ``onSaveOrder`` settles rather than
      // failing: a refusal has already alerted and rolled the store back, and
      // the order this modal is still holding is the one that did not take --
      // staying open would show the person an arrangement the app no longer has.
      // The one exception is a start date saved in this sitting whose rows did
      // not follow (#3707): closing would hide that the anchor moved, so the
      // modal stays on the saved date and says so, and Save Order re-lays the
      // rows from it without sending the date again.
      if (rowsOwed) sitting.rowsUnsaved();
      else if (proceed) onClose();
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
  /** Whether recalculating from a pass day changes any previewed row (#3762). */
  movesRows: (_day: string) => boolean;
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
/**
 * The pending pass's half of the gate (#3747): ``POST /stages/passes`` with the
 * picked day, before the order. A later day reschedules the pass, an earlier
 * one starts it now; either way no anchor PUT is sent. The rows laid for the
 * pass were already previewed moved with it (#3762) and are sent once, with
 * the order -- so the POST goes alone (``moveHabits: false``). A refusal or a
 * dropped connection puts the held day back, says why, and the order is not
 * sent.
 */
const passGate = (
  pass: PendingPassPick,
  say: (_notice: string) => void,
  saved: (_day: string) => void,
): StartDateGate => {
  if (!pass.changed) return () => true;
  const { day } = pass;
  return () =>
    pass.commit({ moveHabits: false }).then((outcome) => {
      if (outcome.kind === 'unchanged') return true;
      if (outcome.kind === 'saved') {
        saved(day);
        return true;
      }
      say(outcome.message);
      return false;
    });
};

/**
 * The day a pending pass's waiting habits are previewed from in this sitting
 * (#3762): the person's pick until it saves, then the saved day -- kept even
 * once the pass has begun and nothing is pending, so a retry after the rows
 * failed sends them recalculated.
 */
const usePassMove = () => {
  const [pickedTo, setPickedTo] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  return {
    to: pickedTo ?? savedTo,
    pick: setPickedTo,
    /** The pick saved: the rows stay recalculated from it. */
    keep: (day: string) => {
      setSavedTo(day);
      setPickedTo(null);
    },
    /** The pick did not save: the rows go back to the last saved day, if any. */
    drop: () => setPickedTo(null),
    clear: () => {
      setPickedTo(null);
      setSavedTo(null);
    },
  };
};

/**
 * The pending pass's half of one sitting (#3747): its pick, its gate, and the
 * move its rows are previewed with (#3762). ``anchorSavedRef`` is the sitting's
 * own: rows a saved move changed are owed to it, as a saved start date's are.
 */
const usePassSitting = (
  userTimezone: string,
  say: (_notice: string) => void,
  movesRows: (_day: string) => boolean,
  anchorSavedRef: { current: boolean },
) => {
  const pass = usePendingPassPick(userTimezone);
  const passMove = usePassMove();
  // Whether the pass moved in this sitting, so owed rows are its. A ref, like
  // ``anchorSavedRef``: the commit reads it after the save, not at the press.
  const savedRef = useRef(false);
  const gate = passGate(
    pass,
    (message) => {
      passMove.drop();
      say(message);
    },
    (day) => {
      passMove.keep(day);
      savedRef.current = true;
      if (movesRows(day)) anchorSavedRef.current = true;
    },
  );
  return {
    pass,
    to: passMove.to,
    gate,
    /** Why the rows a save still owes did not follow: the pass's move, or the date's. */
    owedCopy: () => (savedRef.current ? PASS_HABITS_NOT_MOVED_COPY : HABIT_ROWS_NOT_MOVED_COPY),
    pick: (day: string) => {
      pass.pick(day);
      passMove.pick(day);
    },
    end: () => {
      pass.reset();
      passMove.clear();
      savedRef.current = false;
    },
  };
};

const useStartDateGate = ({
  startDate,
  userTimezone,
  range,
  restore,
  movesRows,
}: StartDateGateInput) => {
  const programStartDay = useProgramStore((s) => s.programStartDay);
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const [notice, setNotice] = useState<string | null>(null);
  // Whether the person picked a date in this sitting; only then is one sent.
  const [picked, setPicked] = useState(false);
  // Whether a date was SAVED in this sitting (#3707). A ref, not ``picked``: an
  // unchanged pick sends nothing, and a retry after the rows failed sends no
  // second PUT, yet the rows are still owed to the anchor saved earlier. Only
  // the end of the sitting clears it -- a new pick does not, because the rows
  // are still laid from the old day until one of these saves lands.
  const anchorSavedRef = useRef(false);
  const passSitting = usePassSitting(userTimezone, setNotice, movesRows, anchorSavedRef);
  const { pass } = passSitting;
  const gate: StartDateGate = () => {
    if (pass.held !== null) return passSitting.gate();
    const day = toISODate(startDate);
    if (!picked || range.locked || day === programStartDay) return true;
    return commitProgramStart(day, { tz: userTimezone }).then((outcome) => {
      if (outcome.kind === 'saved') {
        anchorSavedRef.current = true;
        return true;
      }
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
  /** A new pick of the pending pass's day (#3747), sent at Save Order. */
  const pickPassDay = (day: string) => {
    passSitting.pick(day);
    setNotice(null);
  };
  /** The sitting is over: nothing picked, nothing saved, nothing to say. */
  const endSitting = () => {
    setPicked(false);
    setNotice(null);
    passSitting.end();
    anchorSavedRef.current = false;
  };
  const sitting: StartDateSitting = {
    gate,
    anchorSaved: () => anchorSavedRef.current,
    rowsUnsaved: () => setNotice(passSitting.owedCopy()),
  };
  return { notice, sitting, markPicked, pass, passTo: passSitting.to, pickPassDay, endSitting };
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

/** ``rows`` with each start date as laid, before any pass move (#3762). */
const unmoved = (rows: Habit[], laid: readonly Habit[]): Habit[] => {
  const laidStart = new Map(laid.map((habit) => [habit.id, habit.start_date]));
  return rows.map((habit) => {
    const start = laidStart.get(habit.id);
    return start === undefined ? habit : { ...habit, start_date: start };
  });
};

/** The rows a drag left behind, whichever shape the list handed back. */
const droppedHabits = (data: Array<Habit | ReorderEntry>): Habit[] =>
  data.some(isReorderEntry) ? habitsFromEntries(data.filter(isReorderEntry)) : (data as Habit[]);

/**
 * The rows and the start date they are previewed from. ``restartFrom`` moves
 * both together, so the list always shows the cadence the picker shows.
 */
const useStartDatePreview = (userTimezone: string) => {
  const programStartDate = useProgramStore((s) => s.programStartDate);
  const [orderedHabits, setOrderedHabits] = useState<Habit[]>([]);
  const [startDate, setStartDate] = useState<Date>(() => programStartDate ?? new Date());
  const restartFrom = (date: Date) => {
    setStartDate(date);
    setOrderedHabits((prev) => updateStartDates(prev, date, userTimezone));
  };
  // While a next pass is pending the rows keep their own dates and the start
  // shown is their own first day, not the running start, so a sitting that only
  // moves that pass -- or starts it now -- re-lays no row (#3747): the rows laid
  // for the pass only move with it (#3762), and the running pass's never move.
  const seed = (rows: Habit[], pending: boolean) => {
    const held = pending ? heldRowsStart(rows, userTimezone) : null;
    const from = held ?? startDate;
    setStartDate(from);
    setOrderedHabits(held === null ? updateStartDates(rows, from, userTimezone) : rows);
  };
  return {
    programStartDate,
    orderedHabits,
    setOrderedHabits,
    startDate,
    setStartDate,
    restartFrom,
    seed,
  };
};

/**
 * The preview while a pass is pending (#3762): the rows keep their own dates,
 * and the habits waiting for the pass are re-cascaded from ``to`` -- the day
 * picked, else the held one -- each at its own slot. A drag only reorders: the
 * waiting habits cascade by their new slots, and a kept habit never moves.
 * Outside pending mode a drag re-lays the cadence from the start, as before.
 */
const usePassPreview = (preview: ReturnType<typeof useStartDatePreview>, userTimezone: string) => {
  const { orderedHabits: laid, startDate: laidStart, setOrderedHabits } = preview;
  const recalculated = (to: string | null): Habit[] =>
    to === null ? laid : recalculatePassRows(laid, to, userTimezone);
  return {
    movesRows: (to: string) => recalculated(to).some((row, index) => row !== laid[index]),
    shown: recalculated,
    dragEnd: (to: string | null) => (data: Array<Habit | ReorderEntry>) =>
      setOrderedHabits(
        to === null
          ? updateStartDates(droppedHabits(data), laidStart, userTimezone)
          : unmoved(droppedHabits(data), laid),
      ),
  };
};

const useReorderState = ({
  habits,
  visible,
  userTimezone = detectDeviceTimezone(),
  onClose,
  onSaveOrder,
}: ReorderHookInput): ReorderState => {
  const range = useProgramStartRange(userTimezone);
  const { saving, commit } = useOrderCommit(onSaveOrder, onClose);
  const preview = useStartDatePreview(userTimezone);
  const { restartFrom, startDate: laidStart } = preview;
  const passPreview = usePassPreview(preview, userTimezone);
  const [pickerVisible, setPickerVisible] = useState(false);
  const { movesRows } = passPreview;
  const gateInput = { startDate: laidStart, userTimezone, range, restore: restartFrom, movesRows };
  const { notice, sitting, markPicked, pass, passTo, pickPassDay, endSitting } =
    useStartDateGate(gateInput);
  // The rows as previewed and saved: the habits waiting for the pending pass
  // cascade from its day (#3762); every other row keeps its own date.
  const cascadeFrom = passTo ?? (pass.held === null ? null : pass.day);
  const orderedHabits = passPreview.shown(cascadeFrom);
  const startDate = laidStart;

  useClosedReset(visible, () => {
    if (preview.programStartDate) preview.setStartDate(preview.programStartDate);
    setPickerVisible(false);
    endSitting();
  });

  useOpenSeed(visible, habits, (rows) => preview.seed(rows, pass.held !== null));

  return {
    orderedHabits,
    startDate,
    pickerVisible,
    setPickerVisible,
    handleDragEnd: ({ data }) => passPreview.dragEnd(cascadeFrom)(data),
    // Preview only. The restamped rows live here until Save Order, so writing
    // the global anchor now would let a date the user previewed and then
    // abandoned outlive the modal, with no row on disk agreeing with it.
    handleConfirmDate: (selectedDate) => {
      setPickerVisible(false);
      markPicked();
      restartFrom(selectedDate);
    },
    // The pending pass's day moves the rows laid for it, in the preview (#3762).
    handleConfirmPassDate: (selectedDate) => {
      setPickerVisible(false);
      pickPassDay(toISODate(selectedDate));
    },
    handleCancelDate: () => setPickerVisible(false),
    saving,
    handleSave: () => commit(orderedHabits, sitting),
    range,
    notice,
    pass,
  };
};

interface ReorderBodyProps {
  onClose: () => void;
  orderedHabits: Habit[];
  startDate: Date;
  range: ProgramStartRange;
  pass: PendingPassPick;
  notice: string | null;
  onOpenPicker: () => void;
  onSelectDate: (_d: Date) => void;
  onSelectPassDate: (_d: Date) => void;
  onDragEnd: ReorderListProps['onDragEnd'];
  saving: boolean;
  onSave: () => void;
}

const ReorderBody = ({
  onClose,
  orderedHabits,
  startDate,
  range,
  pass,
  notice,
  onOpenPicker,
  onSelectDate,
  onSelectPassDate,
  onDragEnd,
  saving,
  onSave,
}: ReorderBodyProps) => (
  <View testID="reorder-modal-card" style={styles.reorderModalContent}>
    <ModalHeader
      title="Reorder Habits"
      onClose={onClose}
      closeLabel={REORDER_HABITS_CLOSE_LABEL}
      closeDisabled={saving}
    />
    <ReorderDateButton
      startDate={startDate}
      range={range}
      pass={pass}
      notice={notice}
      keptHabits={holdsKeptHabit(orderedHabits)}
      onOpenPicker={onOpenPicker}
      onSelectDate={onSelectDate}
      onSelectPassDate={onSelectPassDate}
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

/**
 * What the one native picker offers: the pending pass's day in the pass window
 * while a pass is pending (#3747), else the start date. Clamped to what the
 * server accepts (#3097): up to the window's end, a whole program ahead
 * (#3728), and back to the window's floor -- or to the date on display, if
 * earlier.
 */
const nativePickerProps = (state: ReorderState) => {
  const pending = state.pass.held !== null;
  const day = pending ? state.pass.day : toISODate(state.startDate);
  const range = pending ? state.pass.range : state.range;
  return {
    date: parseISODate(day),
    minimumDate: parseISODate(pickerFloor(range, day)),
    maximumDate: parseISODate(range.maxDay),
    onConfirm: pending ? state.handleConfirmPassDate : state.handleConfirmDate,
  };
};

// Mount the picker as a SIBLING of the parent <Modal>: iOS animates nested UIViewController modals underneath the parent, hiding them.
export const ReorderHabitsModal = ({
  visible,
  habits,
  userTimezone,
  onClose,
  onSaveOrder,
}: ReorderHabitsModalProps) => {
  const state = useReorderState({ habits, visible, userTimezone, onClose, onSaveOrder });
  // Not while a save is in flight: once a start date has saved this sitting,
  // the rows-unsaved notice is the only report of a failed re-lay
  // (``habitManager`` drops its own alert), so a dismissal mid-save would leave
  // the anchor moved and the rows on the old day with no message (#3707).
  const closeUnlessSaving = () => {
    if (!state.saving) onClose();
  };
  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={closeUnlessSaving}>
        <View testID="reorder-modal-overlay" style={styles.modalOverlay}>
          <ReorderBody
            onClose={closeUnlessSaving}
            orderedHabits={state.orderedHabits}
            startDate={state.startDate}
            range={state.range}
            pass={state.pass}
            notice={state.notice}
            onOpenPicker={() => state.setPickerVisible(true)}
            onSelectDate={state.handleConfirmDate}
            onSelectPassDate={state.handleConfirmPassDate}
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
        {...nativePickerProps(state)}
        onCancel={state.handleCancelDate}
      />
    </>
  );
};

export default ReorderHabitsModal;
