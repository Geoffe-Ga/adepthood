import { Check, ChevronLeft, ChevronRight, Pencil } from 'lucide-react-native';
import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  PanResponder,
  StyleSheet,
} from 'react-native';
import type {
  DimensionValue,
  GestureResponderHandlers,
  LayoutChangeEvent,
  ViewStyle,
  TextStyle,
} from 'react-native';
import EmojiSelector from 'react-native-emoji-selector';

import { goalGroups as goalGroupsApi, type ApiGoalGroup } from '../../../api';
import { Button } from '../../../components/Button';
import { TierStar } from '../../../components/TierStar';
import { useAuth } from '../../../context/AuthContext';
import {
  colors,
  spacing,
  SPACING,
  STAGE_COLORS,
  shadows,
  touchTarget,
} from '../../../design/tokens';
import useResponsive from '../../../design/useResponsive';
import { addDaysInTZ, dayKeyInTZ, todayInUserTZ } from '../../../utils/dateUtils';
import { TARGET_UNITS, FREQUENCY_UNITS } from '../constants';
import { TIER_LABELS, centeredTranslateX, tooltipBoxStyle } from '../goalMarker';
import styles from '../Habits.styles';
import type { GoalModalProps, Goal } from '../Habits.types';
import {
  getMarkerPositions,
  getProgressBarColor,
  clampPercentage,
  getTierColor,
  getGoalTarget,
  isGoalAchieved,
  calculateTodaysProgress,
} from '../HabitUtils';

import ConfirmDialog from './ConfirmDialog';

/** Height of the goal progress bar; tier star markers are centered on it. */
const MODAL_BAR_HEIGHT = 12;

/** Position a tier star marker on the bar: centered on its threshold and on the bar height. */
const markerContainerStyle = (leftPct: number, z: number, starSize: number): ViewStyle => {
  const clamped = clampPercentage(leftPct);
  return {
    position: 'absolute',
    left: `${clamped}%` as DimensionValue,
    top: (MODAL_BAR_HEIGHT - starSize) / 2,
    transform: [{ translateX: centeredTranslateX(clamped, starSize) }],
    zIndex: z,
    alignItems: 'center',
  };
};

const tooltipTextStyle: TextStyle = {
  fontSize: 10,
  color: '#333',
  fontFamily: 'serif',
  fontStyle: 'italic',
  letterSpacing: 0.5,
};

const formatGoalTooltip = (g: Goal | undefined): string => {
  if (!g) return '';
  const label = TIER_LABELS[g.tier] ?? g.tier;
  return `${label}: ${g.target} ${g.target_unit} per ${g.frequency_unit.replace('_', ' ')}`;
};

const computeProgressPct = (
  totalProgress: number,
  lowGoal: Goal | undefined,
  stretchGoal: Goal | undefined,
): number => {
  if (!stretchGoal) return 0;
  if (lowGoal?.is_additive) {
    return clampPercentage((totalProgress / getGoalTarget(stretchGoal)) * 100);
  }
  const stretchTarget = getGoalTarget(stretchGoal);
  const lowTarget = getGoalTarget(lowGoal!);
  return clampPercentage(
    100 - ((totalProgress - stretchTarget) / (lowTarget - stretchTarget)) * 100,
  );
};

interface GoalMarkerItemProps {
  goal: Goal;
  tier: 'low' | 'clear' | 'stretch';
  position: number;
  zIndex: number;
  met: boolean;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  panHandlers?: GestureResponderHandlers;
}

const GoalMarkerItem = ({
  goal,
  tier,
  position,
  zIndex,
  met,
  tooltip,
  setTooltip,
  panHandlers,
}: GoalMarkerItemProps) => {
  const { scale } = useResponsive();
  // Match HabitTile's marker sizing so the two surfaces stay visually consistent.
  const starSize = spacing(2, scale);
  const Wrapper = tier === 'stretch' ? TouchableOpacity : View;
  const interactionProps =
    tier === 'stretch'
      ? { onPressIn: () => setTooltip(tier), onPressOut: () => setTooltip(null) }
      : panHandlers ?? {};

  return (
    <Wrapper
      testID={`modal-marker-${tier}`}
      {...interactionProps}
      onMouseEnter={() => setTooltip(tier)}
      onMouseLeave={() => setTooltip(null)}
      style={markerContainerStyle(position, zIndex, starSize)}
    >
      {tooltip === tier && (
        <View testID={`modal-tooltip-${tier}`} style={tooltipBoxStyle(getTierColor(tier))}>
          <Text style={tooltipTextStyle}>{formatGoalTooltip(goal)}</Text>
        </View>
      )}
      <TierStar tier={tier} met={met} size={starSize} />
    </Wrapper>
  );
};

interface GoalProgressBarProps {
  progressPercentage: number;
  progressBarColor: string;
  lowGoal: Goal | undefined;
  clearGoal: Goal | undefined;
  stretchGoal: Goal | undefined;
  lowMarker: number;
  clearMarker: number;
  stretchMarker: number;
  lowMet: boolean;
  clearMet: boolean;
  stretchMet: boolean;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  lowPanHandlers: GestureResponderHandlers;
  clearPanHandlers: GestureResponderHandlers;
  onLayout: (_e: LayoutChangeEvent) => void;
}

interface ProgressFillProps {
  progressPercentage: number;
  progressBarColor: string;
}

const ProgressFill = ({ progressPercentage, progressBarColor }: ProgressFillProps) => (
  <View style={{ height: '100%', backgroundColor: '#eee', borderRadius: 6, overflow: 'hidden' }}>
    <View
      testID="modal-progress-fill"
      style={{
        height: '100%',
        width: `${progressPercentage}%`,
        backgroundColor: progressBarColor,
        borderRadius: 6,
      }}
    />
  </View>
);

