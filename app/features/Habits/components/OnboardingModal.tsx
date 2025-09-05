import Slider, { type SliderProps } from '@react-native-community/slider';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import EmojiSelector from 'react-native-emoji-selector';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import DatePicker, { parseISODate, toISODate } from '../../../components/DatePicker';
import { STAGE_COLORS } from '../../../constants/stageColors';
import styles, { COLORS } from '../Habits.styles';
import type { OnboardingHabit, OnboardingModalProps } from '../Habits.types';
import { DEFAULT_ICONS } from '../HabitsScreen';
import { STAGE_ORDER, calculateHabitStartDate } from '../HabitUtils';

interface SmoothSliderProps extends SliderProps {
  animateTransitions?: boolean;
  animationType?: 'timing' | 'spring';
  animationConfig?: Record<string, unknown>;
}

const SmoothSlider = Slider as React.ComponentType<SmoothSliderProps>;

export const OnboardingModal = ({ visible, onClose, onSaveHabits }: OnboardingModalProps) => {
  const [step, setStep] = useState(1);
  const [habits, setHabits] = useState<OnboardingHabit[]>([]);
  const [newHabitName, setNewHabitName] = useState('');
  const [startDate, setStartDate] = useState(new Date());
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedHabitIndex, setSelectedHabitIndex] = useState<number | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const [error, setError] = useState('');
  const [showCountWarning, setShowCountWarning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (step === 2 || step === 3) {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }
  }, [step]);

  const prepareHabitsForReorder = useCallback(() => {
    const sortedHabits = [...habits].sort((a, b) => {
      const netEnergyA = a.energy_return - a.energy_cost;
      const netEnergyB = b.energy_return - b.energy_cost;

      if (netEnergyA !== netEnergyB) {
        return netEnergyB - netEnergyA; // Highest net energy first
      } else if (a.energy_cost !== b.energy_cost) {
        return a.energy_cost - b.energy_cost; // Lowest cost as tiebreaker
      } else {
        return b.energy_return - a.energy_return; // Highest return as second tiebreaker
      }
    });

    const habitsWithDates = sortedHabits.map((habit, index) => ({
      ...habit,
      start_date: calculateHabitStartDate(startDate, index),
      stage: STAGE_ORDER[index] ?? 'Clear Light',
    }));

    setHabits(habitsWithDates);
    setStep(4);
  }, [habits, startDate]);

  useEffect(() => {
    if (Platform.OS === 'web' && (step === 2 || step === 3)) {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          if (step === 2) {
            setStep(3);
          } else if (step === 3) {
            prepareHabitsForReorder();
          }
        }
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    }
  }, [step, prepareHabitsForReorder]);

  // Step 1: Add habits
  const handleAddHabit = () => {
    if (newHabitName.trim() === '') return;
    if (habits.length >= 10) {
      setError('You can only add up to 10 habits.');
      return;
    }

    const randomIcon = DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)] ?? '⭐';

    const newHabit: OnboardingHabit = {
      id: Date.now().toString(),
      name: newHabitName.trim(),
      icon: randomIcon,
      energy_cost: 5,
      energy_return: 5,
      stage: 'Beige', // Default stage
      start_date: new Date(),
    };

    setHabits((prev) => [...prev, newHabit]);
    setNewHabitName('');
    setError('');
    inputRef.current?.focus();
  };

  const handleKeyPress = (
    e: NativeSyntheticEvent<TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean }>,
  ) => {
    if (e.nativeEvent.key === 'Enter') {
      if (e.nativeEvent.metaKey || e.nativeEvent.ctrlKey) {
        if (habits.length > 0) setStep(2);
      } else {
        handleAddHabit();
      }
    }
  };

  const handleContinuePress = () => {
    if (habits.length < 10) {
      setShowCountWarning(true);
    } else {
      setStep(2);
    }
  };

  const confirmCountWarning = () => {
    setShowCountWarning(false);
    setStep(2);
  };

  const cancelCountWarning = () => setShowCountWarning(false);

  // Update energy values for a habit in onboarding
  const updateHabitEnergy = (index: number, type: 'cost' | 'return', value: number) => {
    if (value < 0 || value > 10) return;

    setHabits((prev) =>
      prev.map((habit, i) =>
        i === index ? { ...habit, [`energy_${type}`]: Math.round(value) } : habit,
      ),
    );
  };

  const updateHabitIcon = (index: number, icon: string) => {
    setHabits((prev) => prev.map((habit, i) => (i === index ? { ...habit, icon } : habit)));
    setShowEmojiPicker(false);
    setSelectedHabitIndex(null);
  };

  // Step 2 & 3: Energy entry
  const renderEnergyStep = (type: 'cost' | 'return') => {
    const title = type === 'cost' ? 'Energy Cost' : 'Energy Return';
    const subtitle =
      type === 'cost'
        ? '0 = effortless, easy as breathing. 10 = effort so big you might dread it.'
        : '0 = almost no change to your overall vibe. 10 = lights you up and feels deeply rewarding.';
    const onBack = () => setStep(type === 'cost' ? 1 : 2);
    const onContinue = type === 'cost' ? () => setStep(3) : prepareHabitsForReorder;

    return (
      <SafeAreaView style={styles.onboardingStep}>
        <ScrollView ref={scrollRef}>
          <Text style={styles.onboardingTitle}>{title}</Text>
          <Text style={styles.onboardingSubtitle}>{subtitle}</Text>
          {habits.map((habit, index) => {
            const value = type === 'cost' ? habit.energy_cost : habit.energy_return;
            return (
              <View key={index} style={styles.energyTile} testID={`energy-tile-${index}`}>
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
                      onValueChange={(v) => updateHabitEnergy(index, type, v)}
                      animateTransitions
                      animationType="timing"
                      animationConfig={{ duration: 150 }}
                      minimumTrackTintColor={COLORS.secondary}
                      maximumTrackTintColor={COLORS.mystical.glowLight}
                      thumbTintColor={COLORS.secondary}
                      style={[styles.energySlider, Platform.OS === 'web' && styles.energySliderWeb]}
                    />
                  </View>
                  <Text style={styles.sliderValue}>{value}</Text>
                </View>
              </View>
            );
          })}
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
  };

  // Step 3: Reorder habits using drag & drop
  const handleDragEnd = ({ data }: { data: OnboardingHabit[] }) => {
    const updatedHabits = data.map((habit, index) => ({
      ...habit,
      start_date: calculateHabitStartDate(startDate, index),
      stage: STAGE_ORDER[index] ?? 'Clear Light',
    }));
    setHabits(updatedHabits);
  };

  const handleAttemptClose = () => {
    setShowDiscardDialog(true);
  };

  const handleConfirmDiscard = () => {
    setStep(1);
    setHabits([]);
    setShowDiscardDialog(false);
    onClose();
  };

  const handleCancelDiscard = () => setShowDiscardDialog(false);

  const renderReorderStep = () => (
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
            <>
              <Text style={styles.onboardingTitle}>Reorder Your Habits</Text>
              <Text style={styles.onboardingSubtitle}>
                Habits are ordered by energy efficiency. You can drag to reorder if needed.
              </Text>
              <View style={styles.startDateContainer}>
                <Text style={styles.startDateLabel}>First habit starts on:</Text>
                <DatePicker
                  value={toISODate(startDate)}
                  minDate={toISODate(new Date())}
                  mode="scaffoldingStart"
                  onChange={(iso) => {
                    const selectedDate = parseISODate(iso);
                    setStartDate(selectedDate);
                    setHabits((prev) =>
                      prev.map((habit, index) => ({
                        ...habit,
                        start_date: calculateHabitStartDate(selectedDate, index),
                      })),
                    );
                  }}
                />
              </View>
            </>
          }
          ListFooterComponent={
            <TouchableOpacity
              testID="finish-setup"
              style={styles.onboardingContinueButton}
              onPress={handleFinish}
            >
              <Text style={styles.onboardingContinueButtonText}>Done</Text>
            </TouchableOpacity>
          }
          renderItem={({ item, drag, isActive, getIndex }) => {
            const index = getIndex() ?? 0;
            const stage = (STAGE_ORDER[index] ??
              STAGE_ORDER[STAGE_ORDER.length - 1]) as keyof typeof STAGE_COLORS;
            const color = STAGE_COLORS[stage] || '#ccc';

            const longPress = Gesture.LongPress()
              .minDuration(150)
              .onStart(() => drag());
            const mouseGrab = Gesture.Pan()
              .activateAfterLongPress(0)
              .onBegin(() => drag());
            const startDrag = Gesture.Race(longPress, mouseGrab);

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
                    <TouchableOpacity
                      style={styles.iconEditButton}
                      onPress={() => {
                        const currentIndex = getIndex() ?? 0;
                        setSelectedHabitIndex(currentIndex);
                        setShowEmojiPicker(true);
                      }}
                    >
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
          }}
          onDragEnd={handleDragEnd}
        />
      </View>
      {showEmojiPicker && selectedHabitIndex !== null && (
        <View style={styles.emojiPickerModal}>
          <View style={styles.emojiPickerHeader}>
            <Text style={styles.emojiPickerTitle}>Select Icon</Text>
            <TouchableOpacity
              style={styles.closeEmojiPicker}
              onPress={() => {
                setShowEmojiPicker(false);
                setSelectedHabitIndex(null);
              }}
            >
              <Text style={styles.closeEmojiPickerText}>×</Text>
            </TouchableOpacity>
          </View>
          <EmojiSelector
            onEmojiSelected={(emoji) => updateHabitIcon(selectedHabitIndex, emoji)}
            showSearchBar
            columns={6}
            // @ts-ignore react-native-emoji-selector typing
            emojiSize={28}
          />
        </View>
      )}
    </View>
  );

  const handleFinish = () => {
    onSaveHabits(habits);
    onClose();
  };

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <SafeAreaView style={styles.onboardingStep}>
            <Text style={styles.onboardingTitle}>Create Your Habits</Text>
            <Text style={styles.onboardingSubtitle}>
              Enter all the habits you'd like to build or break
            </Text>
            <View style={styles.addHabitContainer}>
              <TextInput
                ref={inputRef}
                style={styles.addHabitInput}
                value={newHabitName}
                onChangeText={setNewHabitName}
                placeholder="Enter habit name"
                blurOnSubmit={false}
                onKeyPress={handleKeyPress}
                testID="habit-input"
              />
              <TouchableOpacity
                testID="add-habit-button"
                style={[
                  styles.addHabitButton,
                  (newHabitName.trim() === '' || habits.length >= 10) && styles.disabledButton,
                ]}
                onPress={handleAddHabit}
                disabled={newHabitName.trim() === '' || habits.length >= 10}
              >
                <Text style={styles.addHabitButtonText}>+</Text>
              </TouchableOpacity>
            </View>
            {error !== '' && (
              <Text style={styles.habitError} testID="habit-error">
                {error}
              </Text>
            )}
            <ScrollView style={styles.habitsList} contentContainerStyle={styles.habitChipContainer}>
              {habits.map((item, index) => (
                <View key={index} style={styles.habitChip} testID="habit-chip">
                  <Text style={styles.habitChipText}>
                    {item.icon} {item.name}
                  </Text>
                  <TouchableOpacity
                    style={styles.removeHabitChip}
                    onPress={() => setHabits((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Text style={styles.removeHabitChipText}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
            <View style={styles.bottomContainer}>
              <Text style={styles.habitCount} testID="habit-count">
                {`${habits.length} / 10`}
              </Text>
              <TouchableOpacity
                testID="continue-button"
                style={[
                  styles.onboardingContinueButton,
                  habits.length === 0 && styles.disabledButton,
                ]}
                onPress={handleContinuePress}
                disabled={habits.length === 0}
              >
                <Text style={styles.onboardingContinueButtonText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        );
      case 2:
        return renderEnergyStep('cost');
      case 3:
        return renderEnergyStep('return');
      case 4:
        return renderReorderStep();
      default:
        return null;
    }
  };

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={handleAttemptClose}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={handleAttemptClose}
            style={StyleSheet.absoluteFill}
            testID="onboarding-overlay"
          />
          <View style={styles.onboardingModalContent} testID="onboarding-modal-content">
            <TouchableOpacity
              testID="onboarding-close"
              style={styles.modalClose}
              onPress={handleAttemptClose}
            >
              <Text style={styles.modalCloseText}>×</Text>
            </TouchableOpacity>
            {renderStep()}
          </View>
        </View>
      </Modal>

      {showDiscardDialog && (
        <Modal transparent animationType="fade">
          <View style={styles.modalOverlay} testID="discard-confirm">
            <View style={styles.discardModal}>
              <Text style={styles.discardTitle}>Discard all changes?</Text>
              <Text style={styles.discardMessage}>You'll lose what you've written.</Text>
              <View style={styles.discardActions}>
                <TouchableOpacity
                  onPress={handleCancelDiscard}
                  style={styles.discardButton}
                  testID="discard-cancel"
                >
                  <Text style={styles.discardButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleConfirmDiscard}
                  style={styles.discardButton}
                  testID="discard-exit"
                >
                  <Text style={styles.discardExitText}>Exit</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {showCountWarning && (
        <Modal transparent animationType="fade">
          <View style={styles.modalOverlay} testID="count-warning-modal">
            <View style={styles.discardModal}>
              <Text style={styles.discardTitle}>
                {`You've entered ${habits.length} of 10. Continue anyway?`}
              </Text>
              <View style={styles.discardActions}>
                <TouchableOpacity
                  onPress={cancelCountWarning}
                  style={styles.discardButton}
                  testID="count-warning-keep"
                >
                  <Text style={styles.discardButtonText}>Keep Adding</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={confirmCountWarning}
                  style={styles.discardButton}
                  testID="count-warning-continue"
                >
                  <Text style={styles.discardExitText}>Continue</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
};

export default OnboardingModal;
