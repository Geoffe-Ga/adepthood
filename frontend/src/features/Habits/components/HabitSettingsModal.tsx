import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import React, { useState, useEffect } from 'react';
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
import EmojiSelector from 'react-native-emoji-selector';

import { STAGE_COLORS } from '../../../design/tokens';
import { DAYS_OF_WEEK } from '../constants';
import styles from '../Habits.styles';
import type { Habit, HabitSettingsModalProps } from '../Habits.types';
import { calculateNetEnergy } from '../HabitUtils';

const ENERGY_MIN = -10;
const ENERGY_MAX = 10;

const cycleFrequency = (current: string | undefined): 'daily' | 'weekly' | 'custom' => {
  if (current === 'daily') return 'weekly';
  if (current === 'weekly') return 'custom';
  return 'daily';
};

const parseEnergyValue = (text: string): number | null => {
  const value = parseInt(text) || 0;
  return value >= ENERGY_MIN && value <= ENERGY_MAX ? value : null;
};

interface EnergySettingsProps {
  habit: Habit;
  netEnergy: number;
  onChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
}

const EnergySettings = ({ habit, netEnergy, onChange }: EnergySettingsProps) => (
  <View style={styles.energyContainer}>
    <View style={styles.energyHeader}>
      <Text style={styles.energyHeaderText}>Cost</Text>
      <Text style={styles.energyHeaderText}>Return</Text>
      <Text style={styles.energyHeaderText}>Net</Text>
    </View>
    <View style={styles.energyRow}>
      <TextInput
        style={styles.energyInput}
        value={habit.energy_cost.toString()}
        onChangeText={(text) => {
          const value = parseEnergyValue(text);
          if (value !== null) onChange('energy_cost', value);
        }}
        keyboardType="numeric"
      />
      <TextInput
        style={styles.energyInput}
        value={habit.energy_return.toString()}
        onChangeText={(text) => {
          const value = parseEnergyValue(text);
          if (value !== null) onChange('energy_return', value);
        }}
        keyboardType="numeric"
      />
      <Text style={styles.netEnergyValue}>{netEnergy}</Text>
    </View>
    <View style={styles.validationNote}>
      <Text style={styles.validationText}>Values must be between -10 and 10</Text>
    </View>
  </View>
);

interface NotificationSettingsProps {
  habit: Habit;
  notificationTime: string;
  showTimePicker: boolean;
  showDaysPicker: boolean;
  setShowTimePicker: (_v: boolean) => void;
  setShowDaysPicker: (_v: boolean) => void;
  onChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
  onTimeChange: (_event: DateTimePickerEvent, _date?: Date) => void;
  onAddTime: () => void;
  onRemoveTime: (_time: string) => void;
  onToggleDay: (_day: string) => void;
}

interface NotifFrequencyProps {
  habit: Habit;
  showDaysPicker: boolean;
  setShowDaysPicker: (_v: boolean) => void;
  onChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
  onToggleDay: (_day: string) => void;
}

const DayPickerGrid = ({
  days,
  onToggleDay,
}: {
  days: string[];
  onToggleDay: (_day: string) => void;
}) => (
  <View style={styles.daysPicker}>
    {DAYS_OF_WEEK.map((day) => (
      <TouchableOpacity
        key={day}
        style={[styles.dayOption, days.includes(day) && styles.selectedDayOption]}
        onPress={() => onToggleDay(day)}
      >
        <Text style={styles.dayOptionText}>{day.substring(0, 3)}</Text>
      </TouchableOpacity>
    ))}
  </View>
);

const formatDaysLabel = (days: string[] | undefined): string =>
  days && days.length > 0 ? days.map((d) => d.substring(0, 3)).join(', ') : 'Select days';

