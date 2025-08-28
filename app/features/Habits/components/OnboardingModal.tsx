import DateTimePicker from '@react-native-community/datetimepicker';
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  Platform,
} from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import EmojiSelector from 'react-native-emoji-selector';

import styles from '../Habits.styles';
import type { OnboardingHabit, OnboardingModalProps } from '../Habits.types';
import { DEFAULT_ICONS } from '../HabitsScreen';
import { getStaggeredStartDate, getStageByIndex } from '../OnboardingUtils';

export const OnboardingModal = ({
  visible,
  onClose,
  onSaveHabits,
  initialStep = 1,
}: OnboardingModalProps) => {
  const [step, setStep] = useState(initialStep);
  const [habits, setHabits] = useState<OnboardingHabit[]>([]);
  const [newHabitName, setNewHabitName] = useState('');
  const [startDate, setStartDate] = useState(new Date());
  const [isDatePickerVisible, setDatePickerVisible] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedHabitIndex, setSelectedHabitIndex] = useState<number | null>(null);

  // Step 1: Add habits
  const handleAddHabit = () => {
    if (newHabitName.trim() === '') return;
    const randomIcon = DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)] ?? '⭐';

    const newHabit: OnboardingHabit = {
      name: newHabitName.trim(),
      icon: randomIcon,
      energy_cost: 0,
      energy_return: 0,
      stage: 'Beige', // Default stage
      start_date: new Date(),
      costEntered: false,
      returnEntered: false,
    };

    setHabits((prev) => [...prev, newHabit]);
    setNewHabitName('');
  };

  // Update energy values for a habit in onboarding
  const updateHabitEnergy = (index: number, type: 'cost' | 'return', value: number) => {
    if (value < -10 || value > 10) return;

    setHabits((prev) =>
      prev.map((habit, i) =>
        i === index
          ? {
              ...habit,
              [`energy_${type}`]: value,
              ...(type === 'cost' ? { costEntered: true } : { returnEntered: true }),
            }
          : habit,
      ),
    );
  };

  const updateHabitIcon = (index: number, icon: string) => {
    setHabits((prev) => prev.map((habit, i) => (i === index ? { ...habit, icon } : habit)));
    setShowEmojiPicker(false);
    setSelectedHabitIndex(null);
  };

  // Sort habits by net energy for final step
  const sortHabits = () => {
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

    // Update start dates and stages based on the sorted order
    const habitsWithMeta = sortedHabits.map((habit, index) => ({
      ...habit,
      start_date: getStaggeredStartDate(startDate, index),
      stage: getStageByIndex(index),
    }));

    setHabits(habitsWithMeta);
    setStep(4);
  };

  // Step 2: enter energy cost
  const renderCostStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Energy Investment</Text>
      <Text style={styles.onboardingSubtitle}>Set the energy cost for each habit (-10 to 10)</Text>
      <FlatList
        data={habits}
        keyExtractor={(_, index) => index.toString()}
        renderItem={({ item, index }) => (
          <View style={styles.energyRatingItem}>
            <Text style={styles.energyRatingName}>
              <Text
                testID={`icon-picker-${index}`}
                onPress={() => {
                  setSelectedHabitIndex(index);
                  setShowEmojiPicker(true);
                }}
              >
                {item.icon}
              </Text>
              {` ${item.name}`}
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
        style={styles.onboardingContinueButton}
        onPress={() => setStep(3)}
        disabled={!habits.every((h) => h.costEntered)}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  // Step 3: enter energy return
  const renderReturnStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Energy Return</Text>
      <Text style={styles.onboardingSubtitle}>
        Set the energy return for each habit (-10 to 10)
      </Text>
      <FlatList
        data={habits}
        keyExtractor={(_, index) => index.toString()}
        renderItem={({ item, index }) => (
          <View style={styles.energyRatingItem}>
            <Text style={styles.energyRatingName}>
              <Text
                onPress={() => {
                  setSelectedHabitIndex(index);
                  setShowEmojiPicker(true);
                }}
              >
                {item.icon}
              </Text>
              {` ${item.name}`}
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
        style={styles.onboardingContinueButton}
        onPress={sortHabits}
        disabled={!habits.every((h) => h.returnEntered)}
      >
        <Text style={styles.onboardingContinueButtonText}>See Results</Text>
      </TouchableOpacity>
    </View>
  );

  // Step 3: Reorder habits using drag & drop
  const handleDragEnd = ({ data }: { data: OnboardingHabit[] }) => {
    const updatedHabits = data.map((habit, index) => ({
      ...habit,
      start_date: getStaggeredStartDate(startDate, index),
    }));
    setHabits(updatedHabits);
  };

  const renderResultsStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Net Energy Results</Text>
      <Text style={styles.onboardingSubtitle}>
        Habits are ordered by energy efficiency. Drag to adjust if needed.
      </Text>

      <View style={styles.startDateContainer}>
        <Text style={styles.startDateLabel}>First habit starts on:</Text>
        <TouchableOpacity
          testID="start-date-button"
          style={styles.startDateButton}
          onPress={() => setDatePickerVisible(true)}
        >
          <Text style={styles.startDateButtonText}>
            {startDate.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </Text>
        </TouchableOpacity>

        {isDatePickerVisible && (
          <DateTimePicker
            testID="start-date-picker"
            value={startDate}
            mode="date"
            display="default"
            onChange={(event, selectedDate) => {
              setDatePickerVisible(false);
              if (selectedDate) {
                setStartDate(selectedDate);
                setHabits((prev) =>
                  prev.map((habit, index) => ({
                    ...habit,
                    start_date: getStaggeredStartDate(selectedDate, index),
                  })),
                );
              }
            }}
          />
        )}
      </View>

      <View style={styles.habitsList}>
        <DraggableFlatList
          data={habits}
          keyExtractor={(_, index) => index.toString()}
          renderItem={({ item, drag, isActive }) => {
            const index = habits.findIndex((h) => h === item);

            return (
              <TouchableOpacity
                onLongPress={drag}
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
                    <Text
                      onPress={() => {
                        setSelectedHabitIndex(index);
                        setShowEmojiPicker(true);
                      }}
                    >
                      {item.icon}
                    </Text>
                    {` ${item.name}`}
                  </Text>
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

      <TouchableOpacity style={styles.onboardingContinueButton} onPress={handleFinish}>
        <Text style={styles.onboardingContinueButtonText}>Finish Setup</Text>
      </TouchableOpacity>
    </View>
  );

  const handleFinish = () => {
    onSaveHabits(habits);
    onClose();
    if (Platform.OS === 'web') {
      window.alert('Tap a habit tile to edit its goals.');
    } else {
      Alert.alert('Next Steps', 'Tap a habit tile to edit its goals.');
    }
  };

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <View style={styles.onboardingStep}>
            <Text style={styles.onboardingTitle}>Create Your Habits</Text>
            <Text style={styles.onboardingSubtitle}>
              Enter all the habits you'd like to build or break
            </Text>
            <View style={styles.addHabitContainer}>
              <TextInput
                style={styles.addHabitInput}
                value={newHabitName}
                onChangeText={setNewHabitName}
                placeholder="Enter habit name"
                onSubmitEditing={handleAddHabit}
              />
              <TouchableOpacity style={styles.addHabitButton} onPress={handleAddHabit}>
                <Text style={styles.addHabitButtonText}>+</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={habits}
              keyExtractor={(_, index) => index.toString()}
              renderItem={({ item, index }) => (
                <View style={styles.habitListItem}>
                  <Text style={styles.habitListItemText}>
                    {item.icon} {item.name}
                  </Text>
                  <TouchableOpacity
                    style={styles.removeHabitButton}
                    onPress={() => setHabits((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Text style={styles.removeHabitButtonText}>×</Text>
                  </TouchableOpacity>
                </View>
              )}
              style={styles.habitList}
            />
            <TouchableOpacity
              style={[
                styles.onboardingContinueButton,
                habits.length === 0 && styles.disabledButton,
              ]}
              onPress={() => habits.length > 0 && setStep(2)}
              disabled={habits.length === 0}
            >
              <Text style={styles.onboardingContinueButtonText}>Continue</Text>
            </TouchableOpacity>
          </View>
        );
      case 2:
        return renderCostStep();
      case 3:
        return renderReturnStep();
      case 4:
        return renderResultsStep();
      default:
        return null;
    }
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <View style={styles.modalOverlay}>
          <View style={styles.onboardingModalContent}>{renderStep()}</View>
        </View>
      </Modal>
      {showEmojiPicker && selectedHabitIndex !== null && (
        <Modal transparent animationType="slide" visible>
          <View style={styles.modalOverlay}>
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
              <View style={{ height: 250 }}>
                <EmojiSelector
                  onEmojiSelected={(emoji) => updateHabitIcon(selectedHabitIndex, emoji)}
                  showSearchBar
                  columns={8}
                  {...({ emojiSize: 28 } as unknown as { emojiSize: number })}
                />
              </View>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
};

export default OnboardingModal;