interface GoalMarkersRowProps {
  lowGoal: Goal | undefined;
  clearGoal: Goal | undefined;
  stretchGoal: Goal | undefined;
  lowMarker: number;
  clearMarker: number;
  stretchMarker: number;
  lowMet: boolean;
  clearMet: boolean;
  stretchMet: boolean;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  lowPanHandlers: GestureResponderHandlers;
  clearPanHandlers: GestureResponderHandlers;
}

interface MarkerEntry {
  tier: 'low' | 'clear' | 'stretch';
  goal: Goal | undefined;
  position: number;
  zIndex: number;
  met: boolean;
  panHandlers?: GestureResponderHandlers;
}

const buildMarkerEntries = (p: GoalMarkersRowProps): MarkerEntry[] => [
  {
    tier: 'low',
    goal: p.lowGoal,
    position: p.lowMarker,
    zIndex: 1,
    met: p.lowMet,
    panHandlers: p.lowPanHandlers,
  },
  {
    tier: 'clear',
    goal: p.clearGoal,
    position: p.clearMarker,
    zIndex: 2,
    met: p.clearMet,
    panHandlers: p.clearPanHandlers,
  },
  { tier: 'stretch', goal: p.stretchGoal, position: p.stretchMarker, zIndex: 3, met: p.stretchMet },
];

const GoalMarkersRow = (props: GoalMarkersRowProps) => {
  const { tooltip, setTooltip } = props;
  return (
    <>
      {buildMarkerEntries(props).map((it) =>
        it.goal ? (
          <GoalMarkerItem
            key={it.tier}
            goal={it.goal}
            tier={it.tier}
            position={it.position}
            zIndex={it.zIndex}
            met={it.met}
            tooltip={tooltip}
            setTooltip={setTooltip}
            panHandlers={it.panHandlers}
          />
        ) : null,
      )}
    </>
  );
};

const GoalProgressBar = ({
  progressPercentage,
  progressBarColor,
  lowGoal,
  clearGoal,
  stretchGoal,
  lowMarker,
  clearMarker,
  stretchMarker,
  lowMet,
  clearMet,
  stretchMet,
  tooltip,
  setTooltip,
  lowPanHandlers,
  clearPanHandlers,
  onLayout,
}: GoalProgressBarProps) => (
  <View style={{ marginVertical: 16 }} onLayout={onLayout}>
    <View style={{ height: MODAL_BAR_HEIGHT, position: 'relative' }}>
      <ProgressFill progressPercentage={progressPercentage} progressBarColor={progressBarColor} />
      <GoalMarkersRow
        lowGoal={lowGoal}
        clearGoal={clearGoal}
        stretchGoal={stretchGoal}
        lowMarker={lowMarker}
        clearMarker={clearMarker}
        stretchMarker={stretchMarker}
        lowMet={lowMet}
        clearMet={clearMet}
        stretchMet={stretchMet}
        tooltip={tooltip}
        setTooltip={setTooltip}
        lowPanHandlers={lowPanHandlers}
        clearPanHandlers={clearPanHandlers}
      />
    </View>
  </View>
);

// Layout constants for the log-date stepper.
const LOG_DATE_NOON_HOUR = 12;
const LOG_DATE_ICON_SIZE = 20;
const LOG_DATE_LABEL_FONT_SIZE = 14;
const LOG_DATE_LABEL_MIN_WIDTH = 116;
const LOG_DATE_DISABLED_OPACITY = 0.3;

const logDateStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.sm,
  },
  label: {
    fontSize: LOG_DATE_LABEL_FONT_SIZE,
    fontWeight: '600',
    color: colors.text.primary,
    minWidth: LOG_DATE_LABEL_MIN_WIDTH,
    textAlign: 'center',
  },
  stepButton: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonDisabled: {
    opacity: LOG_DATE_DISABLED_OPACITY,
  },
});

/** Shift a date by whole calendar days, anchored at noon to dodge DST skew. */
const shiftLogDate = (date: Date, deltaDays: number): Date => {
  const next = new Date(date);
  next.setHours(LOG_DATE_NOON_HOUR, 0, 0, 0);
  next.setDate(next.getDate() + deltaDays);
  return next;
};

/** Human label for the log date: "Today", "Yesterday", or e.g. "Mon, Jan 5". */
const formatLogDateLabel = (date: Date, tz: string): string => {
  const key = dayKeyInTZ(date, tz);
  const todayKey = todayInUserTZ(tz);
  if (key === todayKey) return 'Today';
  if (key === addDaysInTZ(todayKey, -1, tz)) return 'Yesterday';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
};

interface LogDateStepperProps {
  logDate: Date;
  setLogDate: (_v: Date) => void;
  tz: string;
}

/**
 * Day picker for the log section: step back to log a missed day, forward
 * to return toward today. The "next" arrow is disabled at today so the
 * user can never log a completion in the future.
 */
const LogDateStepper = ({ logDate, setLogDate, tz }: LogDateStepperProps) => {
  const atToday = dayKeyInTZ(logDate, tz) === todayInUserTZ(tz);
  return (
    <View style={logDateStyles.row} testID="log-date-stepper">
      <TouchableOpacity
        testID="log-date-prev"
        accessibilityRole="button"
        accessibilityLabel="Log an earlier day"
        onPress={() => setLogDate(shiftLogDate(logDate, -1))}
        style={logDateStyles.stepButton}
      >
        <ChevronLeft size={LOG_DATE_ICON_SIZE} color={colors.text.secondary} />
      </TouchableOpacity>
      <Text testID="log-date-label" style={logDateStyles.label}>
        {formatLogDateLabel(logDate, tz)}
      </Text>
      <TouchableOpacity
        testID="log-date-next"
        accessibilityRole="button"
        accessibilityLabel="Log a later day"
        accessibilityState={{ disabled: atToday }}
        disabled={atToday}
        onPress={() => setLogDate(shiftLogDate(logDate, 1))}
        style={[logDateStyles.stepButton, atToday && logDateStyles.stepButtonDisabled]}
      >
        <ChevronRight size={LOG_DATE_ICON_SIZE} color={colors.text.secondary} />
      </TouchableOpacity>
    </View>
  );
};

