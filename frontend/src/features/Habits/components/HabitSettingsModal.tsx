import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Modal, Platform, ScrollView, Switch } from 'react-native';

import { Button } from '../../../components/Button';
import { TextField } from '../../../components/TextField';
import { STAGE_COLORS } from '../../../design/tokens';
import { DAYS_OF_WEEK } from '../constants';
import styles from '../Habits.styles';
import type { Habit, HabitSettingsModalProps } from '../Habits.types';

import ConfirmDialog from './ConfirmDialog';
import { EnergyCostReturnEditor } from './EnergyCostReturnEditor';
import HabitEmojiPicker from './HabitEmojiPicker';
import ModalHeader from './ModalHeader';

const LOCK_TOGGLE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };
// Enlarges the 24dp remove-time pill to a 44dp accessible touch target.
const REMOVE_TIME_HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };
const FREQUENCY_OPTIONS = ['daily', 'weekly', 'custom'] as const;

type ChangeHandler = <K extends keyof Habit>(_field: K, _value: Habit[K]) => void;

const SettingsSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={styles.settingsSection}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {children}
  </View>
);

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
        <Text style={[styles.dayOptionText, days.includes(day) && styles.dayOptionTextSelected]}>
          {day.substring(0, 3)}
        </Text>
      </TouchableOpacity>
    ))}
  </View>
);

const formatDaysLabel = (days: string[] | undefined): string =>
  days && days.length > 0 ? days.map((d) => d.substring(0, 3)).join(', ') : 'Select days';

const FrequencyChip = ({
  value,
  selected,
  onSelect,
}: {
  value: (typeof FREQUENCY_OPTIONS)[number];
  selected: boolean;
  onSelect: (_value: (typeof FREQUENCY_OPTIONS)[number]) => void;
}) => (
  <TouchableOpacity
    testID={`habit-settings-frequency-${value}`}
    accessibilityRole="radio"
    accessibilityState={{ checked: selected }}
    accessibilityLabel={value}
    style={[styles.freqChip, selected && styles.freqChipSelected]}
    onPress={() => onSelect(value)}
  >
    <Text style={[styles.freqChipText, selected && styles.freqChipTextSelected]}>{value}</Text>
  </TouchableOpacity>
);

const FrequencyChipRow = ({ habit, onChange }: { habit: Habit; onChange: ChangeHandler }) => {
  const current = habit.notificationFrequency ?? 'daily';
  return (
    <View
      testID="habit-settings-frequency"
      accessibilityRole="radiogroup"
      style={styles.freqChipRow}
    >
      {FREQUENCY_OPTIONS.map((value) => (
        <FrequencyChip
          key={value}
          value={value}
          selected={current === value}
          onSelect={(next) => onChange('notificationFrequency', next)}
        />
      ))}
    </View>
  );
};

const CustomDaysPicker = ({
  habit,
  showDaysPicker,
  setShowDaysPicker,
  onToggleDay,
}: {
  habit: Habit;
  showDaysPicker: boolean;
  setShowDaysPicker: (_v: boolean) => void;
  onToggleDay: (_day: string) => void;
}) => (
  <>
    <View style={styles.settingRow}>
      <Text style={styles.editSettingLabel}>Days:</Text>
      <TouchableOpacity
        style={styles.daysButton}
        onPress={() => setShowDaysPicker(!showDaysPicker)}
      >
        <Text style={styles.daysButtonText}>{formatDaysLabel(habit.notificationDays)}</Text>
      </TouchableOpacity>
    </View>
    {showDaysPicker && (
      <DayPickerGrid days={habit.notificationDays || []} onToggleDay={onToggleDay} />
    )}
  </>
);

