import React, { useEffect, useState } from 'react';
import { Modal, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { DEFAULT_ICONS } from '../constants';
import styles from '../Habits.styles';
import type { AddHabitInput } from '../Habits.types';

import { EnergyCostReturnEditor } from './EnergyCostReturnEditor';
import HabitEmojiPicker from './HabitEmojiPicker';

interface AddHabitModalProps {
  visible: boolean;
  onClose: () => void;
  onAdd: (_input: AddHabitInput) => void | Promise<void>;
}

const DEFAULT_ENERGY = 5;

const randomDefaultIcon = (): string =>
  DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)] ?? '⭐';

const AddHabitHeader = ({ onClose }: { onClose: () => void }) => (
  <View style={styles.modalHeader}>
    <Text style={styles.modalTitle}>Add Habit</Text>
    <TouchableOpacity onPress={onClose} style={styles.closeButton} testID="add-habit-close">
      <Text style={styles.closeButtonText}>×</Text>
    </TouchableOpacity>
  </View>
);

interface NameRowProps {
  name: string;
  setName: (_v: string) => void;
}

const NameRow = ({ name, setName }: NameRowProps) => (
  <View style={styles.settingRow}>
    <Text style={styles.settingLabel}>Name:</Text>
    <TextInput
      testID="add-habit-name"
      style={styles.settingInput}
      value={name}
      onChangeText={setName}
      placeholder="e.g. Morning Walk"
      autoFocus
    />
  </View>
);

interface IconRowProps {
  icon: string;
  showEmojiPicker: boolean;
  setShowEmojiPicker: (_v: boolean) => void;
  setIcon: (_v: string) => void;
}

const IconRow = ({ icon, showEmojiPicker, setShowEmojiPicker, setIcon }: IconRowProps) => (
  <>
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>Icon:</Text>
      <TouchableOpacity
        testID="add-habit-icon"
        onPress={() => setShowEmojiPicker(!showEmojiPicker)}
      >
        <Text style={styles.currentIcon}>{icon}</Text>
      </TouchableOpacity>
    </View>
    {showEmojiPicker && (
      <View style={styles.emojiSelectorContainer}>
        <HabitEmojiPicker
          onEmojiSelected={(emoji) => {
            setIcon(emoji);
            setShowEmojiPicker(false);
          }}
        />
      </View>
    )}
  </>
);

interface SaveRowProps {
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
}

const SaveRow = ({ saving, canSave, onSave }: SaveRowProps) => {
  const disabled = saving || !canSave;
  return (
    <View style={styles.buttonGroup}>
      <TouchableOpacity
        testID="add-habit-save"
        style={[styles.onboardingContinueButton, disabled && styles.disabledButton]}
        onPress={onSave}
        disabled={disabled}
      >
        <Text style={styles.onboardingContinueButtonText}>{saving ? 'Adding…' : 'Add Habit'}</Text>
      </TouchableOpacity>
    </View>
  );
};

interface AddHabitFormState {
  name: string;
  icon: string;
  energyCost: number;
  energyReturn: number;
  showEmojiPicker: boolean;
  setName: (_v: string) => void;
  setIcon: (_v: string) => void;
  setEnergyCost: (_v: number) => void;
  setEnergyReturn: (_v: number) => void;
  setShowEmojiPicker: (_v: boolean) => void;
}

const useAddHabitForm = (visible: boolean): AddHabitFormState => {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(randomDefaultIcon());
  const [energyCost, setEnergyCost] = useState<number>(DEFAULT_ENERGY);
  const [energyReturn, setEnergyReturn] = useState<number>(DEFAULT_ENERGY);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  useEffect(() => {
    if (visible) {
      setName('');
      setIcon(randomDefaultIcon());
      setEnergyCost(DEFAULT_ENERGY);
      setEnergyReturn(DEFAULT_ENERGY);
      setShowEmojiPicker(false);
    }
  }, [visible]);

  return {
    name,
    icon,
    energyCost,
    energyReturn,
    showEmojiPicker,
    setName,
    setIcon,
    setEnergyCost,
    setEnergyReturn,
    setShowEmojiPicker,
  };
};

export const AddHabitModal = ({ visible, onClose, onAdd }: AddHabitModalProps) => {
  const f = useAddHabitForm(visible);
  const [saving, setSaving] = useState(false);
  const trimmed = f.name.trim();
  const canSave = trimmed.length > 0;

  /**
   * Await `onAdd` before closing so the optimistic toast (or the rollback
   * error toast on failure) lands while the modal is still around for the
   * user to read. Holding `saving` also disables the button so a double-tap
   * cannot double-submit while the network round-trip is in flight. The
   * rejection is intentionally swallowed: `habitManager.addHabit` already
   * routes failures through the rollback toast, so re-throwing here would
   * surface a duplicate unhandled-promise warning to no user benefit.
   */
  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onAdd({
        name: trimmed,
        icon: f.icon,
        energy_cost: f.energyCost,
        energy_return: f.energyReturn,
      });
    } catch {
      // already reported by the service layer
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.settingsModalContent} testID="add-habit-modal">
          <AddHabitHeader onClose={onClose} />
          <NameRow name={f.name} setName={f.setName} />
          <IconRow
            icon={f.icon}
            showEmojiPicker={f.showEmojiPicker}
            setShowEmojiPicker={f.setShowEmojiPicker}
            setIcon={f.setIcon}
          />
          <EnergyCostReturnEditor
            cost={f.energyCost}
            energyReturn={f.energyReturn}
            onCommitCost={f.setEnergyCost}
            onCommitReturn={f.setEnergyReturn}
            costTestID="add-habit-cost"
            returnTestID="add-habit-return"
          />
          <SaveRow saving={saving} canSave={canSave} onSave={() => void handleSave()} />
        </View>
      </View>
    </Modal>
  );
};

export default AddHabitModal;
