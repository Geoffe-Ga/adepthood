import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  Platform,
  ScrollView,
  Switch,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import EmojiSelector from 'react-native-emoji-selector';

import type { Habit, HabitSettingsModalProps } from '../Habits.types';
import { calculateNetEnergy, DAYS_OF_WEEK } from '../HabitsScreen';
import { STAGE_COLORS } from '../../../constants/stageColors';

import styles from '../Habits.styles';

export const HabitSettingsModal = ({
  visible,
  habit,
  onClose,
  onUpdate,
  onDelete,
  onOpenReorderModal,
  allHabits,
}: HabitSettingsModalProps) => {
  const [editedHabit, setEditedHabit] = useState<Habit | null>(null);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showEmojiSelector, setShowEmojiSelector] = useState(false);
  const [notificationTime, setNotificationTime] = useState('08:00');
  const [showDaysPicker, setShowDaysPicker] = useState(false);

  useEffect(() => {
    setEditedHabit(habit ? { ...habit } : null);
  }, [habit, visible]);

  if (!editedHabit) return null;

  const handleChange = <K extends keyof Habit>(field: K, value: Habit[K]) => {
    setEditedHabit((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  const handleSave = () => {
    if (editedHabit && habit?.id) {
      onUpdate({ ...editedHabit, id: habit.id });
      onClose();
    }
  };

  const handleDelete = () => {
    if (habit?.id) {
      Alert.alert('Delete Habit', `Are you sure you want to delete "${habit.name}"?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            onDelete(habit.id!);
            onClose();
          },
        },
      ]);
    }
  };

  const handleTimeChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowTimePicker(Platform.OS === 'ios');
    if (selectedDate) {
      const hours = selectedDate.getHours().toString().padStart(2, '0');
      const minutes = selectedDate.getMinutes().toString().padStart(2, '0');
      setNotificationTime(`${hours}:${minutes}`);
    }
  };

  const handleAddNotificationTime = () => {
    const times = editedHabit.notificationTimes || [];
    if (!times.includes(notificationTime)) {
      handleChange('notificationTimes', [...times, notificationTime]);
    }
  };

  const handleRemoveNotificationTime = (time: string) => {
    const times = editedHabit.notificationTimes || [];
    handleChange(
      'notificationTimes',
      times.filter((t) => t !== time),
    );
  };

  const handleToggleDay = (day: string) => {
    const days = editedHabit.notificationDays || [];
    if (days.includes(day)) {
      handleChange(
        'notificationDays',
        days.filter((d) => d !== day),
      );
    } else {
      handleChange('notificationDays', [...days, day]);
    }
  };

  const renderTimePicker = () => {
    let defaultTime = new Date();
    const [hours, minutes] = notificationTime.split(':').map(Number);
    defaultTime.setHours(hours, minutes);

    return (
      <DateTimePicker
        value={defaultTime}
        mode="time"
        is24Hour={true}
        display="spinner"
        onChange={handleTimeChange}
      />
    );
  };

  // Calculate net energy
  const netEnergy = calculateNetEnergy(editedHabit.energy_cost, editedHabit.energy_return);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View
          style={[styles.settingsModalContent, { borderTopColor: STAGE_COLORS[editedHabit.stage] }]}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Habit</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.settingsContainer}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Name:</Text>
              <TextInput
                style={styles.settingInput}
                value={editedHabit.name}
                onChangeText={(text) => handleChange('name', text)}
              />
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Icon:</Text>
              <TouchableOpacity
                style={styles.iconSelectorButton}
                onPress={() => setShowEmojiSelector(!showEmojiSelector)}
              >
                <Text style={styles.currentIcon}>{editedHabit.icon}</Text>
                <Text style={styles.iconButtonText}>Change</Text>
              </TouchableOpacity>
            </View>

            {showEmojiSelector && (
              <View style={styles.emojiSelectorContainer}>
                <EmojiSelector
                  onEmojiSelected={(emoji) => {
                    handleChange('icon', emoji);
                    setShowEmojiSelector(false);
                  }}
                  showSearchBar
                  columns={8}
                  placeholder="Search emoji..."
                />
              </View>
            )}

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Stage:</Text>
              <Text style={styles.settingValue}>{editedHabit.stage}</Text>
            </View>

            <TouchableOpacity
              style={styles.reorderButton}
              onPress={() => onOpenReorderModal(allHabits)}
            >
              <Text style={styles.reorderButtonText}>Reorder Habits</Text>
            </TouchableOpacity>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Energy Rating:</Text>
            </View>

            <View style={styles.energyContainer}>
              <View style={styles.energyHeader}>
                <Text style={styles.energyHeaderText}>Cost</Text>
                <Text style={styles.energyHeaderText}>Return</Text>
                <Text style={styles.energyHeaderText}>Net</Text>
              </View>

              <View style={styles.energyRow}>
                <TextInput
                  style={styles.energyInput}
                  value={editedHabit.energy_cost.toString()}
                  onChangeText={(text) => {
                    const value = parseInt(text) || 0;
                    if (value >= -10 && value <= 10) {
                      handleChange('energy_cost', value);
                    }
                  }}
                  keyboardType="numeric"
                />
                <TextInput
                  style={styles.energyInput}
                  value={editedHabit.energy_return.toString()}
                  onChangeText={(text) => {
                    const value = parseInt(text) || 0;
                    if (value >= -10 && value <= 10) {
                      handleChange('energy_return', value);
                    }
                  }}
                  keyboardType="numeric"
                />
                <Text style={styles.netEnergyValue}>{netEnergy}</Text>
              </View>

              <View style={styles.validationNote}>
                <Text style={styles.validationText}>Values must be between -10 and 10</Text>
              </View>
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Start Date:</Text>
              <DateTimePicker
                value={new Date(editedHabit.start_date)}
                mode="date"
                display="default"
                onChange={(event, date) => date && handleChange('start_date', date)}
              />
            </View>

            <View style={styles.settingGroup}>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Notifications:</Text>
                <Switch
                  value={editedHabit.notificationFrequency !== 'off'}
                  onValueChange={(value) => {
                    handleChange('notificationFrequency', value ? 'daily' : 'off');
                  }}
                />
              </View>

              {editedHabit.notificationFrequency !== 'off' && (
                <>
                  <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>Frequency:</Text>
                    <TouchableOpacity
                      style={styles.frequencyButton}
                      onPress={() => {
                        const nextFreq = {
                          daily: 'weekly',
                          weekly: 'custom',
                          custom: 'daily',
                        }[editedHabit.notificationFrequency || 'daily'] as
                          | 'daily'
                          | 'weekly'
                          | 'custom';
                        handleChange('notificationFrequency', nextFreq);
                      }}
                    >
                      <Text style={styles.frequencyButtonText}>
                        {editedHabit.notificationFrequency || 'daily'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {editedHabit.notificationFrequency === 'custom' && (
                    <View style={styles.settingRow}>
                      <Text style={styles.settingLabel}>Days:</Text>
                      <TouchableOpacity
                        style={styles.daysButton}
                        onPress={() => setShowDaysPicker(!showDaysPicker)}
                      >
                        <Text style={styles.daysButtonText}>
                          {editedHabit.notificationDays && editedHabit.notificationDays.length > 0
                            ? editedHabit.notificationDays.map((d) => d.substring(0, 3)).join(', ')
                            : 'Select days'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  {showDaysPicker && (
                    <View style={styles.daysPicker}>
                      {DAYS_OF_WEEK.map((day) => (
                        <TouchableOpacity
                          key={day}
                          style={[
                            styles.dayOption,
                            (editedHabit.notificationDays || []).includes(day) &&
                              styles.selectedDayOption,
                          ]}
                          onPress={() => handleToggleDay(day)}
                        >
                          <Text style={styles.dayOptionText}>{day.substring(0, 3)}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}

                  <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>Time:</Text>
                    <View style={styles.timeInputContainer}>
                      <TouchableOpacity
                        style={styles.timeButton}
                        onPress={() => setShowTimePicker(true)}
                      >
                        <Text style={styles.timeButtonText}>{notificationTime}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.addTimeButton}
                        onPress={handleAddNotificationTime}
                      >
                        <Text style={styles.addTimeButtonText}>+</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {(Platform.OS === 'ios' || Platform.OS === 'android') &&
                    showTimePicker &&
                    renderTimePicker()}

                  {(editedHabit.notificationTimes || []).length > 0 && (
                    <View style={styles.timesList}>
                      {(editedHabit.notificationTimes || []).map((time, index) => (
                        <View key={index} style={styles.timeItem}>
                          <Text style={styles.timeText}>{time}</Text>
                          <TouchableOpacity
                            style={styles.removeTimeButton}
                            onPress={() => handleRemoveNotificationTime(time)}
                          >
                            <Text style={styles.removeTimeButtonText}>×</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}

              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Milestone Notifications:</Text>
                <Switch
                  value={editedHabit.milestoneNotifications || false}
                  onValueChange={(value) => handleChange('milestoneNotifications', value)}
                />
              </View>
            </View>

            <View style={styles.buttonGroup}>
              <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
                <Text style={styles.saveButtonText}>Save Changes</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                <Text style={styles.deleteButtonText}>Delete Habit</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

export default HabitSettingsModal;