const NotifFrequencySection = ({
  habit,
  showDaysPicker,
  setShowDaysPicker,
  onChange,
  onToggleDay,
}: NotifFrequencyProps) => (
  <>
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Frequency:</Text>
      <TouchableOpacity
        style={styles.frequencyButton}
        onPress={() =>
          onChange('notificationFrequency', cycleFrequency(habit.notificationFrequency))
        }
      >
        <Text style={styles.frequencyButtonText}>{habit.notificationFrequency || 'daily'}</Text>
      </TouchableOpacity>
    </View>
    {habit.notificationFrequency === 'custom' && (
      <View style={styles.settingRow}>
        <Text style={styles.settingLabel}>Days:</Text>
        <TouchableOpacity
          style={styles.daysButton}
          onPress={() => setShowDaysPicker(!showDaysPicker)}
        >
          <Text style={styles.daysButtonText}>{formatDaysLabel(habit.notificationDays)}</Text>
        </TouchableOpacity>
      </View>
    )}
    {showDaysPicker && (
      <DayPickerGrid days={habit.notificationDays || []} onToggleDay={onToggleDay} />
    )}
  </>
);

interface NotifTimeProps {
  notificationTime: string;
  showTimePicker: boolean;
  notifTimes: string[];
  setShowTimePicker: (_v: boolean) => void;
  onTimeChange: (_event: DateTimePickerEvent, _date?: Date) => void;
  onAddTime: () => void;
  onRemoveTime: (_time: string) => void;
}

const TimesList = ({
  times,
  onRemoveTime,
}: {
  times: string[];
  onRemoveTime: (_time: string) => void;
}) => (
  <View style={styles.timesList}>
    {times.map((time, index) => (
      <View key={index} style={styles.timeItem}>
        <Text style={styles.timeText}>{time}</Text>
        <TouchableOpacity style={styles.removeTimeButton} onPress={() => onRemoveTime(time)}>
          <Text style={styles.removeTimeButtonText}>×</Text>
        </TouchableOpacity>
      </View>
    ))}
  </View>
);

const parseTimeValue = (timeStr: string): Date => {
  const defaultTime = new Date();
  const [hours = 0, minutes = 0] = timeStr.split(':').map(Number);
  defaultTime.setHours(hours, minutes);
  return defaultTime;
};

const NotifTimeSection = ({
  notificationTime,
  showTimePicker,
  notifTimes,
  setShowTimePicker,
  onTimeChange,
  onAddTime,
  onRemoveTime,
}: NotifTimeProps) => (
  <>
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Time:</Text>
      <View style={styles.timeInputContainer}>
        <TouchableOpacity style={styles.timeButton} onPress={() => setShowTimePicker(true)}>
          <Text style={styles.timeButtonText}>{notificationTime}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.addTimeButton} onPress={onAddTime}>
          <Text style={styles.addTimeButtonText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
    {(Platform.OS === 'ios' || Platform.OS === 'android') && showTimePicker && (
      <DateTimePicker
        value={parseTimeValue(notificationTime)}
        mode="time"
        is24Hour
        display="spinner"
        onChange={onTimeChange}
      />
    )}
    {notifTimes.length > 0 && <TimesList times={notifTimes} onRemoveTime={onRemoveTime} />}
  </>
);

const NotifToggleRow = ({
  isEnabled,
  onChange,
}: {
  isEnabled: boolean;
  onChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
}) => (
  <View style={styles.settingRow}>
    <Text style={styles.settingLabel}>Notifications:</Text>
    <Switch
      value={isEnabled}
      onValueChange={(value) => onChange('notificationFrequency', value ? 'daily' : 'off')}
    />
  </View>
);

const NotificationSettings = ({
  habit,
  notificationTime,
  showTimePicker,
  showDaysPicker,
  setShowTimePicker,
  setShowDaysPicker,
  onChange,
  onTimeChange,
  onAddTime,
  onRemoveTime,
  onToggleDay,
}: NotificationSettingsProps) => (
  <View style={styles.settingGroup}>
    <NotifToggleRow isEnabled={habit.notificationFrequency !== 'off'} onChange={onChange} />
    {habit.notificationFrequency !== 'off' && (
      <>
        <NotifFrequencySection
          habit={habit}
          showDaysPicker={showDaysPicker}
          setShowDaysPicker={setShowDaysPicker}
          onChange={onChange}
          onToggleDay={onToggleDay}
        />
        <NotifTimeSection
          notificationTime={notificationTime}
          showTimePicker={showTimePicker}
          notifTimes={habit.notificationTimes || []}
          setShowTimePicker={setShowTimePicker}
          onTimeChange={onTimeChange}
          onAddTime={onAddTime}
          onRemoveTime={onRemoveTime}
        />
      </>
    )}
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Milestone Notifications:</Text>
      <Switch
        value={habit.milestoneNotifications || false}
        onValueChange={(value) => onChange('milestoneNotifications', value)}
      />
    </View>
  </View>
);

