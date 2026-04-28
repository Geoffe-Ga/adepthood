import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { JournalMessage, JournalTag } from '../../api';

import styles from './Journal.styles';

const TAG_LABELS: Record<string, string> = {
  stage_reflection: 'Reflection',
  practice_note: 'Practice',
  habit_note: 'Habit',
};

/**
 * UI-local extension of :class:`JournalMessage` carrying ephemeral state that
 * never crosses the wire. ``_streaming`` is true while tokens are still
 * arriving for the bot's reply; ``_errored`` flags a user message whose
 * BotMason round-trip failed and needs a retry button.
 *
 * `id` widens `JournalMessage.id` from `number` to `number | string` so the
 * optimistic local id can be a UUID (BUG-FE-JOURNAL-003: `Date.now()`-based
 * ids collide on retry). The server still returns numeric ids; reconciling
 * is just a swap by `===` match on the optimistic id.
 */
export interface ChatMessage extends Omit<JournalMessage, 'id'> {
  id: number | string;
  _streaming?: boolean;
  _errored?: boolean;
  _errorDetail?: string;
  _retryText?: string;
  _retryTag?: JournalTag;
}

/**
 * Text cursor shown at the end of a streaming bot message to make the
 * "still typing" state unmistakable. Exported so tests can assert on the
 * exact glyph rather than a class name.
 */
export const STREAMING_CURSOR = '\u258A';

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface BubbleTagsProps {
  message: ChatMessage;
  tagLabel: string | undefined;
}

const BubbleTags = ({ message, tagLabel }: BubbleTagsProps): React.JSX.Element | null => {
  const showPracticeBadge = message.practice_session_id !== null;
  const showTagLabel = tagLabel !== undefined;
  if (!showPracticeBadge && !showTagLabel) return null;
  return (
    <View style={styles.tagRow}>
      {showPracticeBadge && (
        <View style={styles.tag} testID="practice-session-badge">
          <Text style={styles.tagText}>Practice Session</Text>
        </View>
      )}
      {showTagLabel && (
        <View style={styles.tag}>
          <Text style={styles.tagText}>{tagLabel}</Text>
        </View>
      )}
    </View>
  );
};

interface ErrorFooterProps {
  errorLabel: string | undefined;
  onRetry: (() => void) | undefined;
}

const ErrorFooter = ({ errorLabel, onRetry }: ErrorFooterProps): React.JSX.Element => (
  <View testID="message-error" style={styles.tagRow}>
    {errorLabel !== undefined && errorLabel !== '' && (
      <Text style={styles.tagText}>{errorLabel}</Text>
    )}
    {onRetry !== undefined && (
      <TouchableOpacity
        testID="message-retry"
        style={styles.tag}
        onPress={onRetry}
        accessibilityLabel="Retry sending message"
        accessibilityRole="button"
      >
        <Text style={styles.tagText}>Retry</Text>
      </TouchableOpacity>
    )}
  </View>
);

interface MessageBubbleProps {
  message: ChatMessage;
  /** Human-readable error label surfaced beneath the bubble when retry is active. */
  errorLabel?: string;
  /** When set, a "Retry" button is rendered; pressing it re-sends the message. */
  onRetry?: () => void;
}

const MessageBubble = ({ message, errorLabel, onRetry }: MessageBubbleProps): React.JSX.Element => {
  const isUser = message.sender === 'user';
  const tagLabel = TAG_LABELS[message.tag];
  const showCursor = message._streaming === true;
  const bodyText = showCursor ? `${message.message}${STREAMING_CURSOR}` : message.message;

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowBot]}>
      {!isUser && (
        <View style={styles.botAvatar}>
          <Text style={styles.botAvatarText}>B</Text>
        </View>
      )}
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleBot]}>
        <Text
          testID={showCursor ? 'streaming-bubble-text' : undefined}
          style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextBot]}
        >
          {bodyText}
        </Text>
        <BubbleTags message={message} tagLabel={tagLabel} />
        <Text style={[styles.timestamp, isUser ? styles.timestampUser : styles.timestampBot]}>
          {formatTimestamp(message.timestamp)}
        </Text>
        {message._errored === true && <ErrorFooter errorLabel={errorLabel} onRetry={onRetry} />}
      </View>
    </View>
  );
};

export default MessageBubble;