interface LogUnitSectionProps {
  logAmount: string;
  setLogAmount: (_v: string) => void;
  logDate: Date;
  setLogDate: (_v: Date) => void;
  tz: string;
  onLog: () => void;
}

const LogUnitSection = ({
  logAmount,
  setLogAmount,
  logDate,
  setLogDate,
  tz,
  onLog,
}: LogUnitSectionProps) => (
  <View style={styles.actionButtons} testID="goal-modal-log-unit-section">
    <LogDateStepper logDate={logDate} setLogDate={setLogDate} tz={tz} />
    <View style={styles.logUnitContainer}>
      <TextInput
        style={styles.logUnitInput}
        value={logAmount}
        onChangeText={setLogAmount}
        keyboardType="numeric"
      />
      <Button label="Log Units" onPress={onLog} testID="goal-log-units" />
    </View>
  </View>
);

const TIER_ORDER = ['low', 'clear', 'stretch'] as const;

// Layout constants for the inline goal-target editor; design-token
// equivalents (`SPACING`, `colors`, `BORDER_RADIUS`) are reused where one exists.
const GOAL_INPUT_WIDTH = 64;
const GOAL_INPUT_VERTICAL_PADDING = 6;
const GOAL_ROW_VERTICAL_PADDING = 6;
const GOAL_INPUT_BORDER_RADIUS = 6;
const GOAL_UNIT_MIN_WIDTH = 80;
const GOAL_SECTION_TITLE_FONT_SIZE = 13;
const GOAL_LABEL_FONT_SIZE = 14;
const GOAL_INPUT_FONT_SIZE = 15;
const GOAL_UNIT_FONT_SIZE = 13;
const GOAL_SECTION_TITLE_LETTER_SPACING = 0.5;
const GOAL_FIELD_LABEL_FONT_SIZE = 12;
const GOAL_CHIP_VERTICAL_PADDING = 4;
const GOAL_CHIP_HORIZONTAL_PADDING = 10;
const GOAL_CHIP_BORDER_RADIUS = 14;
const GOAL_CHIP_FONT_SIZE = 12;
const GOAL_FREQ_INPUT_WIDTH = 56;
const GOAL_DISPLAY_VERTICAL_PADDING = 6;
const GOAL_DISPLAY_HORIZONTAL_PADDING = 10;
const GOAL_SAVE_BUTTON_VERTICAL_PADDING = 6;
const GOAL_SAVE_BUTTON_HORIZONTAL_PADDING = 12;
const GOAL_SAVE_BUTTON_FONT_SIZE = 13;

const goalEditorStyles = StyleSheet.create({
  container: {
    marginVertical: SPACING.md,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: {
    fontSize: GOAL_SECTION_TITLE_FONT_SIZE,
    fontWeight: '600',
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: GOAL_SECTION_TITLE_LETTER_SPACING,
    marginBottom: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: GOAL_ROW_VERTICAL_PADDING,
  },
  label: {
    flex: 1,
    fontSize: GOAL_LABEL_FONT_SIZE,
    fontWeight: '500',
  },
  /** Edit-mode field — recessed (sunken) bevel so it reads as "open for input". */
  input: {
    width: GOAL_INPUT_WIDTH,
    borderWidth: 1,
    borderTopColor: colors.bevel.edgeDark,
    borderLeftColor: colors.bevel.edgeDark,
    borderBottomColor: colors.bevel.edgeLight,
    borderRightColor: colors.bevel.edgeLight,
    borderRadius: GOAL_INPUT_BORDER_RADIUS,
    paddingVertical: GOAL_INPUT_VERTICAL_PADDING,
    paddingHorizontal: SPACING.sm,
    textAlign: 'center',
    fontSize: GOAL_INPUT_FONT_SIZE,
    marginHorizontal: SPACING.sm,
    backgroundColor: colors.bevel.recessedSurface,
  },
  /** Saved-state chip — convex (raised) so users read it as a tappable button, not a label. */
  display: {
    width: GOAL_INPUT_WIDTH,
    borderRadius: GOAL_INPUT_BORDER_RADIUS,
    paddingVertical: GOAL_DISPLAY_VERTICAL_PADDING,
    paddingHorizontal: GOAL_DISPLAY_HORIZONTAL_PADDING,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.border,
    marginHorizontal: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.small,
  },
  saveButton: {
    paddingVertical: GOAL_SAVE_BUTTON_VERTICAL_PADDING,
    paddingHorizontal: GOAL_SAVE_BUTTON_HORIZONTAL_PADDING,
    borderRadius: GOAL_INPUT_BORDER_RADIUS,
    marginRight: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.small,
  },
  saveButtonText: {
    color: colors.text.light,
    fontWeight: '600',
    fontSize: GOAL_SAVE_BUTTON_FONT_SIZE,
  },
  displayText: {
    fontSize: GOAL_INPUT_FONT_SIZE,
    fontWeight: '600',
  },
  unit: {
    fontSize: GOAL_UNIT_FONT_SIZE,
    color: colors.text.secondary,
    minWidth: GOAL_UNIT_MIN_WIDTH,
  },
  fieldLabel: {
    fontSize: GOAL_FIELD_LABEL_FONT_SIZE,
    color: colors.text.secondary,
    marginRight: SPACING.sm,
    minWidth: GOAL_UNIT_MIN_WIDTH,
  },
  chipRow: {
    paddingVertical: SPACING.xs,
  },
  chip: {
    paddingVertical: GOAL_CHIP_VERTICAL_PADDING,
    paddingHorizontal: GOAL_CHIP_HORIZONTAL_PADDING,
    borderRadius: GOAL_CHIP_BORDER_RADIUS,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: SPACING.xs,
    backgroundColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: colors.tier.clear,
    borderColor: colors.tier.clear,
  },
  chipText: {
    fontSize: GOAL_CHIP_FONT_SIZE,
    color: colors.text.secondary,
  },
  chipTextSelected: {
    color: colors.text.light,
    fontWeight: '600',
  },
  freqInput: {
    width: GOAL_FREQ_INPUT_WIDTH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: GOAL_INPUT_BORDER_RADIUS,
    paddingVertical: GOAL_INPUT_VERTICAL_PADDING,
    paddingHorizontal: SPACING.sm,
    textAlign: 'center',
    fontSize: GOAL_INPUT_FONT_SIZE,
    marginRight: SPACING.sm,
  },
});

interface GoalTargetRowProps {
  goal: Goal;
  onCommit: (_target: number) => void;
}

/**
 * Editing-state machine for a single tier goal's target value.
 *
 * ``submittedRef`` is the gate that collapses the Save-button-press →
 * TextInput-blur double event into one ``onCommit``: ``setEditing(false)``
 * is asynchronous so it can't guard the second call; the ref is set
 * synchronously and reset on each ``startEdit``.
 */
const useTargetDraft = (goal: Goal, onCommit: (_target: number) => void) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(goal.target));
  const submittedRef = useRef(false);
  // Skip sync mid-edit so out-of-band updates don't clobber in-flight typing.
  useEffect(() => {
    if (!editing) setDraft(String(goal.target));
  }, [goal.target, editing]);

  const startEdit = () => {
    submittedRef.current = false;
    setEditing(true);
  };

  const trySave = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setEditing(false);
    const parsed = Number.parseFloat(draft);
    if (!Number.isFinite(parsed) || parsed === goal.target) {
      setDraft(String(goal.target));
      return;
    }
    onCommit(parsed);
  };

  return { editing, draft, setDraft, startEdit, trySave };
};

