import Slider from '@react-native-community/slider';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  LayoutAnimation,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import { goalGroups as goalGroupsApi, type ApiGoalGroup } from '../../../api';
import DatePicker, { parseISODate, toISODate } from '../../../components/DatePicker';
import { colors, STAGE_COLORS } from '../../../design/tokens';
import { selectProgramStartDate, useProgramStore } from '../../../store/useProgramStore';
import { MAX_HABITS } from '../constants';
import styles from '../Habits.styles';
import type { Habit, HabitMergePlan, OnboardingHabit, OnboardingModalProps } from '../Habits.types';
import { calculateHabitStartDate, calculateNetEnergy, stageAtIndex } from '../HabitUtils';

import { ConfirmDialog } from './ConfirmDialog';
import HabitEmojiPicker from './HabitEmojiPicker';
import {
  ADD_HABITS_STEP,
  buildMergePlan,
  buildReviewRows,
  entryStepFor,
  originHabitId,
  releaseRow,
  releasedRows,
  REVIEW_STEP,
  setDestination,
  syncPool,
  toggleKeep,
  type ReviewDestination,
  type ReviewRow,
} from './onboardingReview';
import OnboardingReviewStep from './OnboardingReviewStep';
import { HABIT_NAME_MAX_LENGTH, validateAndAddHabit } from './onboardingValidation';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const REVEAL_STAGGER_MS = 150;
const REVEAL_SORT_PAUSE_MS = 500;

type RevealPhase = 'idle' | 'showing-scores' | 'sorting' | 'complete';

const sortByNetEnergy = (habits: OnboardingHabit[]): OnboardingHabit[] =>
  [...habits].sort((a, b) => {
    const netA = calculateNetEnergy(a.energy_cost, a.energy_return);
    const netB = calculateNetEnergy(b.energy_cost, b.energy_return);
    if (netA !== netB) return netB - netA;
    if (a.energy_cost !== b.energy_cost) return a.energy_cost - b.energy_cost;
    return b.energy_return - a.energy_return;
  });

/**
 * Lay the pool out along the program cadence -- except where a habit already
 * has a beginning behind it. The merge refuses to restamp such a row, on the
 * grounds that moving a started habit's date is a reset rather than a
 * re-rating, so a reorder step that showed the staggered date anyway would be
 * promising a day the save is about to discard. It keeps its own place in the
 * order; it does not take the order's date.
 */
const assignDatesAndStages = (habits: OnboardingHabit[], startDate: Date): OnboardingHabit[] =>
  habits.map((habit, index) =>
    habit.keepsOwnBeginning === true
      ? habit
      : {
          ...habit,
          start_date: calculateHabitStartDate(startDate, index),
          stage: stageAtIndex(index),
        },
  );

interface HabitChipProps {
  habit: OnboardingHabit;
  onRemove: () => void;
}

const HabitChip = ({ habit, onRemove }: HabitChipProps) => (
  <View style={styles.habitChip} testID="habit-chip">
    <Text style={styles.habitChipText}>
      {habit.icon} {habit.name}
    </Text>
    <TouchableOpacity style={styles.removeHabitChip} onPress={onRemove}>
      <Text style={styles.removeHabitChipText}>×</Text>
    </TouchableOpacity>
  </View>
);

interface EnergySliderTileProps {
  habit: OnboardingHabit;
  index: number;
  type: 'cost' | 'return';
  onValueChange: (_index: number, _type: 'cost' | 'return', _value: number) => void;
}

const EnergySliderTile = ({ habit, index, type, onValueChange }: EnergySliderTileProps) => {
  const value = type === 'cost' ? habit.energy_cost : habit.energy_return;
  return (
    <View style={styles.energyTile} testID={`energy-tile-${index}`}>
      <Text style={styles.energyTileName}>
        {habit.icon} {habit.name}
      </Text>
      <View style={styles.energySliderRow}>
        <View style={styles.energySliderContainer}>
          <Slider
            testID={`${type}-slider`}
            minimumValue={0}
            maximumValue={10}
            step={1}
            value={value}
            onValueChange={(v) => onValueChange(index, type, v)}
            minimumTrackTintColor={colors.secondary}
            maximumTrackTintColor={colors.mystical.glowLight}
            thumbTintColor={colors.secondary}
            style={[styles.energySlider, Platform.OS === 'web' && styles.energySliderWeb]}
          />
        </View>
        <Text style={styles.sliderValue}>{value}</Text>
      </View>
    </View>
  );
};

interface ReorderItemProps {
  item: OnboardingHabit;
  index: number;
  drag: () => void;
  isActive: boolean;
  onEditIcon: (_index: number) => void;
}

const ReorderItem = ({ item, index, drag, isActive, onEditIcon }: ReorderItemProps) => {
  const stage = stageAtIndex(index);
  const color = STAGE_COLORS[stage] || '#ccc';
  const startDrag = Gesture.Pan().onBegin(() => drag());

  return (
    <GestureDetector gesture={startDrag}>
      <Animated.View
        testID={`reorder-item-${item.id}`}
        style={[
          styles.habitListItem,
          isActive && { backgroundColor: '#eaeaea' },
          { borderLeftColor: color, borderLeftWidth: 4 },
        ]}
      >
        <View style={styles.habitDragInfo}>
          <View accessibilityLabel={`Reorder ${item.name}`} style={styles.dragHandle}>
            <Text style={styles.dragHandleText}>≡</Text>
          </View>
          <Text style={styles.habitListItemDate}>
            {new Date(item.start_date).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </Text>
          <Text style={styles.habitListItemText}>
            {item.icon} {item.name}
          </Text>
          <TouchableOpacity style={styles.iconEditButton} onPress={() => onEditIcon(index)}>
            <Text style={styles.iconEditButtonText}>📝</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.habitEnergyInfo}>
          <Text style={styles.habitEnergyText}>
            Cost: {item.energy_cost} | Return: {item.energy_return} | Net:{' '}
            {calculateNetEnergy(item.energy_cost, item.energy_return)}
          </Text>
        </View>
      </Animated.View>
    </GestureDetector>
  );
};

