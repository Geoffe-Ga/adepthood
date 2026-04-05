import React, { useState } from 'react';
import { TextInput, TouchableOpacity, View, Text } from 'react-native';

import styles from './Journal.styles';

interface ChatInputProps {
  // eslint-disable-next-line no-unused-vars
  onSend: (_text: string) => void;
  disabled?: boolean;
}

const ChatInput = ({ onSend, disabled = false }: ChatInputProps): React.JSX.Element => {
  const [text, setText] = useState('');

  const handleSend = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setText('');
  };

  const canSend = text.trim().length > 0 && !disabled;

  return (
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
        testID="send-button"
        style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        onPress={handleSend}
        disabled={!canSend}
        accessibilityLabel="Send message"
      >
        <Text style={styles.sendButtonText}>{'>'}</Text>
      </TouchableOpacity>
    </View>
  );
};

export default ChatInput;
