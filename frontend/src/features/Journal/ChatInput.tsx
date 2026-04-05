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
  initialTags?: MessageTags;
}

interface TagPickerProps {
  tags: MessageTags;
  onToggleTag: (_key: keyof MessageTags) => void;
}

const TagPicker = ({ tags, onToggleTag }: TagPickerProps): React.JSX.Element => (
  <View style={styles.tagPickerContainer} testID="tag-picker">
    {TAG_OPTIONS.map(({ key, label }) => (
      <TouchableOpacity
        key={key}
        testID={`tag-option-${key}`}
        style={[styles.tagPickerOption, tags[key] && styles.tagPickerOptionActive]}
        onPress={() => onToggleTag(key)}
      >
        <Text style={[styles.tagPickerText, tags[key] && styles.tagPickerTextActive]}>{label}</Text>
      </TouchableOpacity>
    ))}
  </View>
);

interface InputRowProps {
  text: string;
  onChangeText: (_text: string) => void;
  disabled: boolean;
  canSend: boolean;
  onSend: () => void;
  hasActiveTags: boolean;
  onToggleTagPicker: () => void;
}

const InputRow = ({
  text,
  onChangeText,
  disabled,
  canSend,
  onSend,
  hasActiveTags,
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
      style={[styles.tagToggleButton, hasActiveTags && styles.tagToggleButtonActive]}
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

const ChatInput = ({
  onSend,
  disabled = false,
  initialTags,
}: ChatInputProps): React.JSX.Element => {
  const [text, setText] = useState('');
  const [tags, setTags] = useState<MessageTags>(initialTags ?? DEFAULT_TAGS);
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
      {showTagPicker && <TagPicker tags={tags} onToggleTag={toggleTag} />}
      <InputRow
        text={text}
        onChangeText={setText}
        disabled={disabled}
        canSend={canSend}
        onSend={handleSend}
        hasActiveTags={hasActiveTags}
        onToggleTagPicker={toggleTagPicker}
      />
    </View>
  );
};

export default ChatInput;
