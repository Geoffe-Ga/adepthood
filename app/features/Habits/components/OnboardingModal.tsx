import React, { useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, Modal, TextInput, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import DraggableFlatList from 'react-native-draggable-flatlist';
import EmojiSelector from 'react-native-emoji-selector';

import type { OnboardingHabit, OnboardingModalProps } from '../Habits.types';
import { DEFAULT_ICONS } from '../HabitsScreen';

import styles from '../Habits.styles';

export const OnboardingModal = ({ visible, onClose, onSaveHabits }: OnboardingModalProps) => {
  const [step, setStep] = useState(1);
  const [habits, setHabits] = useState<OnboardingHabit[]>([]);
  const [newHabitName, setNewHabitName] = useState('');
  const [startDate, setStartDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedHabitIndex, setSelectedHabitIndex] = useState<number | null>(null);

  // Step 1: Add habits
  const handleAddHabit = () => {
    if (newHabitName.trim() === '') return;
    setHabits((prev) => [
      ...prev,
      {
        name: newHabitName.trim(),
        icon: DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)],
        energy_cost: 5,
        energy_return: 5,
        stage: 'Beige', // Default stage
        start_date: new Date(),
      },
    ]);
    setNewHabitName('');
  };

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

  const updateHabitStage = (index: number, stage: string) => {
    setHabits((prev) => prev.map((habit, i) => (i === index ? { ...habit, stage } : habit)));
  };

  // Sort habits by net energy for step 3
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

    // Update start dates based on the sorted order
    const habitsWithDates = sortedHabits.map((habit, index) => {
      const habitStartDate = new Date(startDate);
      habitStartDate.setDate(habitStartDate.getDate() + index * 21);
      return { ...habit, start_date: habitStartDate };
    });

    setHabits(habitsWithDates);
    setStep(3);
  };

  // Step 2: Energy rating
  const renderEnergyStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Energy Investment & Return</Text>
      <Text style={styles.onboardingSubtitle}>
        Rate each habit from -10 to 10 for energy cost and return
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
              <View style={styles.netEnergyContainer}>
                <Text style={styles.netEnergyLabel}>Net:</Text>
                <Text style={styles.netEnergyValue}>{item.energy_return - item.energy_cost}</Text>
              </View>
            </View>
          </View>
        )}
      />
      <TouchableOpacity
        style={styles.onboardingContinueButton}
        onPress={sortHabits}
        disabled={habits.length === 0}
      >
        <Text style={styles.onboardingContinueButtonText}>Continue</Text>
      </TouchableOpacity>
    </View>
  );

  // Step 3: Reorder habits using drag & drop
  const handleDragEnd = ({ data }: { data: OnboardingHabit[] }) => {
    const updatedHabits = data.map((habit, index) => {
      const habitStartDate = new Date(startDate);
      habitStartDate.setDate(habitStartDate.getDate() + index * 21);
      return { ...habit, start_date: habitStartDate };
    });
    setHabits(updatedHabits);
  };

  const renderReorderStep = () => (
    <View style={styles.onboardingStep}>
      <Text style={styles.onboardingTitle}>Reorder Your Habits</Text>
      <Text style={styles.onboardingSubtitle}>
        Habits are ordered by energy efficiency. You can drag to reorder if needed.
      </Text>

      <View style={styles.startDateContainer}>
        <Text style={styles.startDateLabel}>First habit starts on:</Text>
        <TouchableOpacity style={styles.startDateButton} onPress={() => setShowDatePicker(true)}>
          <Text style={styles.startDateButtonText}>
            {startDate.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </Text>
        </TouchableOpacity>

        {showDatePicker && (
          <DateTimePicker
            value={startDate}
            mode="date"
            display="default"
            onChange={(event, selectedDate) => {
              setShowDatePicker(Platform.OS === 'ios');
              if (selectedDate) {
                setStartDate(selectedDate);
                // Update all start dates
                setHabits((prev) =>
                  prev.map((habit, index) => {
                    const newDate = new Date(selectedDate);
                    newDate.setDate(newDate.getDate() + index * 21);
                    return { ...habit, start_date: newDate };
                  }),
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
            columns={8}
          />
        </View>
      )}

      <TouchableOpacity style={styles.onboardingContinueButton} onPress={handleFinish}>
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
        return renderEnergyStep();
      case 3:
        return renderReorderStep();
      default:
        return null;
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.onboardingModalContent}>{renderStep()}</View>
      </View>
    </Modal>
  );
};

export default OnboardingModal;
