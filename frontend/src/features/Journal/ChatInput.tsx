import React, { useCallback, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { JournalTag } from '../../api';

import styles from './Journal.styles';

const TAG_OPTIONS: Array<{ value: JournalTag; label: string }> = [
  { value: 'stage_reflection', label: 'Reflection' },
  { value: 'practice_note', label: 'Practice' },
  { value: 'habit_note', label: 'Habit' },
];

interface ChatInputProps {
  onSend: (_text: string, _tag?: JournalTag) => void;
  disabled?: boolean;
  initialTag?: JournalTag;
}

interface TagPickerProps {
  activeTag: JournalTag | undefined;
  onSelectTag: (_tag: JournalTag | undefined) => void;
}

const TagPicker = ({ activeTag, onSelectTag }: TagPickerProps): React.JSX.Element => (
  <View style={styles.tagPickerContainer} testID="tag-picker">
    {TAG_OPTIONS.map(({ value, label }) => {
      const isActive = activeTag === value;
      return (
        <TouchableOpacity
          key={value}
          testID={`tag-option-${value}`}
          style={[styles.tagPickerOption, isActive && styles.tagPickerOptionActive]}
          onPress={() => onSelectTag(isActive ? undefined : value)}
        >
          <Text style={[styles.tagPickerText, isActive && styles.tagPickerTextActive]}>
            {label}
          </Text>
        </TouchableOpacity>
      );
    })}
  </View>
);

interface InputRowProps {
  text: string;
  onChangeText: (_text: string) => void;
  disabled: boolean;
  canSend: boolean;
  onSend: () => void;
  hasActiveTag: boolean;
  onToggleTagPicker: () => void;
}

const InputRow = ({
  text,
  onChangeText,
  disabled,
  canSend,
  onSend,
  hasActiveTag,
  onToggleTagPicker,
}: InputRowProps): React.JSX.Element => (
  <View style={styles.inputContainer}>
    <TextInput
      testID="chat-input"
      style={styles.textInput}
      value={text}
      onChangeText={onChangeText}
      placeholder="Write a reflection..."
      placeholderTextColor="#999"
      multiline
      editable={!disabled}
    />
    <TouchableOpacity
      testID="tag-toggle"
      style={[styles.tagToggleButton, hasActiveTag && styles.tagToggleButtonActive]}
      onPress={onToggleTagPicker}
      accessibilityLabel="Toggle tag picker"
    >
      <Text style={styles.tagToggleText}>#</Text>
    </TouchableOpacity>
    <TouchableOpacity
      testID="send-button"
      style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
      onPress={onSend}
      disabled={!canSend}
      accessibilityLabel="Send message"
    >
      <Text style={styles.sendButtonText}>{'>'}</Text>
    </TouchableOpacity>
  </View>
);

const ChatInput = ({ onSend, disabled = false, initialTag }: ChatInputProps): React.JSX.Element => {
  const [text, setText] = useState('');
  const [selectedTag, setSelectedTag] = useState<JournalTag | undefined>(initialTag);
  const [showTagPicker, setShowTagPicker] = useState(false);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed, selectedTag);
    setText('');
    setSelectedTag(initialTag);
    setShowTagPicker(false);
  }, [text, onSend, selectedTag, initialTag]);

  const toggleTagPicker = useCallback(() => {
    setShowTagPicker((prev) => !prev);
  }, []);

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <View>
      {showTagPicker && <TagPicker activeTag={selectedTag} onSelectTag={setSelectedTag} />}
      <InputRow
        text={text}
        onChangeText={setText}
        disabled={disabled}
        canSend={canSend}
        onSend={handleSend}
        hasActiveTag={selectedTag !== undefined}
        onToggleTagPicker={toggleTagPicker}
      />
    </View>
  );
};

export default ChatInput;
