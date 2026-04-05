import React from 'react';
import { Text, View } from 'react-native';

import type { JournalMessage } from '../../api';

import styles from './Journal.styles';

const TAG_LABELS: Record<string, string> = {
  stage_reflection: 'Reflection',
  practice_note: 'Practice',
  habit_note: 'Habit',
};

function getTags(message: JournalMessage): string[] {
  const tags: string[] = [];
  if (message.is_stage_reflection) tags.push('stage_reflection');
  if (message.is_practice_note) tags.push('practice_note');
  if (message.is_habit_note) tags.push('habit_note');
  return tags;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface MessageBubbleProps {
  message: JournalMessage;
}

const MessageBubble = ({ message }: MessageBubbleProps): React.JSX.Element => {
  const isUser = message.sender === 'user';
  const tags = getTags(message);

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
        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{TAG_LABELS[tag]}</Text>
              </View>
            ))}
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