interface SettingsFormProps {
  editedHabit: Habit;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  handleChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
  allHabits: Habit[];
  onOpenReorderModal: HabitSettingsModalProps['onOpenReorderModal'];
  notificationTime: string;
  showTimePicker: boolean;
  showDaysPicker: boolean;
  setShowTimePicker: (_v: boolean) => void;
  setShowDaysPicker: (_v: boolean) => void;
  onTimeChange: (_event: DateTimePickerEvent, _date?: Date) => void;
  onAddTime: () => void;
  onRemoveTime: (_time: string) => void;
  onToggleDay: (_day: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

interface BasicFieldsProps {
  editedHabit: Habit;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  handleChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
  allHabits: Habit[];
  onOpenReorderModal: HabitSettingsModalProps['onOpenReorderModal'];
}

const BasicFields = ({
  editedHabit,
  showEmojiSelector,
  setShowEmojiSelector,
  handleChange,
  allHabits,
  onOpenReorderModal,
}: BasicFieldsProps) => (
  <>
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
      <TouchableOpacity onPress={() => setShowEmojiSelector(!showEmojiSelector)}>
        <Text style={styles.currentIcon}>{editedHabit.icon}</Text>
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
          columns={6}
          emojiSize={28}
          placeholder="Search emoji..."
        />
      </View>
    )}
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Stage:</Text>
      <Text style={styles.settingValue}>{editedHabit.stage}</Text>
    </View>
    <TouchableOpacity style={styles.reorderButton} onPress={() => onOpenReorderModal(allHabits)}>
      <Text style={styles.reorderButtonText}>Reorder Habits</Text>
    </TouchableOpacity>
  </>
);

const EnergyAndDateSection = ({
  editedHabit,
  handleChange,
}: {
  editedHabit: Habit;
  handleChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;
}) => (
  <>
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Energy Rating:</Text>
    </View>
    <EnergySettings
      habit={editedHabit}
      netEnergy={calculateNetEnergy(editedHabit.energy_cost, editedHabit.energy_return)}
      onChange={handleChange}
    />
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Start Date:</Text>
      <DateTimePicker
        value={new Date(editedHabit.start_date)}
        mode="date"
        display="default"
        onChange={(event, date) => date && handleChange('start_date', date)}
      />
    </View>
  </>
);

const FormActionButtons = ({ onSave, onDelete }: { onSave: () => void; onDelete: () => void }) => (
  <View style={styles.buttonGroup}>
    <TouchableOpacity style={styles.saveButton} onPress={onSave}>
      <Text style={styles.saveButtonText}>Save Changes</Text>
    </TouchableOpacity>
    <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
      <Text style={styles.deleteButtonText}>Delete Habit</Text>
    </TouchableOpacity>
  </View>
);

const SettingsForm = ({
  editedHabit,
  showEmojiSelector,
  setShowEmojiSelector,
  handleChange,
  allHabits,
  onOpenReorderModal,
  notificationTime,
  showTimePicker,
  showDaysPicker,
  setShowTimePicker,
  setShowDaysPicker,
  onTimeChange,
  onAddTime,
  onRemoveTime,
  onToggleDay,
  onSave,
  onDelete,
}: SettingsFormProps) => (
  <ScrollView style={styles.settingsContainer}>
    <BasicFields
      editedHabit={editedHabit}
      showEmojiSelector={showEmojiSelector}
      setShowEmojiSelector={setShowEmojiSelector}
      handleChange={handleChange}
      allHabits={allHabits}
      onOpenReorderModal={onOpenReorderModal}
    />
    <EnergyAndDateSection editedHabit={editedHabit} handleChange={handleChange} />
    <NotificationSettings
      habit={editedHabit}
      notificationTime={notificationTime}
      showTimePicker={showTimePicker}
      showDaysPicker={showDaysPicker}
      setShowTimePicker={setShowTimePicker}
      setShowDaysPicker={setShowDaysPicker}
      onChange={handleChange}
      onTimeChange={onTimeChange}
      onAddTime={onAddTime}
      onRemoveTime={onRemoveTime}
      onToggleDay={onToggleDay}
    />
    <FormActionButtons onSave={onSave} onDelete={onDelete} />
  </ScrollView>
);

