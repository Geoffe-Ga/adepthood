import Slider, { type SliderProps } from '@react-native-community/slider';
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
import DraggableFlatList from 'react-native-draggable-flatlist';
import EmojiSelector from 'react-native-emoji-selector';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import { goalGroups as goalGroupsApi, type ApiGoalGroup } from '../../../api';
import DatePicker, { parseISODate, toISODate } from '../../../components/DatePicker';
import { colors, STAGE_COLORS } from '../../../design/tokens';
import { DEFAULT_ICONS } from '../constants';
import styles from '../Habits.styles';
import type { OnboardingHabit, OnboardingModalProps } from '../Habits.types';
import { STAGE_ORDER, calculateHabitStartDate } from '../HabitUtils';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface SmoothSliderProps extends SliderProps {
  animateTransitions?: boolean;
  animationType?: 'timing' | 'spring';
  animationConfig?: Record<string, unknown>;
}

const SmoothSlider = Slider as React.ComponentType<SmoothSliderProps>;

const MAX_HABITS = 10;
const DEFAULT_ENERGY = 5;

const REVEAL_STAGGER_MS = 150;
const REVEAL_SORT_PAUSE_MS = 500;

type RevealPhase = 'idle' | 'showing-scores' | 'sorting' | 'complete';

const sortByNetEnergy = (habits: OnboardingHabit[]): OnboardingHabit[] =>
  [...habits].sort((a, b) => {
    const netA = a.energy_return - a.energy_cost;
    const netB = b.energy_return - b.energy_cost;
    if (netA !== netB) return netB - netA;
    if (a.energy_cost !== b.energy_cost) return a.energy_cost - b.energy_cost;
    return b.energy_return - a.energy_return;
  });