const TimesList = ({
  times,
  onRemoveTime,
}: {
  times: string[];
  onRemoveTime: (_time: string) => void;
}) => (
  <View style={styles.timesList}>
    {times.map((time) => (
      <View key={time} style={styles.timeItem}>
        <Text style={styles.timeText}>{time}</Text>
        <TouchableOpacity
          testID={`habit-settings-remove-time-${time}`}
          accessibilityLabel={`Remove ${time}`}
          hitSlop={REMOVE_TIME_HIT_SLOP}
          style={styles.removeTimeButton}
          onPress={() => onRemoveTime(time)}
        >
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

interface NotifTimeProps {
  notificationTime: string;
  showTimePicker: boolean;
  notifTimes: string[];
  setShowTimePicker: (_v: boolean) => void;
  onTimeChange: (_event: DateTimePickerEvent, _date?: Date) => void;
  onAddTime: () => void;
  onRemoveTime: (_time: string) => void;
}

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
      <Text style={styles.editSettingLabel}>Time:</Text>
      <View style={styles.timeInputContainer}>
        <TouchableOpacity style={styles.timeButton} onPress={() => setShowTimePicker(true)}>
          <Text style={styles.timeButtonText}>{notificationTime}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="habit-settings-add-time"
          accessibilityLabel="Add reminder time"
          style={styles.addTimeButton}
          onPress={onAddTime}
        >
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

const NotificationsToggleRow = ({
  isEnabled,
  onChange,
}: {
  isEnabled: boolean;
  onChange: ChangeHandler;
}) => (
  <View style={styles.settingRow}>
    <Text style={styles.editSettingLabel}>Notifications:</Text>
    <Switch
      testID="habit-settings-notifications-toggle"
      value={isEnabled}
      onValueChange={(value) => onChange('notificationFrequency', value ? 'daily' : 'off')}
    />
  </View>
);

const MilestoneToggleRow = ({ habit, onChange }: { habit: Habit; onChange: ChangeHandler }) => (
  <View style={styles.settingRow}>
    <Text style={styles.editSettingLabel}>Milestone Notifications:</Text>
    <Switch
      testID="habit-settings-milestone-toggle"
      value={habit.milestoneNotifications || false}
      onValueChange={(value) => onChange('milestoneNotifications', value)}
    />
  </View>
);

const LockToggleRow = ({
  editedHabit,
  handleChange,
}: {
  editedHabit: Habit;
  handleChange: ChangeHandler;
}) => (
  <View style={styles.settingRow}>
    <Text style={styles.editSettingLabel}>Unlocked:</Text>
    <Switch
      testID="habit-settings-lock-toggle"
      accessibilityLabel="Unlocked"
      hitSlop={LOCK_TOGGLE_HIT_SLOP}
      value={editedHabit.revealed === true}
      onValueChange={(value) => handleChange('revealed', value)}
    />
  </View>
);

interface HabitSectionProps {
  editedHabit: Habit;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  handleChange: ChangeHandler;
}

const HabitSection = ({
  editedHabit,
  showEmojiSelector,
  setShowEmojiSelector,
  handleChange,
}: HabitSectionProps) => (
  <SettingsSection title="Habit">
    <View style={styles.settingRow}>
      <Text style={styles.editSettingLabel}>Name:</Text>
      <TextField
        value={editedHabit.name}
        onChangeText={(text) => handleChange('name', text)}
        style={styles.settingFieldFlex}
      />
    </View>
    <View style={styles.settingRow}>
      <Text style={styles.editSettingLabel}>Icon:</Text>
      <TouchableOpacity onPress={() => setShowEmojiSelector(!showEmojiSelector)}>
        <Text style={styles.currentIcon}>{editedHabit.icon}</Text>
      </TouchableOpacity>
    </View>
    <HabitEmojiPicker
      visible={showEmojiSelector}
      onSelect={(emoji) => {
        handleChange('icon', emoji);
        setShowEmojiSelector(false);
      }}
      onClose={() => setShowEmojiSelector(false)}
    />
    <View style={styles.settingRow}>
      <Text style={styles.editSettingLabel}>Stage:</Text>
      <Text style={styles.settingValue}>{editedHabit.stage}</Text>
    </View>
    <LockToggleRow editedHabit={editedHabit} handleChange={handleChange} />
  </SettingsSection>
);

const EnergySection = ({
  editedHabit,
  handleChange,
}: {
  editedHabit: Habit;
  handleChange: ChangeHandler;
}) => (
  <SettingsSection title="Energy">
    <EnergyCostReturnEditor
      cost={editedHabit.energy_cost}
      energyReturn={editedHabit.energy_return}
      onCommitCost={(value) => handleChange('energy_cost', value)}
      onCommitReturn={(value) => handleChange('energy_return', value)}
    />
  </SettingsSection>
);

const ScheduleSection = ({
  editedHabit,
  handleChange,
}: {
  editedHabit: Habit;
  handleChange: ChangeHandler;
}) => (
  <SettingsSection title="Schedule">
    <View style={styles.settingRow}>
      <Text style={styles.editSettingLabel}>Start Date:</Text>
      <DateTimePicker
        value={new Date(editedHabit.start_date)}
        mode="date"
        display="default"
        onChange={(_event, date) => date && handleChange('start_date', date)}
      />
    </View>
  </SettingsSection>
);

interface RemindersSectionProps {
  habit: Habit;
  notificationTime: string;
  showTimePicker: boolean;
  showDaysPicker: boolean;
  setShowTimePicker: (_v: boolean) => void;
  setShowDaysPicker: (_v: boolean) => void;
  onChange: ChangeHandler;
  onTimeChange: (_event: DateTimePickerEvent, _date?: Date) => void;
  onAddTime: () => void;
  onRemoveTime: (_time: string) => void;
  onToggleDay: (_day: string) => void;
}

const RemindersSection = ({
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
}: RemindersSectionProps) => {
  const notificationsOn = habit.notificationFrequency !== 'off';
  return (
    <SettingsSection title="Reminders">
      <NotificationsToggleRow isEnabled={notificationsOn} onChange={onChange} />
      {notificationsOn && (
        <>
          <FrequencyChipRow habit={habit} onChange={onChange} />
          {habit.notificationFrequency === 'custom' && (
            <CustomDaysPicker
              habit={habit}
              showDaysPicker={showDaysPicker}
              setShowDaysPicker={setShowDaysPicker}
              onToggleDay={onToggleDay}
            />
          )}
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
      <MilestoneToggleRow habit={habit} onChange={onChange} />
    </SettingsSection>
  );
};

const UtilityRow = ({
  allHabits,
  onOpenReorderModal,
}: {
  allHabits: Habit[];
  onOpenReorderModal: HabitSettingsModalProps['onOpenReorderModal'];
}) => (
  <View style={styles.utilityRow}>
    <Button
      label="Reorder Habits"
      variant="secondary"
      onPress={() => onOpenReorderModal(allHabits)}
      testID="habit-settings-reorder"
    />
  </View>
);

const DangerZoneSection = ({ onDelete }: { onDelete: () => void }) => (
  <SettingsSection title="Danger Zone">
    <TouchableOpacity testID="habit-settings-delete" style={styles.deleteButton} onPress={onDelete}>
      <Text style={styles.deleteButtonText}>Delete Habit</Text>
    </TouchableOpacity>
  </SettingsSection>
);

interface SettingsFormProps {
  editedHabit: Habit;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  handleChange: ChangeHandler;
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

const SaveRow = ({ onSave }: { onSave: () => void }) => (
  <View style={styles.saveRow}>
    <Button label="Save Changes" variant="primary" onPress={onSave} testID="habit-settings-save" />
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
    <HabitSection
      editedHabit={editedHabit}
      showEmojiSelector={showEmojiSelector}
      setShowEmojiSelector={setShowEmojiSelector}
      handleChange={handleChange}
    />
    <EnergySection editedHabit={editedHabit} handleChange={handleChange} />
    <ScheduleSection editedHabit={editedHabit} handleChange={handleChange} />
    <RemindersSection
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
    <UtilityRow allHabits={allHabits} onOpenReorderModal={onOpenReorderModal} />
    <SaveRow onSave={onSave} />
    <DangerZoneSection onDelete={onDelete} />
  </ScrollView>
);

const formatTime = (date: Date): string =>
  `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

const useNotificationHandlers = (editedHabit: Habit | null, handleChange: ChangeHandler) => {
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
  handleChange: ChangeHandler,
) => {
  const notif = useNotificationHandlers(editedHabit, handleChange);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleSave = () => {
    if (editedHabit && habit?.id) {
      onUpdate({ ...editedHabit, id: habit.id });
      onClose();
    }
  };

  const handleDelete = () => {
    if (!habit?.id) return;
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    if (!habit?.id) return;
    setShowDeleteConfirm(false);
    onDeleteProp(habit.id);
    onClose();
  };

  return {
    ...notif,
    handleSave,
    handleDelete,
    showDeleteConfirm,
    setShowDeleteConfirm,
    confirmDelete,
  };
};

interface SettingsBodyProps {
  editedHabit: Habit;
  showEmojiSelector: boolean;
  setShowEmojiSelector: (_v: boolean) => void;
  handleChange: ChangeHandler;
  allHabits: Habit[];
  onClose: () => void;
  onOpenReorderModal: HabitSettingsModalProps['onOpenReorderModal'];
  h: ReturnType<typeof useSettingsHandlers>;
}

const SettingsModalBody = ({
  editedHabit,
  showEmojiSelector,
  setShowEmojiSelector,
  handleChange,
  allHabits,
  onClose,
  onOpenReorderModal,
  h,
}: SettingsBodyProps) => (
  <View style={styles.modalOverlay}>
    <View
      testID="habit-settings-card"
      style={[styles.editModalCard, { borderTopColor: STAGE_COLORS[editedHabit.stage] }]}
    >
      <ModalHeader title="Edit Habit" onClose={onClose} closeTestID="habit-settings-close" />
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
      <SettingsModalBody
        editedHabit={editedHabit}
        showEmojiSelector={showEmojiSelector}
        setShowEmojiSelector={setShowEmojiSelector}
        handleChange={handleChange}
        allHabits={allHabits}
        onClose={onClose}
        onOpenReorderModal={onOpenReorderModal}
        h={h}
      />
      <ConfirmDialog
        visible={h.showDeleteConfirm}
        title="Are you sure?"
        message="This is permanent."
        testID="delete-habit-confirm"
        cancelTestID="delete-habit-cancel"
        confirmTestID="delete-habit-confirm-button"
        confirmLabel="Delete"
        destructive
        onCancel={() => h.setShowDeleteConfirm(false)}
        onConfirm={h.confirmDelete}
      />
    </Modal>
  );
};

export default HabitSettingsModal;
