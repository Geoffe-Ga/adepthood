/**
 * ``PromptHistoryModal`` — every weekly prompt this person has answered, with
 * the question above what they wrote, newest week first.
 *
 * The shelf shows one prompt: the current, unanswered one. Answering it mirrors
 * the response into the journal stream as an ordinary page, which keeps the
 * writing but loses the question that drew it. This surface is where the pair
 * stays together, and it is the only place ``GET /prompts/history`` is reached
 * from.
 */
import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import JournalModalShell from './JournalModalShell';
import { usePromptHistory, type PromptHistoryState } from './usePromptHistory';

import { prompts } from '@/api';
import type { PromptDetail } from '@/api';
import { BORDER_RADIUS, colors, editorialType, spacing, touchTarget } from '@/design/tokens';

/** Tallest the list grows before it scrolls inside the card. */
const LIST_MAX_HEIGHT = 420;

export interface PromptHistoryModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Test injection seam. */
  fetchHistory?: typeof prompts.history;
}

function PromptHistoryModal({
  visible,
  onDismiss,
  fetchHistory,
}: PromptHistoryModalProps): React.JSX.Element {
  const history = usePromptHistory(visible, fetchHistory ?? prompts.history);
  return (
    <JournalModalShell
      visible={visible}
      onDismiss={onDismiss}
      scrimTestID="prompt-history-scrim"
      scrimLabel="Close past prompts"
      modalTestID="prompt-history-modal"
      cardTestID="prompt-history-card"
    >
      <Text accessibilityRole="header" style={styles.title}>
        Past prompts
      </Text>
      <Text style={styles.subtitle}>The questions you have answered, newest week first.</Text>
      <HistoryBody history={history} />
      <TouchableOpacity
        style={styles.close}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close past prompts"
        testID="prompt-history-close"
      >
        <Text style={styles.closeLabel}>Close</Text>
      </TouchableOpacity>
    </JournalModalShell>
  );
}

/** Nothing loaded yet: the failure, the spinner, or the empty line. */
const EmptyBody = ({ history }: { history: PromptHistoryState }): React.JSX.Element => {
  if (history.error !== null) {
    return (
      <Text style={styles.error} testID="prompt-history-error">
        {history.error}
      </Text>
    );
  }
  return history.loading ? (
    <ActivityIndicator accessibilityLabel="Loading past prompts" testID="prompt-history-loading" />
  ) : (
    <Text style={styles.empty} testID="prompt-history-empty">
      You have not answered a weekly prompt yet. The current one waits on the shelf.
    </Text>
  );
};

/**
 * The empty states, or the list.
 *
 * A page that fails after the first one is reported *under* the rows rather
 * than in place of them: the failure belongs to the page that was asked for,
 * not to the ones already read, and "Earlier prompts" is the only control that
 * can ask again — replacing the list with the error would take both the reading
 * and the retry away, leaving dismissing the surface as the only way out.
 */
const HistoryBody = ({ history }: { history: PromptHistoryState }): React.JSX.Element => {
  if (history.items.length === 0) return <EmptyBody history={history} />;
  return (
    <ScrollView style={styles.list} testID="prompt-history-list">
      {history.items.map((item) => (
        <HistoryRow key={item.week_number} item={item} />
      ))}
      {history.error !== null && (
        <Text style={styles.error} testID="prompt-history-error">
          {history.error}
        </Text>
      )}
      {history.hasMore && (
        <TouchableOpacity
          style={styles.more}
          onPress={history.loadMore}
          accessibilityRole="button"
          accessibilityLabel="Load earlier prompts"
          accessibilityState={{ busy: history.loading }}
          testID="prompt-history-more"
        >
          <Text style={styles.moreLabel}>
            {history.error === null ? 'Earlier prompts' : 'Try again'}
          </Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
};

const HistoryRow = ({ item }: { item: PromptDetail }): React.JSX.Element => (
  <View style={styles.row} testID={`prompt-history-row-${item.week_number}`}>
    <Text style={styles.week}>Week {item.week_number}</Text>
    <Text style={styles.question}>{item.question}</Text>
    {item.response !== null && item.response !== '' && (
      <Text style={styles.response} testID={`prompt-history-response-${item.week_number}`}>
        {item.response}
      </Text>
    )}
  </View>
);

const styles = StyleSheet.create({
  title: { ...editorialType.title, color: colors.paper.ink },
  subtitle: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    paddingBottom: spacing(1),
  },
  list: { maxHeight: LIST_MAX_HEIGHT },
  row: { paddingVertical: spacing(1) },
  week: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  question: { ...editorialType.action, color: colors.paper.ink },
  response: { ...editorialType.note, color: colors.paper.inkSoft, paddingTop: spacing(0.5) },
  empty: { ...editorialType.note, color: colors.paper.inkSoft, paddingVertical: spacing(1) },
  error: { ...editorialType.note, color: colors.danger, paddingVertical: spacing(1) },
  more: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.md,
    marginTop: spacing(0.5),
  },
  moreLabel: { ...editorialType.action, color: colors.primary },
  close: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing(0.5),
  },
  closeLabel: { ...editorialType.action, color: colors.paper.inkSoft, fontWeight: '400' },
});

export default PromptHistoryModal;
