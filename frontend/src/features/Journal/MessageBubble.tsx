import React from 'react';
import { Text, View } from 'react-native';

import type { JournalMessage } from '../../api';

import styles from './Journal.styles';

const TAG_LABELS: Record<string, string> = {
  stage_reflection: 'Reflection',
  practice_note: 'Practice',
  habit_note: 'Habit',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface MessageBubbleProps {
  message: JournalMessage;
}

const MessageBubble = ({ message }: MessageBubbleProps): React.JSX.Element => {
  const isUser = message.sender === 'user';
  const tagLabel = TAG_LABELS[message.tag];

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowBot]}>
      {!isUser && (
        <View style={styles.botAvatar}>
          <Text style={styles.botAvatarText}>B</Text>
        </View>
      )}
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleBot]}>
        <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextBot]}>
          {message.message}
        </Text>
        {(tagLabel !== undefined || message.practice_session_id !== null) && (
          <View style={styles.tagRow}>
            {message.practice_session_id !== null && (
              <View style={styles.tag} testID="practice-session-badge">
                <Text style={styles.tagText}>Practice Session</Text>
              </View>
            )}
            {tagLabel !== undefined && (
              <View style={styles.tag}>
                <Text style={styles.tagText}>{tagLabel}</Text>
              </View>
            )}
          </View>
        )}
        <Text style={[styles.timestamp, isUser ? styles.timestampUser : styles.timestampBot]}>
          {formatTimestamp(message.timestamp)}
        </Text>
      </View>
    </View>
  );
};

export default MessageBubble;