interface TemplatePickerTileProps {
  habit: OnboardingHabit;
  index: number;
  templates: ApiGoalGroup[];
  onAssign: (_index: number, _groupId: number | null) => void;
}

const TemplatePickerTile = ({ habit, index, templates, onAssign }: TemplatePickerTileProps) => (
  <View style={styles.energyTile} testID={`template-tile-${index}`}>
    <Text style={styles.energyTileName}>
      {habit.icon} {habit.name}
    </Text>
    <View style={templatePickerStyles.options}>
      <TouchableOpacity
        testID={`template-none-${index}`}
        style={[
          templatePickerStyles.option,
          habit.goal_group_id == null && templatePickerStyles.optionSelected,
        ]}
        onPress={() => onAssign(index, null)}
      >
        <Text style={templatePickerStyles.optionText}>None</Text>
      </TouchableOpacity>
      {templates.map((template) => (
        <TouchableOpacity
          key={template.id}
          testID={`template-${template.id}-${index}`}
          style={[
            templatePickerStyles.option,
            habit.goal_group_id === template.id && templatePickerStyles.optionSelected,
          ]}
          onPress={() => onAssign(index, template.id)}
        >
          <Text style={templatePickerStyles.optionText}>
            {template.icon ?? ''} {template.name}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

const ENERGY_SUBTITLES: Record<string, string> = {
  cost: '0 = effortless, easy as breathing. 10 = effort so big you might dread it.',
  return:
    '0 = almost no change to your overall vibe. 10 = lights you up and feels deeply rewarding.',
};

interface AddHabitsStepProps {
  habits: OnboardingHabit[];
  newHabitName: string;
  setNewHabitName: (_v: string) => void;
  error: string;
  inputRef: React.RefObject<TextInput | null>;
  onAddHabit: () => void;
  onKeyPress: (
    _e: NativeSyntheticEvent<TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean }>,
  ) => void;
  onContinuePress: () => void;
  onRemoveHabit: (_index: number) => void;
  /** Present only for a returning user, whose review step this step now follows. */
  onBack?: () => void;
  /** Present only when an empty pool is a whole answer -- see ``AddHabitsAction``. */
  onFinish?: () => void;
}

const HabitInputRow = ({
  newHabitName,
  setNewHabitName,
  inputRef,
  onAddHabit,
  onKeyPress,
  isAddDisabled,
}: {
  newHabitName: string;
  setNewHabitName: (_v: string) => void;
  inputRef: React.RefObject<TextInput | null>;
  onAddHabit: () => void;
  onKeyPress: AddHabitsStepProps['onKeyPress'];
  isAddDisabled: boolean;
}) => (
  <View style={styles.addHabitContainer}>
    <TextInput
      ref={inputRef}
      style={styles.addHabitInput}
      value={newHabitName}
      onChangeText={setNewHabitName}
      placeholder="Enter habit name"
      blurOnSubmit={false}
      onKeyPress={onKeyPress}
      maxLength={HABIT_NAME_MAX_LENGTH}
      testID="habit-input"
    />
    <TouchableOpacity
      testID="add-habit-button"
      style={[styles.addHabitButton, isAddDisabled && styles.disabledButton]}
      onPress={onAddHabit}
      disabled={isAddDisabled}
    >
      <Text style={styles.addHabitButtonText}>+</Text>
    </TouchableOpacity>
  </View>
);

/**
 * The step's forward action, which is not always "continue".
 *
 * Bringing every habit along and adding nothing new is a whole answer -- these
 * are all already mine, and I am taking nothing on this lap -- but it leaves the
 * pool empty, and the four steps after this one are all about the pool. A
 * disabled Continue would be a dead end behind a fork the review step invited
 * the user into, so the pass finishes here instead. A first run has no such
 * answer to give: an empty pool there has decided nothing, so the button stays
 * disabled exactly as it always was.
 */
const AddHabitsAction = ({
  count,
  onContinuePress,
  onFinish,
}: {
  count: number;
  onContinuePress: () => void;
  onFinish?: () => void;
}) => {
  if (count === 0 && onFinish !== undefined) {
    return (
      <TouchableOpacity
        testID="finish-without-adding"
        style={styles.onboardingContinueButton}
        onPress={onFinish}
      >
        <Text style={styles.onboardingContinueButtonText}>Done</Text>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      testID="continue-button"
      style={[styles.onboardingContinueButton, count === 0 && styles.disabledButton]}
      onPress={onContinuePress}
      disabled={count === 0}
    >
      <Text style={styles.onboardingContinueButtonText}>Continue</Text>
    </TouchableOpacity>
  );
};

const AddHabitsFooter = ({
  count,
  onContinuePress,
  onBack,
  onFinish,
}: {
  count: number;
  onContinuePress: () => void;
  onBack?: () => void;
  onFinish?: () => void;
}) => (
  <View style={styles.bottomContainer}>
    {onBack !== undefined && (
      <TouchableOpacity
        testID="add-habits-back"
        style={styles.onboardingBackButton}
        onPress={onBack}
      >
        <Text style={styles.onboardingBackButtonText}>Back</Text>
      </TouchableOpacity>
    )}
    <Text style={styles.habitCount} testID="habit-count">{`${count} / ${MAX_HABITS}`}</Text>
    <AddHabitsAction count={count} onContinuePress={onContinuePress} onFinish={onFinish} />
  </View>
);

const AddHabitsStep = ({
  habits,
  newHabitName,
  setNewHabitName,
  error,
  inputRef,
  onAddHabit,
  onKeyPress,
  onContinuePress,
  onRemoveHabit,
  onBack,
  onFinish,
}: AddHabitsStepProps) => (
  <SafeAreaView style={styles.onboardingStep}>
    <Text style={styles.onboardingTitle}>Create Your Habits</Text>
    <Text style={styles.onboardingSubtitle}>Enter all the habits you'd like to build or break</Text>
    <HabitInputRow
      newHabitName={newHabitName}
      setNewHabitName={setNewHabitName}
      inputRef={inputRef}
      onAddHabit={onAddHabit}
      onKeyPress={onKeyPress}
      isAddDisabled={newHabitName.trim() === '' || habits.length >= MAX_HABITS}
    />
    {error !== '' && (
      <Text style={styles.habitError} testID="habit-error">
        {error}
      </Text>
    )}
    <ScrollView style={styles.habitsList} contentContainerStyle={styles.habitChipContainer}>
      {habits.map((item, index) => (
        <HabitChip key={index} habit={item} onRemove={() => onRemoveHabit(index)} />
      ))}
    </ScrollView>
    <AddHabitsFooter
      count={habits.length}
      onContinuePress={onContinuePress}
      onBack={onBack}
      onFinish={onFinish}
    />
  </SafeAreaView>
);

interface EnergyStepProps {
  type: 'cost' | 'return';
  habits: OnboardingHabit[];
  scrollRef: React.RefObject<ScrollView | null>;
  onBack: () => void;
  onContinue: () => void;
  onValueChange: (_index: number, _type: 'cost' | 'return', _value: number) => void;
}

const EnergyStep = ({
  type,
  habits,
  scrollRef,
  onBack,
  onContinue,
  onValueChange,
}: EnergyStepProps) => (
  <SafeAreaView style={styles.onboardingStep}>
    <ScrollView ref={scrollRef}>
      <Text style={styles.onboardingTitle}>
        {type === 'cost' ? 'Energy Cost' : 'Energy Return'}
      </Text>
      <Text style={styles.onboardingSubtitle}>{ENERGY_SUBTITLES[type]}</Text>
      {habits.map((habit, index) => (
        <EnergySliderTile
          key={index}
          habit={habit}
          index={index}
          type={type}
          onValueChange={onValueChange}
        />
      ))}
    </ScrollView>
    <View style={styles.onboardingFooter}>
      <TouchableOpacity style={styles.onboardingBackButton} onPress={onBack}>
        <Text style={styles.onboardingBackButtonText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="continue-button"
        style={[styles.onboardingContinueButton, styles.footerContinue]}
        onPress={onContinue}
        disabled={habits.length === 0}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  </SafeAreaView>
);

interface ReorderHeaderProps {
  startDate: Date;
  onDateChange: (_iso: string) => void;
  postReveal?: boolean;
}

/**
 * The floor the picker offers. Today, ordinarily: a program cannot begin before
 * the user is standing here. But a returning user's picker opens on the day
 * their program already began, which is usually in the past, and a floor above
 * the value on display would refuse to give back the date it was showing a
 * moment ago.
 */
const earliestSelectable = (startDate: Date): Date => {
  const today = new Date();
  return startDate < today ? startDate : today;
};

const ReorderHeader = ({ startDate, onDateChange, postReveal }: ReorderHeaderProps) => (
  <>
    <Text style={styles.onboardingTitle}>
      {postReveal ? 'Your optimal habit order:' : 'Reorder Your Habits'}
    </Text>
    <Text style={styles.onboardingSubtitle}>
      {postReveal
        ? 'Sorted by energy efficiency. You can drag to reorder if needed.'
        : 'Habits are ordered by energy efficiency. You can drag to reorder if needed.'}
    </Text>
    <View style={styles.startDateContainer}>
      <Text style={styles.startDateLabel}>Beige begins on:</Text>
      <DatePicker
        value={toISODate(startDate)}
        minDate={toISODate(earliestSelectable(startDate))}
        onChange={onDateChange}
      />
    </View>
  </>
);

const ContinueToTemplatesButton = ({ onPress }: { onPress: () => void }) => (
  <TouchableOpacity
    testID="continue-to-templates"
    style={styles.onboardingContinueButton}
    onPress={onPress}
  >
    <Text style={styles.onboardingContinueButtonText}>Continue</Text>
  </TouchableOpacity>
);

interface RevealStepProps {
  habits: OnboardingHabit[];
  revealedScoreCount: number;
  revealPhase: RevealPhase;
}

const RevealStep = ({ habits, revealedScoreCount, revealPhase }: RevealStepProps) => {
  const headerText =
    revealPhase === 'complete' ? 'Your optimal habit order:' : 'Calculating your energy order...';

  return (
    <SafeAreaView style={styles.onboardingStep}>
      <ScrollView>
        <Text style={styles.onboardingTitle}>{headerText}</Text>
        <Text style={styles.onboardingSubtitle}>
          {revealPhase === 'complete'
            ? 'Habits sorted by energy efficiency — highest net energy first.'
            : 'Analyzing your energy data...'}
        </Text>
        {habits.map((habit, index) => (
          <View key={habit.id} style={revealStyles.tile}>
            <Text style={revealStyles.habitName}>
              {habit.icon} {habit.name}
            </Text>
            {index < revealedScoreCount && (
              <Text testID="reveal-score" style={revealStyles.score}>
                Net: {calculateNetEnergy(habit.energy_cost, habit.energy_return)}
              </Text>
            )}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
};

interface ReorderStepProps {
  habits: OnboardingHabit[];
  startDate: Date;
  showEmojiPicker: boolean;
  selectedHabitIndex: number | null;
  postReveal?: boolean;
  onDragEnd: (_data: { data: OnboardingHabit[] }) => void;
  onEditIcon: (_index: number) => void;
  onDateChange: (_iso: string) => void;
  onGoToTemplates: () => void;
  onCloseEmoji: () => void;
  onEmojiSelected: (_emoji: string) => void;
}

const renderReorderItem =
  (onEditIcon: (_index: number) => void) =>
  ({ item, drag, isActive, getIndex }: RenderItemParams<OnboardingHabit>) => (
    <ReorderItem
      item={item}
      index={getIndex() ?? 0}
      drag={drag}
      isActive={isActive}
      onEditIcon={onEditIcon}
    />
  );

const ReorderStep = ({
  habits,
  startDate,
  showEmojiPicker,
  selectedHabitIndex,
  postReveal,
  onDragEnd,
  onEditIcon,
  onDateChange,
  onGoToTemplates,
  onCloseEmoji,
  onEmojiSelected,
}: ReorderStepProps) => (
  <View style={styles.onboardingStep}>
    <View style={styles.reorderListWindow}>
      <DraggableFlatList
        testID="reorder-list"
        data={habits}
        keyExtractor={(item) => item.id}
        activationDistance={8}
        contentContainerStyle={styles.habitsListContent}
        scrollEnabled
        nestedScrollEnabled
        autoscrollThreshold={40}
        autoscrollSpeed={300}
        ListHeaderComponent={
          <ReorderHeader
            startDate={startDate}
            onDateChange={onDateChange}
            postReveal={postReveal}
          />
        }
        ListFooterComponent={<ContinueToTemplatesButton onPress={onGoToTemplates} />}
        renderItem={renderReorderItem(onEditIcon)}
        onDragEnd={onDragEnd}
      />
    </View>
    <HabitEmojiPicker
      visible={showEmojiPicker && selectedHabitIndex !== null}
      onSelect={onEmojiSelected}
      onClose={onCloseEmoji}
    />
  </View>
);

interface TemplateStepProps {
  habits: OnboardingHabit[];
  scrollRef: React.RefObject<ScrollView | null>;
  goalGroupTemplates: ApiGoalGroup[];
  onAssign: (_habitIndex: number, _groupId: number | null) => void;
  onBack: () => void;
  onFinish: () => void;
}

const TemplateStep = ({
  habits,
  scrollRef,
  goalGroupTemplates,
  onAssign,
  onBack,
  onFinish,
}: TemplateStepProps) => (
  <SafeAreaView style={styles.onboardingStep}>
    <ScrollView ref={scrollRef}>
      <Text style={styles.onboardingTitle}>Goal Templates</Text>
      <Text style={styles.onboardingSubtitle}>
        Optionally assign a goal group template to each habit. Templates pre-fill low, clear, and
        stretch goal tiers.
      </Text>
      {habits.map((habit, index) => (
        <TemplatePickerTile
          key={habit.id}
          habit={habit}
          index={index}
          templates={goalGroupTemplates}
          onAssign={onAssign}
        />
      ))}
    </ScrollView>
    <View style={styles.onboardingFooter}>
      <TouchableOpacity style={styles.onboardingBackButton} onPress={onBack}>
        <Text style={styles.onboardingBackButtonText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="finish-setup"
        style={[styles.onboardingContinueButton, styles.footerContinue]}
        onPress={onFinish}
      >
        <Text style={styles.onboardingContinueButtonText}>Done</Text>
      </TouchableOpacity>
    </View>
  </SafeAreaView>
);

const useOnboardingEffects = (
  step: number,
  scrollRef: React.RefObject<ScrollView | null>,
  prepareHabitsForReorder: () => void,
) => {
  useEffect(() => {
    if (step === 2 || step === 3) scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step, scrollRef]);

  useEffect(() => {
    if (Platform.OS === 'web' && step === 3) {
      const handler = (e: KeyboardEvent) => {
        if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
        prepareHabitsForReorder();
      };
      // Captured, not re-resolved: a cleanup that reaches for the `document`
      // global runs at teardown, when the DOM may already be gone, and then
      // throws instead of quietly no-opping. Same hole as
      // Journal/webSelectionListener.ts; React 19 runs cleanups where 18 did not.
      const doc = document;
      doc.addEventListener('keydown', handler);
      return () => doc.removeEventListener('keydown', handler);
    }
  }, [step, prepareHabitsForReorder]);
};

const useEmojiActions = (
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>,
  selectedHabitIndex: number | null,
  setSelectedHabitIndex: React.Dispatch<React.SetStateAction<number | null>>,
  setShowEmojiPicker: React.Dispatch<React.SetStateAction<boolean>>,
) => ({
  openEmojiForIndex: (index: number) => {
    setSelectedHabitIndex(index);
    setShowEmojiPicker(true);
  },
  closeEmoji: () => {
    setShowEmojiPicker(false);
    setSelectedHabitIndex(null);
  },
  onEmojiSelected: (emoji: string) => {
    if (selectedHabitIndex !== null)
      setHabits((prev) =>
        prev.map((habit, i) => (i === selectedHabitIndex ? { ...habit, icon: emoji } : habit)),
      );
    setShowEmojiPicker(false);
    setSelectedHabitIndex(null);
  },
});

const useOnboardingActions = (
  habits: OnboardingHabit[],
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>,
  startDate: Date,
  setStartDate: React.Dispatch<React.SetStateAction<Date>>,
  selectedHabitIndex: number | null,
  setSelectedHabitIndex: React.Dispatch<React.SetStateAction<number | null>>,
  setShowEmojiPicker: React.Dispatch<React.SetStateAction<boolean>>,
) => {
  const updateHabitEnergy = (index: number, type: 'cost' | 'return', value: number) => {
    if (value < 0 || value > 10) return;
    setHabits((prev) =>
      prev.map((habit, i) =>
        i === index ? { ...habit, [`energy_${type}`]: Math.round(value) } : habit,
      ),
    );
  };
  const handleDragEnd = ({ data }: { data: OnboardingHabit[] }) => {
    setHabits(assignDatesAndStages(data, startDate));
  };
  const handleDateChange = (iso: string) => {
    const d = parseISODate(iso);
    setStartDate(d);
    setHabits((prev) => assignDatesAndStages(prev, d));
  };
  const assignTemplate = (habitIndex: number, groupId: number | null) => {
    setHabits((prev) =>
      prev.map((habit, i) => (i === habitIndex ? { ...habit, goal_group_id: groupId } : habit)),
    );
  };
  const removeHabit = (index: number) => {
    setHabits((prev) => prev.filter((_, i) => i !== index));
  };
  const emoji = useEmojiActions(
    setHabits,
    selectedHabitIndex,
    setSelectedHabitIndex,
    setShowEmojiPicker,
  );

  return {
    updateHabitEnergy,
    handleDragEnd,
    handleDateChange,
    assignTemplate,
    removeHabit,
    ...emoji,
  };
};

const useHabitInput = (
  habits: OnboardingHabit[],
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>,
  setStep: React.Dispatch<React.SetStateAction<number>>,
) => {
  const [newHabitName, setNewHabitName] = useState('');
  const [error, setError] = useState('');
  const [showCountWarning, setShowCountWarning] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handleAddHabit = () => {
    const outcome = validateAndAddHabit(newHabitName, habits);
    if (outcome.kind === 'add') {
      setHabits((prev) => [...prev, outcome.habit]);
      setNewHabitName('');
      setError('');
      inputRef.current?.focus();
      return;
    }
    if (outcome.kind === 'error') setError(outcome.message);
  };

  const handleKeyPress = (
    e: NativeSyntheticEvent<TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean }>,
  ) => {
    if (e.nativeEvent.key !== 'Enter') return;
    if (e.nativeEvent.metaKey || e.nativeEvent.ctrlKey) {
      if (habits.length > 0) setStep(2);
    } else handleAddHabit();
  };

  const handleContinuePress = () => {
    if (habits.length < MAX_HABITS) setShowCountWarning(true);
    else setStep(2);
  };

  return {
    newHabitName,
    setNewHabitName,
    error,
    inputRef,
    showCountWarning,
    setShowCountWarning,
    handleAddHabit,
    handleKeyPress,
    handleContinuePress,
  };
};

const useOnboardingNavigation = (
  buildResult: () => readonly OnboardingHabit[] | HabitMergePlan,
  resetToEntry: () => void,
  setStep: React.Dispatch<React.SetStateAction<number>>,
  setGoalGroupTemplates: React.Dispatch<React.SetStateAction<ApiGoalGroup[]>>,
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
) => {
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const handleAttemptClose = () => setShowDiscardDialog(true);
  const handleConfirmDiscard = () => {
    resetToEntry();
    setShowDiscardDialog(false);
    onClose();
  };
  // BUG-FE-HABIT-103: track in-flight templates request so a second tap
  // (or a stale callback after navigation) cannot route a successful
  // fetch into the error branch or step the user past 5 unintentionally.
  const templatesRequestRef = useRef(0);
  const handleGoToTemplates = () => {
    const myRequest = templatesRequestRef.current + 1;
    templatesRequestRef.current = myRequest;
    goalGroupsApi
      .list()
      .then((templates) => {
        if (templatesRequestRef.current !== myRequest) return;
        setGoalGroupTemplates(templates.filter((t) => t.shared_template));
        setStep(5);
      })
      .catch(() => {
        if (templatesRequestRef.current !== myRequest) return;
        onSaveHabits(buildResult());
        onClose();
      });
  };
  // BUG-FE-HABIT-101: reset onboarding state on finish so reopening the
  // modal starts at the step the caller's own state calls for -- an empty
  // add-habits step on a first run, the review step for a user who still has
  // habits to be asked about -- instead of resuming at step 5 with
  // already-persisted habits.
  const handleFinish = () => {
    onSaveHabits(buildResult());
    resetToEntry();
    onClose();
  };
  return {
    showDiscardDialog,
    setShowDiscardDialog,
    handleAttemptClose,
    handleConfirmDiscard,
    handleGoToTemplates,
    handleFinish,
  };
};

const scheduleScoreReveals = (
  habitCount: number,
  setRevealedScoreCount: React.Dispatch<React.SetStateAction<number>>,
  timers: ReturnType<typeof setTimeout>[],
) => {
  for (let i = 0; i < habitCount; i++) {
    const timer = setTimeout(() => setRevealedScoreCount(i + 1), REVEAL_STAGGER_MS * (i + 1));
    timers.push(timer);
  }
};

const scheduleSortAndComplete = (
  delayMs: number,
  setRevealPhase: React.Dispatch<React.SetStateAction<RevealPhase>>,
  applySort: () => void,
  timers: ReturnType<typeof setTimeout>[],
) => {
  const sortTimer = setTimeout(() => {
    setRevealPhase('sorting');
    LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
    applySort();
    timers.push(setTimeout(() => setRevealPhase('complete'), 100));
  }, delayMs);
  timers.push(sortTimer);
};

const useRevealAnimation = (
  step: number,
  unsortedHabits: OnboardingHabit[],
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>,
  startDate: Date,
) => {
  const [revealPhase, setRevealPhase] = useState<RevealPhase>('idle');
  const [revealedScoreCount, setRevealedScoreCount] = useState(0);
  const hasRevealedOnce = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const startReveal = useCallback(() => {
    if (hasRevealedOnce.current) return false;
    hasRevealedOnce.current = true;
    setRevealPhase('showing-scores');
    setRevealedScoreCount(0);
    clearTimers();

    const habitCount = unsortedHabits.length;
    scheduleScoreReveals(habitCount, setRevealedScoreCount, timersRef.current);

    const applySort = () =>
      setHabits(assignDatesAndStages(sortByNetEnergy(unsortedHabits), startDate));
    const sortDelay = REVEAL_STAGGER_MS * habitCount + REVEAL_SORT_PAUSE_MS;
    scheduleSortAndComplete(sortDelay, setRevealPhase, applySort, timersRef.current);

    return true;
  }, [unsortedHabits, startDate, setHabits, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (step !== 4) {
      setRevealPhase('idle');
      setRevealedScoreCount(0);
    }
  }, [step]);

  return {
    revealPhase,
    revealedScoreCount,
    isRevealing: revealPhase !== 'idle' && revealPhase !== 'complete',
    startReveal,
    hasRevealedOnce,
  };
};

const useRevealIntegration = (
  step: number,
  habits: OnboardingHabit[],
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>,
  setStep: React.Dispatch<React.SetStateAction<number>>,
  startDate: Date,
) => {
  const [unsortedHabits, setUnsortedHabits] = useState<OnboardingHabit[]>([]);
  const reveal = useRevealAnimation(step, unsortedHabits, setHabits, startDate);

  const prepareHabitsForReorder = useCallback(() => {
    if (reveal.hasRevealedOnce.current) {
      setHabits(assignDatesAndStages(sortByNetEnergy(habits), startDate));
    } else {
      setUnsortedHabits([...habits]);
    }
    setStep(4);
  }, [habits, startDate, reveal.hasRevealedOnce, setHabits, setStep]);

  useEffect(() => {
    if (step === 4 && unsortedHabits.length > 0 && !reveal.hasRevealedOnce.current) {
      reveal.startReveal();
    }
  }, [step, unsortedHabits, reveal]);

  return { reveal, unsortedHabits, prepareHabitsForReorder };
};

/**
 * Where the modal opens, for a user with habits and for one without.
 *
 * The start date is seeded from the program anchor the user already chose, not
 * from today. Saving a scaffolding pass is an explicit anchor write -- it
 * records a day the user picked -- so a picker that quietly re-answers it with
 * today moves the whole program calendar for a returning user who never touched
 * it. Today is right only when there is no answer yet.
 */
const entryStateFor = (existingHabits: readonly Habit[], anchor: Date | null) => {
  const rows = buildReviewRows(existingHabits);
  return { rows, step: entryStepFor(rows), startDate: anchor ?? new Date() };
};

type EntryState = ReturnType<typeof entryStateFor>;

const useComposedState = (
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
  existingHabits: readonly Habit[],
) => {
  const anchor = useProgramStore(selectProgramStartDate);
  const [entry] = useState<EntryState>(() => entryStateFor(existingHabits, anchor));
  const [step, setStep] = useState(entry.step);
  const [habits, setHabits] = useState<OnboardingHabit[]>([]);
  const [reviewRows, setReviewRows] = useState<readonly ReviewRow[]>(entry.rows);
  const [startDate, setStartDate] = useState(entry.startDate);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedHabitIndex, setSelectedHabitIndex] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [goalGroupTemplates, setGoalGroupTemplates] = useState<ApiGoalGroup[]>([]);
  return {
    step,
    setStep,
    habits,
    setHabits,
    reviewRows,
    setReviewRows,
    anchor,
    startDate,
    setStartDate,
    showEmojiPicker,
    setShowEmojiPicker,
    selectedHabitIndex,
    setSelectedHabitIndex,
    scrollRef,
    goalGroupTemplates,
    setGoalGroupTemplates,
    onClose,
    onSaveHabits,
  };
};

/** Which habits a pending confirmation would let go of, and what asked for it. */
interface PendingRelease {
  readonly habitIds: readonly number[];
  /**
   * Set when the ask came from taking a chip off the add-habits step rather
   * than from leaving the review step, because confirming has to unpick the
   * chip's row rather than carry the user forward.
   */
  readonly fromChip: boolean;
}

interface ReviewStateHandle {
  reviewRows: readonly ReviewRow[];
  setReviewRows: React.Dispatch<React.SetStateAction<readonly ReviewRow[]>>;
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>;
  setStep: React.Dispatch<React.SetStateAction<number>>;
  existingHabits: readonly Habit[];
}

/**
 * Everything the review step can do, and the one confirmation that guards the
 * only irreversible thing among them.
 *
 * Leaving the step and taking a chip off the add-habits step both mean the same
 * thing for a habit the user already had, so both route through the same
 * dialog. Cancelling either leaves the state exactly as it was -- unticked rows
 * stay unticked, chips stay put, and nothing has been written anywhere.
 */
const useReviewActions = (handle: ReviewStateHandle) => {
  const { reviewRows, setReviewRows, setHabits, setStep, existingHabits } = handle;
  const [pendingRelease, setPendingRelease] = useState<PendingRelease | null>(null);

  const enterAddHabits = (rows: readonly ReviewRow[]) => {
    setHabits((prev) => syncPool(prev, rows, existingHabits));
    setStep(ADD_HABITS_STEP);
  };

  const handleContinueFromReview = () => {
    const releasing = releasedRows(reviewRows);
    if (releasing.length === 0) {
      enterAddHabits(reviewRows);
      return;
    }
    setPendingRelease({ habitIds: releasing.map((row) => row.habitId), fromChip: false });
  };

  const handleConfirmRelease = () => {
    const pending = pendingRelease;
    setPendingRelease(null);
    if (pending === null) return;
    if (!pending.fromChip) {
      enterAddHabits(reviewRows);
      return;
    }
    let next = reviewRows;
    for (const habitId of pending.habitIds) next = releaseRow(next, habitId);
    setReviewRows(next);
    setHabits((prev) => syncPool(prev, next, existingHabits));
  };

  return {
    pendingRelease,
    releaseNames: (pendingRelease?.habitIds ?? []).flatMap((habitId) =>
      reviewRows.filter((row) => row.habitId === habitId).map((row) => row.name),
    ),
    handleToggleKeep: (habitId: number) => setReviewRows(toggleKeep(reviewRows, habitId)),
    handleSelectDestination: (habitId: number, destination: ReviewDestination) =>
      setReviewRows(setDestination(reviewRows, habitId, destination)),
    handleContinueFromReview,
    handleBackToReview: () => setStep(REVIEW_STEP),
    requestChipRelease: (habitId: number) =>
      setPendingRelease({ habitIds: [habitId], fromChip: true }),
    handleCancelRelease: () => setPendingRelease(null),
    handleConfirmRelease,
  };
};

/**
 * Re-seed the whole flow each time the modal opens, and only then.
 *
 * The modal stays mounted behind a `visible` flag, so its state outlives every
 * close -- and the habit list it must ask about is still loading when the screen
 * first mounts. Seeding once at mount would therefore ask a returning user
 * nothing at all. The latest values are read through a ref so an unstable
 * `existingHabits` identity cannot re-seed mid-flow and throw away what the user
 * has typed.
 */
const useEntryReset = (
  visible: boolean,
  existingHabits: readonly Habit[],
  anchor: Date | null,
  apply: (_entry: EntryState) => void,
) => {
  const latest = useRef({ existingHabits, anchor, apply });
  latest.current = { existingHabits, anchor, apply };
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!visible) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const current = latest.current;
    current.apply(entryStateFor(current.existingHabits, current.anchor));
  }, [visible]);
};

/**
 * The review half, bound to the composed state: the answers the user gives, the
 * re-seed that runs on every open, and the result the save is handed. A pass
 * that had nothing to review hands back bare picks exactly as it always did;
 * only a pass that asked can state a plan.
 */
const useScaffoldReview = (
  visible: boolean,
  existingHabits: readonly Habit[],
  cs: ReturnType<typeof useComposedState>,
) => {
  const { setStep, setHabits, setReviewRows, setStartDate, reviewRows, habits, anchor } = cs;
  const review = useReviewActions({
    reviewRows,
    setReviewRows,
    setHabits,
    setStep,
    existingHabits,
  });
  const applyEntry = useCallback(
    (entry: EntryState) => {
      setReviewRows(entry.rows);
      setStep(entry.step);
      setStartDate(entry.startDate);
      setHabits([]);
    },
    [setReviewRows, setStep, setStartDate, setHabits],
  );
  useEntryReset(visible, existingHabits, anchor, applyEntry);
  return {
    ...review,
    resetToEntry: () => applyEntry(entryStateFor(existingHabits, anchor)),
    buildResult: (): readonly OnboardingHabit[] | HabitMergePlan =>
      reviewRows.length > 0 ? buildMergePlan(habits, reviewRows, existingHabits) : habits,
  };
};

/** The chip "x", read against where the chip came from. */
const guardedRemoveHabit =
  (
    habits: readonly OnboardingHabit[],
    dropPick: (_index: number) => void,
    requestChipRelease: (_habitId: number) => void,
  ) =>
  (index: number): void => {
    const origin = originHabitId(habits[index]?.id ?? '');
    if (origin === null) {
      dropPick(index);
      return;
    }
    requestChipRelease(origin);
  };

const useOnboardingPieces = (
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
  existingHabits: readonly Habit[],
  visible: boolean,
) => {
  const cs = useComposedState(onClose, onSaveHabits, existingHabits);
  const { step, habits, setHabits, setStep, startDate } = cs;
  const revealParts = useRevealIntegration(step, habits, setHabits, setStep, startDate);
  useOnboardingEffects(step, cs.scrollRef, revealParts.prepareHabitsForReorder);
  const review = useScaffoldReview(visible, existingHabits, cs);
  const input = useHabitInput(habits, setHabits, setStep);
  const nav = useOnboardingNavigation(
    review.buildResult,
    review.resetToEntry,
    setStep,
    cs.setGoalGroupTemplates,
    onClose,
    onSaveHabits,
  );
  const act = useOnboardingActions(
    habits,
    setHabits,
    startDate,
    cs.setStartDate,
    cs.selectedHabitIndex,
    cs.setSelectedHabitIndex,
    cs.setShowEmojiPicker,
  );
  return {
    cs,
    revealParts,
    review,
    input,
    nav,
    act,
    // A chip the user is taking off the add-habits step may be a habit they
    // already had, and dropping one of those from the list is a release the
    // plain filter would perform without ever asking.
    removeHabit: guardedRemoveHabit(habits, act.removeHabit, review.requestChipRelease),
  };
};

const useOnboardingState = (
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
  existingHabits: readonly Habit[],
  visible: boolean,
) => {
  const { cs, revealParts, review, input, nav, act, removeHabit } = useOnboardingPieces(
    onClose,
    onSaveHabits,
    existingHabits,
    visible,
  );
  return {
    step: cs.step,
    setStep: cs.setStep,
    habits: cs.habits,
    reviewRows: cs.reviewRows,
    startDate: cs.startDate,
    showEmojiPicker: cs.showEmojiPicker,
    selectedHabitIndex: cs.selectedHabitIndex,
    scrollRef: cs.scrollRef,
    goalGroupTemplates: cs.goalGroupTemplates,
    ...revealParts,
    ...nav,
    ...input,
    ...act,
    ...review,
    // After the spreads, deliberately: this one overrides `act.removeHabit`.
    removeHabit,
  };
};

const OnboardingStepReview = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => (
  <OnboardingReviewStep
    rows={s.reviewRows}
    onToggleKeep={s.handleToggleKeep}
    onSelectDestination={s.handleSelectDestination}
    onContinue={s.handleContinueFromReview}
  />
);

const OnboardingStepOne = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => (
  <AddHabitsStep
    habits={s.habits}
    newHabitName={s.newHabitName}
    setNewHabitName={s.setNewHabitName}
    error={s.error}
    inputRef={s.inputRef}
    onAddHabit={s.handleAddHabit}
    onKeyPress={s.handleKeyPress}
    onContinuePress={s.handleContinuePress}
    onRemoveHabit={s.removeHabit}
    onBack={s.reviewRows.length > 0 ? s.handleBackToReview : undefined}
    onFinish={s.reviewRows.length > 0 ? s.handleFinish : undefined}
  />
);

const OnboardingStepReorder = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => (
  <ReorderStep
    habits={s.habits}
    startDate={s.startDate}
    showEmojiPicker={s.showEmojiPicker}
    selectedHabitIndex={s.selectedHabitIndex}
    postReveal={s.reveal.revealPhase === 'complete'}
    onDragEnd={s.handleDragEnd}
    onEditIcon={s.openEmojiForIndex}
    onDateChange={s.handleDateChange}
    onGoToTemplates={s.handleGoToTemplates}
    onCloseEmoji={s.closeEmoji}
    onEmojiSelected={s.onEmojiSelected}
  />
);

const OnboardingStepRevealOrReorder = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => {
  if (s.reveal.isRevealing) {
    const habits = s.reveal.revealPhase === 'sorting' ? s.habits : s.unsortedHabits;
    return (
      <RevealStep
        habits={habits}
        revealedScoreCount={s.reveal.revealedScoreCount}
        revealPhase={s.reveal.revealPhase}
      />
    );
  }
  return <OnboardingStepReorder s={s} />;
};

const renderOnboardingStep = (s: ReturnType<typeof useOnboardingState>) => {
  switch (s.step) {
    case REVIEW_STEP:
      return <OnboardingStepReview s={s} />;
    case 1:
      return <OnboardingStepOne s={s} />;
    case 2:
      return (
        <EnergyStep
          type="cost"
          habits={s.habits}
          scrollRef={s.scrollRef}
          onBack={() => s.setStep(1)}
          onContinue={() => s.setStep(3)}
          onValueChange={s.updateHabitEnergy}
        />
      );
    case 3:
      return (
        <EnergyStep
          type="return"
          habits={s.habits}
          scrollRef={s.scrollRef}
          onBack={() => s.setStep(2)}
          onContinue={s.prepareHabitsForReorder}
          onValueChange={s.updateHabitEnergy}
        />
      );
    case 4:
      return <OnboardingStepRevealOrReorder s={s} />;
    case 5:
      return (
        <TemplateStep
          habits={s.habits}
          scrollRef={s.scrollRef}
          goalGroupTemplates={s.goalGroupTemplates}
          onAssign={s.assignTemplate}
          onBack={() => s.setStep(4)}
          onFinish={s.handleFinish}
        />
      );
    default:
      return null;
  }
};

/** "A", "A and B", "A, B and C" — a list read aloud rather than punctuated. */
const listNames = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The one destructive confirmation this step can reach. It names what goes and
 * says what goes with it: the release is a delete, it cascades the habit's goals
 * and check-ins server-side, and nothing archives them. Cancelling changes
 * nothing at all -- the rows are still unticked and can simply be ticked again.
 */
const ReleaseConfirmDialog = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => (
  <ConfirmDialog
    visible={s.pendingRelease !== null}
    title={s.releaseNames.length > 1 ? 'Let these habits go?' : 'Let this habit go?'}
    message={`${listNames(s.releaseNames)} will be deleted, and every check-in and goal held there goes too. There is no way to bring it back.`}
    testID="release-confirm"
    cancelTestID="release-cancel"
    confirmTestID="release-let-go"
    cancelLabel="Cancel"
    confirmLabel="Let go"
    destructive
    onCancel={s.handleCancelRelease}
    onConfirm={s.handleConfirmRelease}
  />
);

const OnboardingDialogs = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => (
  <>
    <ReleaseConfirmDialog s={s} />
    <ConfirmDialog
      visible={s.showDiscardDialog}
      title="Discard all changes?"
      message="You'll lose what you've written."
      testID="discard-confirm"
      cancelTestID="discard-cancel"
      confirmTestID="discard-exit"
      cancelLabel="Cancel"
      confirmLabel="Exit"
      destructive
      onCancel={() => s.setShowDiscardDialog(false)}
      onConfirm={s.handleConfirmDiscard}
    />
    <ConfirmDialog
      visible={s.showCountWarning}
      title={`You've entered ${s.habits.length} of ${MAX_HABITS}. Continue anyway?`}
      testID="count-warning-modal"
      cancelTestID="count-warning-keep"
      confirmTestID="count-warning-continue"
      cancelLabel="Keep Adding"
      confirmLabel="Continue"
      destructive
      onCancel={() => s.setShowCountWarning(false)}
      onConfirm={() => {
        s.setShowCountWarning(false);
        s.setStep(2);
      }}
    />
  </>
);

const NO_EXISTING_HABITS: readonly Habit[] = [];

export const OnboardingModal = ({
  visible,
  onClose,
  onSaveHabits,
  existingHabits = NO_EXISTING_HABITS,
}: OnboardingModalProps) => {
  const s = useOnboardingState(onClose, onSaveHabits, existingHabits, visible);

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={s.handleAttemptClose}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={s.handleAttemptClose}
            style={StyleSheet.absoluteFill}
            testID="onboarding-overlay"
          />
          <View style={styles.onboardingModalContent} testID="onboarding-modal-content">
            <TouchableOpacity
              testID="onboarding-close"
              style={styles.modalClose}
              onPress={s.handleAttemptClose}
            >
              <Text style={styles.modalCloseText}>×</Text>
            </TouchableOpacity>
            {renderOnboardingStep(s)}
          </View>
        </View>
      </Modal>
      <OnboardingDialogs s={s} />
    </>
  );
};

const revealStyles = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginVertical: 4,
    borderRadius: 8,
    backgroundColor: '#fffdf7',
    borderWidth: 1,
    borderColor: colors.mystical.glowLight,
  },
  habitName: {
    fontSize: 16,
    color: '#333',
    flex: 1,
  },
  score: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.secondary,
    marginLeft: 8,
  },
});

const templatePickerStyles = StyleSheet.create({
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.mystical.glowLight,
    backgroundColor: '#fffdf7',
  },
  optionSelected: {
    borderColor: colors.secondary,
    backgroundColor: colors.mystical.glowLight,
  },
  optionText: {
    fontSize: 13,
    color: '#333',
  },
});

export default OnboardingModal;