/**
 * Click-to-edit target row. Two visual states convey the affordance:
 *   - **convex chip** (saved): a raised, card-surface button — tap to edit.
 *   - **recessed input + Save button** (editing): sunken field next to a
 *     filled tier-colored Save button — tap Save (or press Return / blur)
 *     to commit.
 */
const GoalTargetRow = ({ goal, onCommit }: GoalTargetRowProps) => {
  const { editing, draft, setDraft, startEdit, trySave } = useTargetDraft(goal, onCommit);
  const tierLabel = TIER_LABELS[goal.tier] ?? goal.tier;
  const tierColor = getTierColor(goal.tier);

  return (
    <View style={goalEditorStyles.row}>
      <Text style={[goalEditorStyles.label, { color: tierColor }]}>{tierLabel}</Text>
      {editing ? (
        <>
          <TextInput
            testID={`goal-target-input-${goal.tier}`}
            style={goalEditorStyles.input}
            value={draft}
            onChangeText={setDraft}
            // Both events back the same commit so return-key, blur, and
            // explicit Save-button taps each save reliably; the hook's
            // ``submittedRef`` collapses duplicate fires into one commit.
            onEndEditing={trySave}
            onSubmitEditing={trySave}
            autoFocus
            keyboardType="numeric"
            returnKeyType="done"
          />
          <TouchableOpacity
            testID={`goal-target-save-${goal.tier}`}
            accessibilityRole="button"
            accessibilityLabel={`Save ${tierLabel} target`}
            onPress={trySave}
            style={[goalEditorStyles.saveButton, { backgroundColor: tierColor }]}
          >
            <Text style={goalEditorStyles.saveButtonText}>Save</Text>
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity
          testID={`goal-target-display-${goal.tier}`}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${tierLabel} target, currently ${goal.target}`}
          onPress={startEdit}
          style={goalEditorStyles.display}
        >
          <Text style={[goalEditorStyles.displayText, { color: tierColor }]}>{goal.target}</Text>
        </TouchableOpacity>
      )}
      <Text style={goalEditorStyles.unit}>
        {goal.target_unit} / {goal.frequency_unit.replace('_', ' ')}
      </Text>
    </View>
  );
};

interface UnitChipRowProps {
  options: readonly string[];
  selected: string;
  testID: string;
  onSelect: (_value: string) => void;
}

const formatUnitLabel = (value: string): string => value.replace(/_/g, ' ');

/**
 * Horizontal chip selector used for ``target_unit`` and ``frequency_unit``.
 * A chip set fits the existing modal aesthetic without pulling in
 * ``@react-native-picker/picker``, and lets the user see all options in
 * one swipe rather than a modal-on-top-of-modal native picker.
 *
 * Each chip is exposed to assistive tech as a radio button — selection is
 * mutually exclusive within a row, so ``role="radio"`` + ``checked`` is the
 * accurate semantic, not a generic button toggle. The accessible name is
 * pinned to the formatted label so VoiceOver / TalkBack announce e.g.
 * "per day" rather than reading the raw "per_day" backend token.
 */
const UnitChipRow = ({ options, selected, testID, onSelect }: UnitChipRowProps) => (
  <ScrollView
    horizontal
    showsHorizontalScrollIndicator={false}
    style={goalEditorStyles.chipRow}
    testID={testID}
  >
    {options.map((opt) => {
      const isSelected = opt === selected;
      const label = formatUnitLabel(opt);
      return (
        <TouchableOpacity
          key={opt}
          testID={`${testID}-${opt}`}
          onPress={() => onSelect(opt)}
          style={[goalEditorStyles.chip, isSelected && goalEditorStyles.chipSelected]}
          accessibilityRole="radio"
          accessibilityLabel={label}
          accessibilityState={{ checked: isSelected }}
        >
          <Text
            style={[goalEditorStyles.chipText, isSelected && goalEditorStyles.chipTextSelected]}
          >
            {label}
          </Text>
        </TouchableOpacity>
      );
    })}
  </ScrollView>
);

/**
 * Tier goals are constructed from the same fixed `TIER_ORDER` (`low`,
 * `clear`, `stretch`) at habit creation, so the array always has at
 * least one element. Encoding the non-empty contract in the type lets
 * `goals[0]` resolve as `Goal` (no `!` assertion) and keeps callers
 * honest if they ever try to pass `[]`.
 */
type NonEmptyGoals = [Goal, ...Goal[]];

interface GoalUnitEditorProps {
  /**
   * All tier goals belonging to the habit. Any one is a valid display
   * reference (units are normalized across tiers via ``normalizeGoalUnits``),
   * but every commit fans out a PUT for each goal so the backend rows
   * stay in lockstep with the client's normalized state.
   */
  goals: NonEmptyGoals;
  habitId: number;
  onUpdateGoalUnits: GoalModalProps['onUpdateGoalUnits'];
}

interface FrequencyInputProps {
  draft: string;
  setDraft: (_v: string) => void;
  onEnd: () => void;
}

const FrequencyInput = ({ draft, setDraft, onEnd }: FrequencyInputProps) => (
  <TextInput
    testID="goal-frequency-input"
    style={goalEditorStyles.freqInput}
    value={draft}
    onChangeText={setDraft}
    onEndEditing={onEnd}
    keyboardType="numeric"
    returnKeyType="done"
  />
);

/**
 * Edits ``target_unit`` / ``frequency`` / ``frequency_unit`` for a habit's
 * goals. The fields are shared across tiers, so the editor surfaces them
 * once and commits through ``onUpdateGoalUnits`` — a single atomic batch
 * update that moves every tier together (#289).
 */
const GoalUnitEditor = ({ goals, habitId, onUpdateGoalUnits }: GoalUnitEditorProps) => {
  const reference = goals[0];
  const [freqDraft, setFreqDraft] = useState(String(reference.frequency));
  useEffect(() => {
    setFreqDraft(String(reference.frequency));
  }, [reference.frequency]);

  // Issue #289: ONE consolidated call — the backend updates every tier
  // inside a single transaction, so a failure can never strand tiers on
  // mismatched units the way the old per-tier fan-out could.
  const commit = (changes: Partial<Pick<Goal, 'target_unit' | 'frequency' | 'frequency_unit'>>) => {
    onUpdateGoalUnits(habitId, changes);
  };

  const handleFreqEnd = () => {
    const parsed = Number.parseFloat(freqDraft);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed === reference.frequency) {
      setFreqDraft(String(reference.frequency));
      return;
    }
    commit({ frequency: parsed });
  };

  return (
    <View testID="goal-unit-editor">
      <View style={goalEditorStyles.row}>
        <Text style={goalEditorStyles.fieldLabel}>Unit</Text>
        <UnitChipRow
          options={TARGET_UNITS}
          selected={reference.target_unit}
          testID="goal-target-unit"
          onSelect={(value) => commit({ target_unit: value })}
        />
      </View>
      <View style={goalEditorStyles.row}>
        <Text style={goalEditorStyles.fieldLabel}>Every</Text>
        <FrequencyInput draft={freqDraft} setDraft={setFreqDraft} onEnd={handleFreqEnd} />
        <UnitChipRow
          options={FREQUENCY_UNITS}
          selected={reference.frequency_unit}
          testID="goal-frequency-unit"
          onSelect={(value) => commit({ frequency_unit: value })}
        />
      </View>
    </View>
  );
};

const DIRECTION_OPTIONS = [
  { value: true, label: 'Add up', testID: 'goal-direction-additive' },
  { value: false, label: 'Cut back', testID: 'goal-direction-subtractive' },
] as const;

interface GoalDirectionRowProps {
  isAdditive: boolean;
  onChange: (_v: boolean) => void;
}

const GoalDirectionRow = ({ isAdditive, onChange }: GoalDirectionRowProps) => (
  <View style={goalEditorStyles.row} testID="goal-direction-row">
    <Text style={goalEditorStyles.fieldLabel}>Type</Text>
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={goalEditorStyles.chipRow}
      testID="goal-direction-chips"
    >
      {DIRECTION_OPTIONS.map((opt) => {
        const selected = opt.value === isAdditive;
        return (
          <TouchableOpacity
            key={opt.label}
            testID={opt.testID}
            onPress={() => onChange(opt.value)}
            style={[goalEditorStyles.chip, selected && goalEditorStyles.chipSelected]}
            accessibilityRole="radio"
            accessibilityLabel={opt.label}
            accessibilityState={{ checked: selected }}
          >
            <Text
              style={[goalEditorStyles.chipText, selected && goalEditorStyles.chipTextSelected]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  </View>
);

// Emit PUTs in ascending new-target order so each normalizeGoalTiers clamp is a no-op.
const buildDirectionChangePayloads = (goals: readonly Goal[], newIsAdditive: boolean): Goal[] => {
  const ascendingTargets = goals.map((g) => g.target).sort((a, b) => a - b);
  const tiersByAscendingNewTarget = newIsAdditive
    ? (['low', 'clear', 'stretch'] as const)
    : (['stretch', 'clear', 'low'] as const);
  return tiersByAscendingNewTarget
    .map((tier, i) => {
      const goal = goals.find((g) => g.tier === tier);
      if (!goal) return null;
      return { ...goal, is_additive: newIsAdditive, target: ascendingTargets[i]! };
    })
    .filter((g): g is Goal => g !== null);
};

interface GoalTargetEditorProps {
  habit: NonNullable<GoalModalProps['habit']>;
  onUpdateGoal: GoalModalProps['onUpdateGoal'];
  onUpdateGoalUnits: GoalModalProps['onUpdateGoalUnits'];
}

/**
 * Inline goal-target editor surfaced in the GoalModal so mobile users have a
 * discoverable way to change a goal's numeric target. The pre-existing marker
 * drag is kept (desktop-friendly), but the marker hit area is 12px and never
 * triggered reliably under thumb input — closing the "no way to edit habit
 * goals on mobile" gap.
 */
const GoalTargetEditor = ({ habit, onUpdateGoal, onUpdateGoalUnits }: GoalTargetEditorProps) => {
  // ``== null`` (not ``!habit.id``) so a hypothetical future habit with id 0
  // still surfaces the editor — falsy-zero is a real concern even if the
  // current backend autoincrements from 1.
  if (habit.id == null) return null;
  const habitId = habit.id;
  const orderedGoals = TIER_ORDER.map((tier) => habit.goals.find((g) => g.tier === tier)).filter(
    (g): g is Goal => g !== undefined,
  );
  const [head, ...tail] = orderedGoals;
  if (head === undefined) return null;
  const nonEmptyGoals: NonEmptyGoals = [head, ...tail];

  const handleDirectionChange = (newIsAdditive: boolean) => {
    if (nonEmptyGoals.every((g) => g.is_additive === newIsAdditive)) return;
    for (const payload of buildDirectionChangePayloads(nonEmptyGoals, newIsAdditive)) {
      onUpdateGoal(habitId, payload);
    }
  };

  return (
    <View style={goalEditorStyles.container} testID="goal-target-editor">
      <Text style={goalEditorStyles.sectionTitle}>Goals</Text>
      <GoalDirectionRow isAdditive={head.is_additive} onChange={handleDirectionChange} />
      {nonEmptyGoals.map((goal) => (
        <GoalTargetRow
          key={goal.id ?? goal.tier}
          goal={goal}
          onCommit={(target) => onUpdateGoal(habitId, { ...goal, target })}
        />
      ))}
      <GoalUnitEditor
        goals={nonEmptyGoals}
        habitId={habitId}
        onUpdateGoalUnits={onUpdateGoalUnits}
      />
    </View>
  );
};

const useGoalGroup = (habit: GoalModalProps['habit']) => {
  const [goalGroup, setGoalGroup] = useState<ApiGoalGroup | null>(null);
  useEffect(() => {
    const groupId = habit?.goals.find((g) => g.goal_group_id)?.goal_group_id;
    if (groupId) {
      goalGroupsApi
        .get(groupId)
        .then(setGoalGroup)
        .catch(() => setGoalGroup(null));
    } else {
      setGoalGroup(null);
    }
  }, [habit]);
  return goalGroup;
};

interface PendingGoalEdit {
  tier: 'low' | 'clear';
  goal: Goal;
  newTarget: number;
  title: string;
  message: string;
}

/**
 * Build the pending goal-edit confirmation for a marker drop, or ``null`` when
 * the drop is a no-op. Rendered via ``ConfirmDialog`` rather than ``Alert.alert``
 * because the latter is a no-op on React Native Web mobile (#786).
 */
const buildPendingGoalEdit = (
  tier: 'low' | 'clear',
  percent: number,
  tiers: ReturnType<typeof useGoalTiers>,
  habitId: number | undefined,
): PendingGoalEdit | null => {
  const goal = tier === 'low' ? tiers.lowGoal : tiers.clearGoal;
  if (!goal || !habitId) return null;
  const stretchTarget = tiers.stretchGoal ? getGoalTarget(tiers.stretchGoal) : goal.target;
  const newTarget = Math.max(1, Math.round((percent / 100) * stretchTarget));
  const tierLabel = tier === 'low' ? 'Low Grit' : 'Clear Goal';
  return {
    tier,
    goal,
    newTarget,
    title: `Edit ${tierLabel.split(' ')[0]} Goal`,
    message: `Edit the ${tierLabel} to be ${newTarget} ${goal.target_unit} ${goal.frequency_unit.replace('_', ' ')}?`,
  };
};

function useGoalTiers(habit: GoalModalProps['habit']) {
  const lowGoal = habit?.goals.find((g) => g.tier === 'low');
  const clearGoal = habit?.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit?.goals.find((g) => g.tier === 'stretch');
  const markers = getMarkerPositions(lowGoal, clearGoal, stretchGoal);
  return { lowGoal, clearGoal, stretchGoal, markers };
}

function useMarkerPanResponders(
  tiers: ReturnType<typeof useGoalTiers>,
  barWidth: React.MutableRefObject<number>,
  lowMarker: number,
  setLowMarker: (_v: number) => void,
  clearMarker: number,
  setClearMarker: (_v: number) => void,
  setTooltip: (_v: null | 'low' | 'clear' | 'stretch') => void,
  onConfirm: (_tier: 'low' | 'clear', _pct: number) => void,
) {
  const createPanResponder = (tier: 'low' | 'clear') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setTooltip(tier),
      onPanResponderMove: (_, gesture) => {
        const init = tier === 'low' ? tiers.markers.low : tiers.markers.clear;
        const pct = (((init / 100) * barWidth.current + gesture.dx) / barWidth.current) * 100;
        if (tier === 'low') setLowMarker(Math.min(clampPercentage(pct), clearMarker - 5));
        else setClearMarker(Math.max(clampPercentage(pct), lowMarker + 5));
      },
      onPanResponderRelease: () => {
        setTooltip(null);
        onConfirm(tier, tier === 'low' ? lowMarker : clearMarker);
      },
      onPanResponderTerminate: () => setTooltip(null),
    });

  const lowPan = useRef(createPanResponder('low')).current;
  const clearPan = useRef(createPanResponder('clear')).current;
  return { lowPan, clearPan };
}

function useGoalConfirm(
  tiers: ReturnType<typeof useGoalTiers>,
  habitId: number | undefined,
  setLowMarker: (_v: number) => void,
  setClearMarker: (_v: number) => void,
  onUpdateGoal: GoalModalProps['onUpdateGoal'],
) {
  const [pending, setPending] = useState<PendingGoalEdit | null>(null);
  const onConfirm = (tier: 'low' | 'clear', percent: number) => {
    const edit = buildPendingGoalEdit(tier, percent, tiers, habitId);
    if (edit) setPending(edit);
  };
  const cancelPending = () => {
    if (pending?.tier === 'low') setLowMarker(tiers.markers.low);
    else if (pending?.tier === 'clear') setClearMarker(tiers.markers.clear);
    setPending(null);
  };
  const applyPending = () => {
    if (pending && habitId) onUpdateGoal(habitId, { ...pending.goal, target: pending.newTarget });
    setPending(null);
  };
  return { onConfirm, pending, cancelPending, applyPending };
}

const useGoalMarkers = (
  habit: GoalModalProps['habit'],
  onUpdateGoal: GoalModalProps['onUpdateGoal'],
) => {
  const barWidth = useRef(0);
  const [lowMarker, setLowMarker] = useState(0);
  const [clearMarker, setClearMarker] = useState(0);
  const [tooltip, setTooltip] = useState<null | 'low' | 'clear' | 'stretch'>(null);
  const tiers = useGoalTiers(habit);

  useEffect(() => {
    setLowMarker(tiers.markers.low);
    setClearMarker(tiers.markers.clear);
  }, [tiers.markers.low, tiers.markers.clear]);

  const handleBarLayout = (e: LayoutChangeEvent) => {
    barWidth.current = e.nativeEvent.layout.width;
  };

  const { onConfirm, pending, cancelPending, applyPending } = useGoalConfirm(
    tiers,
    habit?.id,
    setLowMarker,
    setClearMarker,
    onUpdateGoal,
  );
  const { lowPan, clearPan } = useMarkerPanResponders(
    tiers,
    barWidth,
    lowMarker,
    setLowMarker,
    clearMarker,
    setClearMarker,
    setTooltip,
    onConfirm,
  );

  return {
    ...tiers,
    lowMarker,
    clearMarker,
    stretchMarker: tiers.markers.stretch,
    tooltip,
    setTooltip,
    lowPan,
    clearPan,
    handleBarLayout,
    pendingGoalEdit: pending,
    cancelGoalEdit: cancelPending,
    applyGoalEdit: applyPending,
  };
};

const EDIT_TOGGLE_ICON_SIZE = 22;

interface EditToggleButtonProps {
  isEditing: boolean;
  onToggle: () => void;
}

const EditToggleButton = ({ isEditing, onToggle }: EditToggleButtonProps) => (
  <TouchableOpacity
    testID="goal-modal-edit-toggle"
    accessibilityRole="button"
    accessibilityLabel={isEditing ? 'Save and close edit mode' : 'Edit habit goals'}
    accessibilityState={{ expanded: isEditing }}
    onPress={onToggle}
    style={editToggleStyles.button}
  >
    {isEditing ? (
      <Check size={EDIT_TOGGLE_ICON_SIZE} color={colors.text.secondary} />
    ) : (
      <Pencil size={EDIT_TOGGLE_ICON_SIZE} color={colors.text.secondary} />
    )}
  </TouchableOpacity>
);

interface GoalModalHeaderProps {
  habit: NonNullable<GoalModalProps['habit']>;
  goalGroup: ApiGoalGroup | null;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  onClose: () => void;
  onUpdateHabit: GoalModalProps['onUpdateHabit'];
  isEditing: boolean;
  onToggleEdit: () => void;
}

const GoalModalHeader = ({
  habit,
  goalGroup,
  showEmojiSelector,
  setShowEmojiSelector,
  onClose,
  onUpdateHabit,
  isEditing,
  onToggleEdit,
}: GoalModalHeaderProps) => (
  <>
    <View style={styles.modalHeader}>
      <Text style={styles.modalTitle}>{habit.name}</Text>
      <EditToggleButton isEditing={isEditing} onToggle={onToggleEdit} />
      <TouchableOpacity onPress={() => setShowEmojiSelector(true)}>
        <Text style={styles.iconLarge}>{habit.icon}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onClose} style={styles.closeButton}>
        <Text style={styles.closeButtonText}>×</Text>
      </TouchableOpacity>
    </View>
    {goalGroup && (
      <View testID="goal-group-badge" style={goalGroupBadgeStyles.container}>
        <Text style={goalGroupBadgeStyles.text}>
          {goalGroup.icon ?? '📁'} {goalGroup.name}
        </Text>
      </View>
    )}
    {showEmojiSelector && (
      <View style={styles.emojiSelectorContainer}>
        <EmojiSelector
          onEmojiSelected={(emoji) => {
            onUpdateHabit({ ...habit, icon: emoji });
            setShowEmojiSelector(false);
          }}
          showSearchBar
          columns={6}
          emojiSize={28}
        />
      </View>
    )}
  </>
);

interface GoalModalBodyProps {
  habit: NonNullable<GoalModalProps['habit']>;
  onClose: () => void;
  onUpdateGoal: GoalModalProps['onUpdateGoal'];
  onUpdateGoalUnits: GoalModalProps['onUpdateGoalUnits'];
  onLogUnit: GoalModalProps['onLogUnit'];
  onUpdateHabit: GoalModalProps['onUpdateHabit'];
}

const buildProgressBarProps = (
  habit: NonNullable<GoalModalProps['habit']>,
  m: ReturnType<typeof useGoalMarkers>,
  tz: string,
) => ({
  progressPercentage: computeProgressPct(
    calculateTodaysProgress(habit, tz),
    m.lowGoal,
    m.stretchGoal,
  ),
  progressBarColor: getProgressBarColor(habit, tz),
  lowGoal: m.lowGoal,
  clearGoal: m.clearGoal,
  stretchGoal: m.stretchGoal,
  lowMarker: m.lowMarker,
  clearMarker: m.clearMarker,
  stretchMarker: m.stretchMarker,
  lowMet: m.lowGoal ? isGoalAchieved(m.lowGoal, habit, tz) : false,
  clearMet: m.clearGoal ? isGoalAchieved(m.clearGoal, habit, tz) : false,
  stretchMet: m.stretchGoal ? isGoalAchieved(m.stretchGoal, habit, tz) : false,
  tooltip: m.tooltip,
  setTooltip: m.setTooltip,
  lowPanHandlers: m.lowPan.panHandlers,
  clearPanHandlers: m.clearPan.panHandlers,
  onLayout: m.handleBarLayout,
});

/** Amount + date draft state for the Log Units control. */
const useLogState = (
  habit: NonNullable<GoalModalProps['habit']>,
  onLogUnit: GoalModalProps['onLogUnit'],
) => {
  const [logAmount, setLogAmount] = useState('1');
  const [logDate, setLogDate] = useState<Date>(() => new Date());

  const handleLogUnit = () => {
    if (!habit.id) return;
    onLogUnit(habit.id, parseFloat(logAmount) || 1, logDate);
    setLogAmount('1');
    setLogDate(new Date());
  };

  return { logAmount, setLogAmount, logDate, setLogDate, handleLogUnit };
};

const GoalEditConfirmDialog = ({
  m,
}: {
  m: ReturnType<typeof useGoalMarkers>;
}): React.JSX.Element => (
  <ConfirmDialog
    visible={!!m.pendingGoalEdit}
    title={m.pendingGoalEdit?.title ?? ''}
    message={m.pendingGoalEdit?.message}
    confirmLabel="Yes"
    cancelLabel="No"
    testID="goal-edit-confirm"
    confirmTestID="goal-edit-confirm-button"
    cancelTestID="goal-edit-cancel"
    onCancel={m.cancelGoalEdit}
    onConfirm={m.applyGoalEdit}
  />
);

const GoalModalBody = ({
  habit,
  onClose,
  onUpdateGoal,
  onUpdateGoalUnits,
  onLogUnit,
  onUpdateHabit,
}: GoalModalBodyProps) => {
  const [showEmojiSelector, setShowEmojiSelector] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const goalGroup = useGoalGroup(habit);
  const m = useGoalMarkers(habit, onUpdateGoal);
  const { userTimezone } = useAuth();
  const log = useLogState(habit, onLogUnit);

  return (
    <View style={[styles.modalContent, { borderTopColor: STAGE_COLORS[habit.stage] }]}>
      <GoalModalHeader
        habit={habit}
        goalGroup={goalGroup}
        showEmojiSelector={showEmojiSelector}
        setShowEmojiSelector={setShowEmojiSelector}
        onClose={onClose}
        onUpdateHabit={onUpdateHabit}
        isEditing={isEditing}
        onToggleEdit={() => setIsEditing((prev) => !prev)}
      />
      {/* Progress bar stays visible; the pencil only collapses the editor. */}
      <GoalProgressBar {...buildProgressBarProps(habit, m, userTimezone)} />
      {isEditing && (
        <View testID="goal-modal-edit-region">
          <GoalTargetEditor
            habit={habit}
            onUpdateGoal={onUpdateGoal}
            onUpdateGoalUnits={onUpdateGoalUnits}
          />
        </View>
      )}
      <LogUnitSection
        logAmount={log.logAmount}
        setLogAmount={log.setLogAmount}
        logDate={log.logDate}
        setLogDate={log.setLogDate}
        tz={userTimezone}
        onLog={log.handleLogUnit}
      />
      <GoalEditConfirmDialog m={m} />
    </View>
  );
};

export const GoalModal = ({
  visible,
  habit,
  onClose,
  onUpdateGoal,
  onUpdateGoalUnits,
  onLogUnit,
  onUpdateHabit,
}: GoalModalProps) => {
  if (!habit) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        {/* Sibling backdrop, rendered first so the body stacks above it on web. */}
        <Pressable
          testID="goal-modal-backdrop"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          accessibilityLabel="Close"
          accessibilityRole="button"
        />
        <GoalModalBody
          habit={habit}
          onClose={onClose}
          onUpdateGoal={onUpdateGoal}
          onUpdateGoalUnits={onUpdateGoalUnits}
          onLogUnit={onLogUnit}
          onUpdateHabit={onUpdateHabit}
        />
      </View>
    </Modal>
  );
};

const goalGroupBadgeStyles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    backgroundColor: '#f0ede6',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  text: {
    fontSize: 12,
    color: '#555',
    fontStyle: 'italic',
  },
});

const editToggleStyles = StyleSheet.create({
  button: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
});

export default GoalModal;
