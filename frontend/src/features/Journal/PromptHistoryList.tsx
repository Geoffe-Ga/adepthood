/** Answered questions and their responses, paged beneath the current Prompts inbox. */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { plainText } from './excerpt';
import { usePromptHistory, type PromptHistoryState } from './usePromptHistory';

import { prompts } from '@/api';
import type { PromptDetail } from '@/api';
import {
  BORDER_RADIUS,
  colors,
  editorialType,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

export interface PromptHistoryListProps {
  visible?: boolean;
  onWrite: (_item: PromptDetail) => void;
  fetchHistory?: typeof prompts.history;
}

/** Inline history: the screen owns scrolling so older cards remain in the same feed. */
function PromptHistoryList({
  visible = true,
  onWrite,
  fetchHistory,
}: PromptHistoryListProps): React.JSX.Element {
  const history = usePromptHistory(visible, fetchHistory ?? prompts.history);
  return <HistoryBody history={history} onWrite={onWrite} />;
}

/** Nothing loaded yet: the failure, the spinner, or the empty line. */
const EmptyBody = ({ history }: { history: PromptHistoryState }): React.JSX.Element => {
  if (history.error !== null) {
    return (
      <View>
        <Text style={styles.error} testID="prompt-history-error">
          {history.error}
        </Text>
        <TouchableOpacity
          style={styles.more}
          accessibilityRole="button"
          accessibilityLabel="Try again to load past prompts"
          onPress={history.loadMore}
          testID="prompt-history-retry"
        >
          <Text style={styles.moreLabel}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return history.loading ? (
    <ActivityIndicator accessibilityLabel="Loading past prompts" testID="prompt-history-loading" />
  ) : (
    <Text style={styles.empty} testID="prompt-history-empty">
      You have not answered a weekly prompt yet. Current prompts appear above.
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
const HistoryBody = ({
  history,
  onWrite,
}: {
  history: PromptHistoryState;
  onWrite: (_item: PromptDetail) => void;
}): React.JSX.Element => {
  if (history.items.length === 0) return <EmptyBody history={history} />;
  return (
    <View testID="prompt-history-list">
      {history.items.map((item) => (
        <HistoryRow key={item.week_number} item={item} onWrite={onWrite} />
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
          accessibilityLabel={
            history.error === null
              ? 'Earlier prompts: load earlier questions'
              : 'Try again to load earlier prompts'
          }
          accessibilityState={{ busy: history.loading }}
          disabled={history.loading}
          testID="prompt-history-more"
        >
          <Text style={styles.moreLabel}>
            {history.error === null ? 'Earlier prompts' : 'Try again'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

const HistoryRow = ({
  item,
  onWrite,
}: {
  item: PromptDetail;
  onWrite: (_item: PromptDetail) => void;
}): React.JSX.Element => (
  <View style={styles.row} testID={`prompt-history-row-${item.week_number}`}>
    <Text style={styles.week}>Week {item.week_number}</Text>
    <Text style={styles.question}>{plainText(item.question)}</Text>
    {item.response !== null && item.response !== '' && (
      <Text style={styles.response} testID={`prompt-history-response-${item.week_number}`}>
        {plainText(item.response)}
      </Text>
    )}
    <TouchableOpacity
      style={styles.more}
      onPress={() => onWrite(item)}
      accessibilityRole="button"
      accessibilityLabel={`Write about this: start a new entry from the week ${item.week_number} prompt`}
      testID={`prompt-history-write-${item.week_number}`}
    >
      <Text style={styles.moreLabel}>Write about this</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  row: {
    padding: spacing(2),
    marginBottom: spacing(1),
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.raised,
    ...surfaceShadow.card,
  },
  week: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
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
});

export default PromptHistoryList;
