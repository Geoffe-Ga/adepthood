import { Check, Pencil } from 'lucide-react-native';
import React, { useState, useRef, useEffect } from 'react';
import {
  Alert,
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
import { useAuth } from '../../../context/AuthContext';
import { colors, SPACING, STAGE_COLORS, shadows, touchTarget } from '../../../design/tokens';
import { TARGET_UNITS, FREQUENCY_UNITS } from '../constants';
import styles from '../Habits.styles';
import type { GoalModalProps, Goal } from '../Habits.types';
import {
  getMarkerPositions,
  getProgressBarColor,
  clampPercentage,
  getTierColor,
  getGoalTarget,
  calculateTodaysProgress,
} from '../HabitUtils';

const markerContainerStyle = (leftPct: number, z: number): ViewStyle => ({
  position: 'absolute',
  left: `${clampPercentage(leftPct)}%` as DimensionValue,
  top: -6,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  zIndex: z,
  alignItems: 'center',
});

const circleStyle = (color: string): ViewStyle => ({
  width: 12,
  height: 12,
  borderRadius: 6,
  backgroundColor: '#fffdf7',
  borderWidth: 2,
  borderColor: color,
});

const labelContainerStyle = (leftPct: number, z: number): ViewStyle => ({
  position: 'absolute',
  left: `${clampPercentage(leftPct)}%` as DimensionValue,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  zIndex: z,
  backgroundColor: '#fffdf7',
  paddingHorizontal: 2,
  borderRadius: 2,
});

const labelTextStyle = (color: string): TextStyle => ({ fontSize: 10, color });

const tooltipStyle = (color: string): ViewStyle => ({
  position: 'absolute',
  bottom: 16,
  backgroundColor: '#fffdf7',
  borderWidth: 1,
  borderColor: color,
  borderRadius: 4,
  paddingHorizontal: 4,
  paddingVertical: 2,
});

const tooltipTextStyle: TextStyle = {
  fontSize: 10,
  color: '#333',
  fontFamily: 'serif',
  fontStyle: 'italic',
  letterSpacing: 0.5,
};

const TIER_LABELS: Record<string, string> = {
  low: 'Low Grit',
  clear: 'Clear Goal',
  stretch: 'Stretch Goal',
};

const TIER_ABBREVS: Record<string, string> = { low: 'LG', clear: 'CG', stretch: 'SG' };

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

const GOAL_LABEL_TIERS = [
  { tier: 'low' as const, zIndex: 1 },
  { tier: 'clear' as const, zIndex: 2 },
  { tier: 'stretch' as const, zIndex: 3 },
] as const;

interface GoalMarkerItemProps {
  goal: Goal;
  tier: 'low' | 'clear' | 'stretch';
  position: number;
  zIndex: number;
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  panHandlers?: GestureResponderHandlers;
}

const GoalMarkerItem = ({
  goal,
  tier,
  position,
  zIndex,
  tooltip,
  setTooltip,
  panHandlers,
}: GoalMarkerItemProps) => {
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
      style={markerContainerStyle(position, zIndex)}
    >
      {tooltip === tier && (
        <View testID={`modal-tooltip-${tier}`} style={tooltipStyle(getTierColor(tier))}>
          <Text style={tooltipTextStyle}>{formatGoalTooltip(goal)}</Text>
        </View>
      )}
      <View style={circleStyle(getTierColor(tier))} />
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
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  lowPanHandlers: GestureResponderHandlers;
  clearPanHandlers: GestureResponderHandlers;
  goalsByTier: Record<string, Goal | undefined>;
  markerPositions: Record<string, number>;
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
  tooltip: 'low' | 'clear' | 'stretch' | null;
  setTooltip: (_v: 'low' | 'clear' | 'stretch' | null) => void;
  lowPanHandlers: GestureResponderHandlers;
  clearPanHandlers: GestureResponderHandlers;
}

const GoalMarkersRow = ({
  lowGoal,
  clearGoal,
  stretchGoal,
  lowMarker,
  clearMarker,
  stretchMarker,
  tooltip,
  setTooltip,
  lowPanHandlers,
  clearPanHandlers,
}: GoalMarkersRowProps) => (
  <>
    {lowGoal && (
      <GoalMarkerItem
        goal={lowGoal}
        tier="low"
        position={lowMarker}
        zIndex={1}
        tooltip={tooltip}
        setTooltip={setTooltip}
        panHandlers={lowPanHandlers}
      />
    )}
    {clearGoal && (
      <GoalMarkerItem
        goal={clearGoal}
        tier="clear"
        position={clearMarker}
        zIndex={2}
        tooltip={tooltip}
        setTooltip={setTooltip}
        panHandlers={clearPanHandlers}
      />
    )}
    {stretchGoal && (
      <GoalMarkerItem
        goal={stretchGoal}
        tier="stretch"
        position={stretchMarker}
        zIndex={3}
        tooltip={tooltip}
        setTooltip={setTooltip}
      />
    )}
  </>
);

const GoalLabelRow = ({
  goalsByTier,
  markerPositions,
}: {
  goalsByTier: Record<string, Goal | undefined>;
  markerPositions: Record<string, number>;
}) => (
  <View style={{ position: 'relative', marginTop: 4 }}>
    {GOAL_LABEL_TIERS.filter((t) => goalsByTier[t.tier]).map((t) => (
      <View key={t.tier} style={labelContainerStyle(markerPositions[t.tier]!, t.zIndex)}>
        <Text style={labelTextStyle(getTierColor(t.tier))}>{TIER_ABBREVS[t.tier]}</Text>
      </View>
    ))}
  </View>
);

const GoalProgressBar = ({
  progressPercentage,
  progressBarColor,
  lowGoal,
  clearGoal,
  stretchGoal,
  lowMarker,
  clearMarker,
  stretchMarker,
  tooltip,
  setTooltip,
  lowPanHandlers,
  clearPanHandlers,
  goalsByTier,
  markerPositions,
  onLayout,
}: GoalProgressBarProps) => (
  <View style={{ marginVertical: 16 }} onLayout={onLayout}>
    <View style={{ height: 12, position: 'relative' }}>
      <ProgressFill progressPercentage={progressPercentage} progressBarColor={progressBarColor} />
      <GoalMarkersRow
        lowGoal={lowGoal}
        clearGoal={clearGoal}
        stretchGoal={stretchGoal}
        lowMarker={lowMarker}
        clearMarker={clearMarker}
        stretchMarker={stretchMarker}
        tooltip={tooltip}
        setTooltip={setTooltip}
        lowPanHandlers={lowPanHandlers}
        clearPanHandlers={clearPanHandlers}
      />
    </View>
    <GoalLabelRow goalsByTier={goalsByTier} markerPositions={markerPositions} />
  </View>
);

interface LogUnitSectionProps {
  logAmount: string;
  setLogAmount: (_v: string) => void;
  onLog: () => void;
}

const LogUnitSection = ({ logAmount, setLogAmount, onLog }: LogUnitSectionProps) => (
  <View style={styles.actionButtons} testID="goal-modal-log-unit-section">
    <View style={styles.logUnitContainer}>
      <TextInput
        style={styles.logUnitInput}
        value={logAmount}
        onChangeText={setLogAmount}
        keyboardType="numeric"
      />
      <TouchableOpacity style={styles.logUnitButton} onPress={onLog}>
        <Text style={styles.logUnitButtonText}>Log Units</Text>
      </TouchableOpacity>
    </View>
  </View>
);

const TIER_ORDER = ['low', 'clear', 'stretch'] as const;

// Layout constants for the inline goal-target editor. Pulled out per
// CLAUDE.md ("Introduce magic numbers without named constants" is in the
// Must Never Do list); design-token equivalents (`SPACING`, `colors`,
// `BORDER_RADIUS`) are reused for everything that has one.
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
  onUpdateGoal: GoalModalProps['onUpdateGoal'];
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
 * goals. The fields are shared across tiers (``normalizeGoalUnits``
 * propagates a single edit to all three), so the editor surfaces them once
 * — but ``onUpdateGoal`` only PUTs the goal whose id is sent, so a commit
 * fans out one update per tier. Without the fan-out, the ``clear`` and
 * ``stretch`` rows would stay on their old units server-side even though
 * the local store displays them as normalized.
 */
const GoalUnitEditor = ({ goals, habitId, onUpdateGoal }: GoalUnitEditorProps) => {
  const reference = goals[0];
  const [freqDraft, setFreqDraft] = useState(String(reference.frequency));
  useEffect(() => {
    setFreqDraft(String(reference.frequency));
  }, [reference.frequency]);

  const commit = (changes: Partial<Pick<Goal, 'target_unit' | 'frequency' | 'frequency_unit'>>) => {
    for (const goal of goals) {
      onUpdateGoal(habitId, { ...goal, ...changes });
    }
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
}

/**
 * Inline goal-target editor surfaced in the GoalModal so mobile users have a
 * discoverable way to change a goal's numeric target. The pre-existing marker
 * drag is kept (desktop-friendly), but the marker hit area is 12px and never
 * triggered reliably under thumb input — closing the "no way to edit habit
 * goals on mobile" gap.
 */
const GoalTargetEditor = ({ habit, onUpdateGoal }: GoalTargetEditorProps) => {
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
      <GoalUnitEditor goals={nonEmptyGoals} habitId={habitId} onUpdateGoal={onUpdateGoal} />
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

const confirmGoalUpdate = (
  tier: 'low' | 'clear',
  percent: number,
  lowGoal: Goal | undefined,
  clearGoal: Goal | undefined,
  stretchGoal: Goal | undefined,
  habitId: number | undefined,
  markers: { low: number; clear: number },
  setLowMarker: (_v: number) => void,
  setClearMarker: (_v: number) => void,
  onUpdateGoal: GoalModalProps['onUpdateGoal'],
) => {
  const goal = tier === 'low' ? lowGoal : clearGoal;
  if (!goal || !habitId) return;
  const stretchTarget = stretchGoal ? getGoalTarget(stretchGoal) : goal.target;
  const newTarget = Math.max(1, Math.round((percent / 100) * stretchTarget));
  const tierLabel = tier === 'low' ? 'Low Grit' : 'Clear Goal';
  Alert.alert(
    `Edit ${tierLabel.split(' ')[0]} Goal`,
    `Edit the ${tierLabel} to be ${newTarget} ${goal.target_unit} ${goal.frequency_unit.replace('_', ' ')}?`,
    [
      {
        text: 'No',
        style: 'cancel',
        onPress: () => {
          if (tier === 'low') setLowMarker(markers.low);
          else setClearMarker(markers.clear);
        },
      },
      { text: 'Yes', onPress: () => onUpdateGoal(habitId, { ...goal, target: newTarget }) },
    ],
  );
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
  return (tier: 'low' | 'clear', percent: number) => {
    confirmGoalUpdate(
      tier,
      percent,
      tiers.lowGoal,
      tiers.clearGoal,
      tiers.stretchGoal,
      habitId,
      tiers.markers,
      setLowMarker,
      setClearMarker,
      onUpdateGoal,
    );
  };
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

  const onConfirm = useGoalConfirm(tiers, habit?.id, setLowMarker, setClearMarker, onUpdateGoal);
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
  onLogUnit: GoalModalProps['onLogUnit'];
  onUpdateHabit: GoalModalProps['onUpdateHabit'];
}

const buildGoalMaps = (m: ReturnType<typeof useGoalMarkers>) => ({
  goalsByTier: { low: m.lowGoal, clear: m.clearGoal, stretch: m.stretchGoal } as Record<
    string,
    Goal | undefined
  >,
  markerPositions: {
    low: m.lowMarker,
    clear: m.clearMarker,
    stretch: m.stretchMarker,
  } as Record<string, number>,
});

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
  tooltip: m.tooltip,
  setTooltip: m.setTooltip,
  lowPanHandlers: m.lowPan.panHandlers,
  clearPanHandlers: m.clearPan.panHandlers,
  ...buildGoalMaps(m),
  onLayout: m.handleBarLayout,
});

const GoalModalBody = ({
  habit,
  onClose,
  onUpdateGoal,
  onLogUnit,
  onUpdateHabit,
}: GoalModalBodyProps) => {
  const [logAmount, setLogAmount] = useState('1');
  const [showEmojiSelector, setShowEmojiSelector] = useState(false);
  // Inline edit mode is collapsed by default so the modal opens as a quick
  // log-units affordance; tapping the pencil expands the goal editor for
  // intentional changes, and the checkmark collapses it back. Per-field
  // commits inside the editor already persist optimistically, so the
  // checkmark only needs to flip the local view state.
  const [isEditing, setIsEditing] = useState(false);
  const goalGroup = useGoalGroup(habit);
  const m = useGoalMarkers(habit, onUpdateGoal);
  const { userTimezone } = useAuth();

  const handleLogUnit = () => {
    if (!habit.id) return;
    onLogUnit(habit.id, parseFloat(logAmount) || 1);
    setLogAmount('1');
  };

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
      {isEditing && (
        <View testID="goal-modal-edit-region">
          <GoalProgressBar {...buildProgressBarProps(habit, m, userTimezone)} />
          <GoalTargetEditor habit={habit} onUpdateGoal={onUpdateGoal} />
        </View>
      )}
      <LogUnitSection logAmount={logAmount} setLogAmount={setLogAmount} onLog={handleLogUnit} />
    </View>
  );
};

export const GoalModal = ({
  visible,
  habit,
  onClose,
  onUpdateGoal,
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