const formatTime = (date: Date): string =>
  `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

const useNotificationHandlers = (
  editedHabit: Habit | null,
  handleChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void,
) => {
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [notificationTime, setNotificationTime] = useState('08:00');
  const [showDaysPicker, setShowDaysPicker] = useState(false);

  const handleTimeChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowTimePicker(Platform.OS === 'ios');
    if (selectedDate) setNotificationTime(formatTime(selectedDate));
  };

  const handleAddTime = () => {
    const times = editedHabit?.notificationTimes || [];
    if (!times.includes(notificationTime))
      handleChange('notificationTimes', [...times, notificationTime]);
  };

  const handleRemoveTime = (time: string) => {
    handleChange(
      'notificationTimes',
      (editedHabit?.notificationTimes || []).filter((t) => t !== time),
    );
  };

  const handleToggleDay = (day: string) => {
    const days = editedHabit?.notificationDays || [];
    handleChange(
      'notificationDays',
      days.includes(day) ? days.filter((d) => d !== day) : [...days, day],
    );
  };

  return {
    showTimePicker,
    setShowTimePicker,
    notificationTime,
    showDaysPicker,
    setShowDaysPicker,
    handleTimeChange,
    handleAddTime,
    handleRemoveTime,
    handleToggleDay,
  };
};

const useSettingsHandlers = (
  editedHabit: Habit | null,
  habit: Habit | null,
  onUpdate: HabitSettingsModalProps['onUpdate'],
  onDeleteProp: HabitSettingsModalProps['onDelete'],
  onClose: () => void,
  handleChange: <K extends keyof Habit>(_field: K, _value: Habit[K]) => void,
) => {
  const notif = useNotificationHandlers(editedHabit, handleChange);

  const handleSave = () => {
    if (editedHabit && habit?.id) {
      onUpdate({ ...editedHabit, id: habit.id });
      onClose();
    }
  };

  const handleDelete = () => {
    if (!habit?.id) return;
    Alert.alert('Delete Habit', `Are you sure you want to delete "${habit.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          onDeleteProp(habit.id!);
          onClose();
        },
      },
    ]);
  };

  return { ...notif, handleSave, handleDelete };
};

const SettingsModalHeader = ({ onClose }: { onClose: () => void }) => (
  <View style={styles.modalHeader}>
    <Text style={styles.modalTitle}>Edit Habit</Text>
    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
      <Text style={styles.closeButtonText}>×</Text>
    </TouchableOpacity>
  </View>
);

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
  const [showEmojiSelector, setShowEmojiSelector] = useState(false);

  useEffect(() => {
    setEditedHabit(habit ? { ...habit } : null);
  }, [habit, visible]);

  const handleChange = <K extends keyof Habit>(field: K, value: Habit[K]) => {
    setEditedHabit((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  const h = useSettingsHandlers(editedHabit, habit, onUpdate, onDelete, onClose, handleChange);

  if (!editedHabit) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View
          style={[styles.settingsModalContent, { borderTopColor: STAGE_COLORS[editedHabit.stage] }]}
        >
          <SettingsModalHeader onClose={onClose} />
          <SettingsForm
            editedHabit={editedHabit}
            showEmojiSelector={showEmojiSelector}
            setShowEmojiSelector={setShowEmojiSelector}
            handleChange={handleChange}
            allHabits={allHabits}
            onOpenReorderModal={onOpenReorderModal}
            notificationTime={h.notificationTime}
            showTimePicker={h.showTimePicker}
            showDaysPicker={h.showDaysPicker}
            setShowTimePicker={h.setShowTimePicker}
            setShowDaysPicker={h.setShowDaysPicker}
            onTimeChange={h.handleTimeChange}
            onAddTime={h.handleAddTime}
            onRemoveTime={h.handleRemoveTime}
            onToggleDay={h.handleToggleDay}
            onSave={h.handleSave}
            onDelete={h.handleDelete}
          />
        </View>
      </View>
    </Modal>
  );
};

export default HabitSettingsModal;