const assignDatesAndStages = (habits: OnboardingHabit[], startDate: Date): OnboardingHabit[] =>
  habits.map((habit, index) => ({
    ...habit,
    start_date: calculateHabitStartDate(startDate, index),
    stage: STAGE_ORDER[index] ?? 'Clear Light',
  }));

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  testID: string;
  cancelTestID: string;
  confirmTestID: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const ConfirmDialog = ({
  visible,
  title,
  message,
  testID,
  cancelTestID,
  confirmTestID,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) => {
  if (!visible) return null;
  return (
    <Modal transparent animationType="fade">
      <View style={styles.modalOverlay} testID={testID}>
        <View style={styles.discardModal}>
          <Text style={styles.discardTitle}>{title}</Text>
          {message && <Text style={styles.discardMessage}>{message}</Text>}
          <View style={styles.discardActions}>
            <TouchableOpacity onPress={onCancel} style={styles.discardButton} testID={cancelTestID}>
              <Text style={styles.discardButtonText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onConfirm}
              style={styles.discardButton}
              testID={confirmTestID}
            >
              <Text style={styles.discardExitText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

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
          <SmoothSlider
            testID={`${type}-slider`}
            minimumValue={0}
            maximumValue={10}
            step={1}
            value={value}
            onValueChange={(v) => onValueChange(index, type, v)}
            animateTransitions
            animationType="timing"
            animationConfig={{ duration: 150 }}
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
  const stage = (STAGE_ORDER[index] ??
    STAGE_ORDER[STAGE_ORDER.length - 1]) as keyof typeof STAGE_COLORS;
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
            {item.energy_return - item.energy_cost}
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
  inputRef: React.RefObject<TextInput>;
  onAddHabit: () => void;
  onKeyPress: (
    _e: NativeSyntheticEvent<TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean }>,
  ) => void;
  onContinuePress: () => void;
  onRemoveHabit: (_index: number) => void;
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
  inputRef: React.RefObject<TextInput>;
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
    <View style={styles.bottomContainer}>
      <Text style={styles.habitCount} testID="habit-count">{`${habits.length} / 10`}</Text>
      <TouchableOpacity
        testID="continue-button"
        style={[styles.onboardingContinueButton, habits.length === 0 && styles.disabledButton]}
        onPress={onContinuePress}
        disabled={habits.length === 0}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  </SafeAreaView>
);

interface EnergyStepProps {
  type: 'cost' | 'return';
  habits: OnboardingHabit[];
  scrollRef: React.RefObject<ScrollView>;
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
      <Text style={styles.startDateLabel}>First habit starts on:</Text>
      <DatePicker
        value={toISODate(startDate)}
        minDate={toISODate(new Date())}
        mode="scaffoldingStart"
        onChange={onDateChange}
      />
    </View>
  </>
);

const ReorderEmojiOverlay = ({
  onCloseEmoji,
  onEmojiSelected,
}: {
  onCloseEmoji: () => void;
  onEmojiSelected: (_emoji: string) => void;
}) => (
  <View style={styles.emojiPickerModal}>
    <View style={styles.emojiPickerHeader}>
      <Text style={styles.emojiPickerTitle}>Select Icon</Text>
      <TouchableOpacity style={styles.closeEmojiPicker} onPress={onCloseEmoji}>
        <Text style={styles.closeEmojiPickerText}>×</Text>
      </TouchableOpacity>
    </View>
    <EmojiSelector onEmojiSelected={onEmojiSelected} showSearchBar columns={6} emojiSize={28} />
  </View>
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
                Net: {habit.energy_return - habit.energy_cost}
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
        renderItem={({ item, drag, isActive, getIndex }) => (
          <ReorderItem
            item={item}
            index={getIndex() ?? 0}
            drag={drag}
            isActive={isActive}
            onEditIcon={onEditIcon}
          />
        )}
        onDragEnd={onDragEnd}
      />
    </View>
    {showEmojiPicker && selectedHabitIndex !== null && (
      <ReorderEmojiOverlay onCloseEmoji={onCloseEmoji} onEmojiSelected={onEmojiSelected} />
    )}
  </View>
);

interface TemplateStepProps {
  habits: OnboardingHabit[];
  scrollRef: React.RefObject<ScrollView>;
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
  scrollRef: React.RefObject<ScrollView>,
  prepareHabitsForReorder: () => void,
) => {
  useEffect(() => {
    if (step === 2 || step === 3) scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step, scrollRef]);

  useEffect(() => {
    if (Platform.OS === 'web' && (step === 2 || step === 3)) {
      const handler = (e: KeyboardEvent) => {
        if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
        if (step === 2) return;
        if (step === 3) prepareHabitsForReorder();
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
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

const createNewHabit = (name: string): OnboardingHabit => ({
  id: Date.now().toString(),
  name: name.trim(),
  icon: DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)] ?? '⭐',
  energy_cost: DEFAULT_ENERGY,
  energy_return: DEFAULT_ENERGY,
  stage: 'Beige',
  start_date: new Date(),
});

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
    if (newHabitName.trim() === '') return;
    if (habits.length >= MAX_HABITS) {
      setError('You can only add up to 10 habits.');
      return;
    }
    setHabits((prev) => [...prev, createNewHabit(newHabitName)]);
    setNewHabitName('');
    setError('');
    inputRef.current?.focus();
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
  habits: OnboardingHabit[],
  setHabits: React.Dispatch<React.SetStateAction<OnboardingHabit[]>>,
  setStep: React.Dispatch<React.SetStateAction<number>>,
  setGoalGroupTemplates: React.Dispatch<React.SetStateAction<ApiGoalGroup[]>>,
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
) => {
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const handleAttemptClose = () => setShowDiscardDialog(true);
  const handleConfirmDiscard = () => {
    setStep(1);
    setHabits([]);
    setShowDiscardDialog(false);
    onClose();
  };
  const handleGoToTemplates = () => {
    goalGroupsApi
      .list()
      .then((templates) => {
        setGoalGroupTemplates(templates.filter((t) => t.shared_template));
        setStep(5);
      })
      .catch(() => {
        onSaveHabits(habits);
        onClose();
      });
  };
  const handleFinish = () => {
    onSaveHabits(habits);
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

const useComposedState = (
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
) => {
  const [step, setStep] = useState(1);
  const [habits, setHabits] = useState<OnboardingHabit[]>([]);
  const [startDate, setStartDate] = useState(new Date());
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedHabitIndex, setSelectedHabitIndex] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [goalGroupTemplates, setGoalGroupTemplates] = useState<ApiGoalGroup[]>([]);
  return {
    step,
    setStep,
    habits,
    setHabits,
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

const useOnboardingState = (
  onClose: () => void,
  onSaveHabits: OnboardingModalProps['onSaveHabits'],
) => {
  const cs = useComposedState(onClose, onSaveHabits);
  const { step, habits, setHabits, setStep, startDate } = cs;

  const { reveal, unsortedHabits, prepareHabitsForReorder } = useRevealIntegration(
    step,
    habits,
    setHabits,
    setStep,
    startDate,
  );

  useOnboardingEffects(step, cs.scrollRef, prepareHabitsForReorder);
  const input = useHabitInput(habits, setHabits, setStep);
  const nav = useOnboardingNavigation(
    habits,
    setHabits,
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
    step,
    setStep,
    habits,
    startDate,
    showEmojiPicker: cs.showEmojiPicker,
    selectedHabitIndex: cs.selectedHabitIndex,
    scrollRef: cs.scrollRef,
    goalGroupTemplates: cs.goalGroupTemplates,
    prepareHabitsForReorder,
    unsortedHabits,
    reveal,
    ...nav,
    ...input,
    ...act,
  };
};

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

const OnboardingDialogs = ({ s }: { s: ReturnType<typeof useOnboardingState> }) => (
  <>
    <ConfirmDialog
      visible={s.showDiscardDialog}
      title="Discard all changes?"
      message="You'll lose what you've written."
      testID="discard-confirm"
      cancelTestID="discard-cancel"
      confirmTestID="discard-exit"
      cancelLabel="Cancel"
      confirmLabel="Exit"
      onCancel={() => s.setShowDiscardDialog(false)}
      onConfirm={s.handleConfirmDiscard}
    />
    <ConfirmDialog
      visible={s.showCountWarning}
      title={`You've entered ${s.habits.length} of 10. Continue anyway?`}
      testID="count-warning-modal"
      cancelTestID="count-warning-keep"
      confirmTestID="count-warning-continue"
      cancelLabel="Keep Adding"
      confirmLabel="Continue"
      onCancel={() => s.setShowCountWarning(false)}
      onConfirm={() => {
        s.setShowCountWarning(false);
        s.setStep(2);
      }}
    />
  </>
);

export const OnboardingModal = ({ visible, onClose, onSaveHabits }: OnboardingModalProps) => {
  const s = useOnboardingState(onClose, onSaveHabits);

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
