import React, { useRef, useState } from 'react';
import {
  FlatList,
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

import DatePicker, { parseISODate, toISODate } from '../../../components/DatePicker';
import styles from '../Habits.styles';
import type { OnboardingHabit, OnboardingModalProps } from '../Habits.types';
import { DEFAULT_ICONS } from '../HabitsScreen';
import { calculateHabitStartDate } from '../HabitUtils';

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

  // Step 1: Add habits
  const handleAddHabit = () => {
    if (newHabitName.trim() === '') return;
    if (habits.length >= 10) {
      setError('You can only add up to 10 habits.');
      return;
    }

    const randomIcon = DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)] ?? '⭐';

    const newHabit: OnboardingHabit = {
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
    if (value < -10 || value > 10) return; // Validate range

    setHabits((prev) =>
      prev.map((habit, i) => (i === index ? { ...habit, [`energy_${type}`]: value } : habit)),
    );
  };

  const updateHabitIcon = (index: number, icon: string) => {
    setHabits((prev) => prev.map((habit, i) => (i === index ? { ...habit, icon } : habit)));
    setShowEmojiPicker(false);
    setSelectedHabitIndex(null);
  };

  // Sort habits by net energy for step 3
  const prepareHabitsForReorder = () => {
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

    // Update start dates based on the sorted order
    const habitsWithDates = sortedHabits.map((habit, index) => ({
      ...habit,
      start_date: calculateHabitStartDate(startDate, index),
    }));

    setHabits(habitsWithDates);
    setStep(4);
  };

  // Step 2: Cost entry
  const renderCostStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Energy Cost</Text>
      <Text style={styles.onboardingSubtitle}>Rate each habit from -10 to 10 for energy cost</Text>
      <FlatList
        data={habits}
        keyExtractor={(_, index) => index.toString()}
        renderItem={({ item, index }) => (
          <View style={styles.energyRatingItem}>
            <Text style={styles.energyRatingName}>
              {item.icon} {item.name}
            </Text>
            <View style={styles.energyRatingDetails}>
              <View style={styles.energySliders}>
                <Text style={styles.energySliderLabel}>Cost:</Text>
                <View style={styles.sliderContainer}>
                  <TouchableOpacity
                    style={styles.sliderButton}
                    onPress={() =>
                      updateHabitEnergy(index, 'cost', Math.max(-10, item.energy_cost - 1))
                    }
                  >
                    <Text style={styles.sliderButtonText}>-</Text>
                  </TouchableOpacity>
                  <Text style={styles.sliderValue}>{item.energy_cost}</Text>
                  <TouchableOpacity
                    style={styles.sliderButton}
                    onPress={() =>
                      updateHabitEnergy(index, 'cost', Math.min(10, item.energy_cost + 1))
                    }
                  >
                    <Text style={styles.sliderButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        )}
      />
      <TouchableOpacity
        testID="continue-button"
        style={styles.onboardingContinueButton}
        onPress={() => setStep(3)}
        disabled={habits.length === 0}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  // Step 3: Return entry
  const renderReturnStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Energy Return</Text>
      <Text style={styles.onboardingSubtitle}>
        Rate each habit from -10 to 10 for energy return
      </Text>
      <FlatList
        data={habits}
        keyExtractor={(_, index) => index.toString()}
        renderItem={({ item, index }) => (
          <View style={styles.energyRatingItem}>
            <Text style={styles.energyRatingName}>
              {item.icon} {item.name}
            </Text>
            <View style={styles.energyRatingDetails}>
              <View style={styles.energySliders}>
                <Text style={styles.energySliderLabel}>Return:</Text>
                <View style={styles.sliderContainer}>
                  <TouchableOpacity
                    style={styles.sliderButton}
                    onPress={() =>
                      updateHabitEnergy(index, 'return', Math.max(-10, item.energy_return - 1))
                    }
                  >
                    <Text style={styles.sliderButtonText}>-</Text>
                  </TouchableOpacity>
                  <Text style={styles.sliderValue}>{item.energy_return}</Text>
                  <TouchableOpacity
                    style={styles.sliderButton}
                    onPress={() =>
                      updateHabitEnergy(index, 'return', Math.min(10, item.energy_return + 1))
                    }
                  >
                    <Text style={styles.sliderButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        )}
      />
      <TouchableOpacity
        testID="continue-button"
        style={styles.onboardingContinueButton}
        onPress={prepareHabitsForReorder}
        disabled={habits.length === 0}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  // Step 3: Reorder habits using drag & drop
  const handleDragEnd = ({ data }: { data: OnboardingHabit[] }) => {
    const updatedHabits = data.map((habit, index) => ({
      ...habit,
      start_date: calculateHabitStartDate(startDate, index),
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

      <View style={styles.habitsList}>
        <DraggableFlatList
          style={{ flex: 1 }}
          data={habits}
          keyExtractor={(_, index) => index.toString()}
          contentContainerStyle={styles.habitsListContent}
          renderItem={({ item, drag, isActive }) => {
            const index = habits.findIndex((h) => h === item);

            return (
              <TouchableOpacity
                onLongPress={drag}
                onPressIn={Platform.OS === 'web' ? drag : undefined}
                delayLongPress={150}
                style={[styles.habitListItem, isActive && { backgroundColor: '#eaeaea' }]}
              >
                <View style={styles.habitDragInfo}>
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
                      setSelectedHabitIndex(index);
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
              </TouchableOpacity>
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

      <TouchableOpacity
        testID="finish-setup"
        style={styles.onboardingContinueButton}
        onPress={handleFinish}
      >
        <Text style={styles.onboardingContinueButtonText}>Finish Setup</Text>
      </TouchableOpacity>
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
        return renderCostStep();
      case 3:
        return renderReturnStep();
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
          <View style={styles.onboardingModalContent}>
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
