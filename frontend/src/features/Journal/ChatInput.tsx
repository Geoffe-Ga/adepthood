import React, { useCallback, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import styles from './Journal.styles';

export interface MessageTags {
  is_stage_reflection: boolean;
  is_practice_note: boolean;
  is_habit_note: boolean;
}

const DEFAULT_TAGS: MessageTags = {
  is_stage_reflection: false,
  is_practice_note: false,
  is_habit_note: false,
};

const TAG_OPTIONS: Array<{ key: keyof MessageTags; label: string }> = [
  { key: 'is_stage_reflection', label: 'Reflection' },
  { key: 'is_practice_note', label: 'Practice' },
  { key: 'is_habit_note', label: 'Habit' },
];

interface ChatInputProps {
  onSend: (_text: string, _tags?: MessageTags) => void;
  disabled?: boolean;
}

const ChatInput = ({ onSend, disabled = false }: ChatInputProps): React.JSX.Element => {
  const [text, setText] = useState('');
  const [tags, setTags] = useState<MessageTags>(DEFAULT_TAGS);
  const [showTagPicker, setShowTagPicker] = useState(false);

  const hasActiveTags = tags.is_stage_reflection || tags.is_practice_note || tags.is_habit_note;

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed, hasActiveTags ? tags : undefined);
    setText('');
    setTags(DEFAULT_TAGS);
    setShowTagPicker(false);
  }, [text, onSend, tags, hasActiveTags]);

  const toggleTag = useCallback((key: keyof MessageTags) => {
    setTags((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const toggleTagPicker = useCallback(() => {
    setShowTagPicker((prev) => !prev);
  }, []);

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <View>
      {showTagPicker && (
        <View style={styles.tagPickerContainer} testID="tag-picker">
          {TAG_OPTIONS.map(({ key, label }) => (
            <TouchableOpacity
              key={key}
              testID={`tag-option-${key}`}
              style={[styles.tagPickerOption, tags[key] && styles.tagPickerOptionActive]}
              onPress={() => toggleTag(key)}
            >
              <Text style={[styles.tagPickerText, tags[key] && styles.tagPickerTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={styles.inputContainer}>
        <TextInput
          testID="chat-input"
          style={styles.textInput}
          value={text}
          onChangeText={setText}
          placeholder="Write a reflection..."
          placeholderTextColor="#999"
          multiline
          editable={!disabled}
        />
        <TouchableOpacity
          testID="tag-toggle"
          style={[styles.tagToggleButton, hasActiveTags && styles.tagToggleButtonActive]}
          onPress={toggleTagPicker}
          accessibilityLabel="Toggle tag picker"
        >
          <Text style={styles.tagToggleText}>#</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="send-button"
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!canSend}
          accessibilityLabel="Send message"
        >
          <Text style={styles.sendButtonText}>{'>'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default ChatInput;
