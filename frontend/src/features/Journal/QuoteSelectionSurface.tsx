/**
 * ``QuoteSelectionSurface`` — a controlled, effectively read-only serif field
 * that mirrors a body so the reader can select a passage to promote without
 * editing it (soft keyboard suppressed, caret hidden; ``editable`` stays true so
 * Android text selection still works). Shared by the read-mode promote flow on
 * ``JournalEntryScreen`` and the in-panel re-promotion flow in
 * ``ReflectionSourcesPanel``; ``testID`` prefixes every element so more than one
 * surface can coexist on a page.
 */
import React from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import styles from './JournalEntry.styles';

type SelectionChangeEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;

/** Prefix for the surface's testIDs; the read-mode flow relies on this default. */
const DEFAULT_TEST_ID = 'quote-select';

export interface QuoteSelectionSurfaceProps {
  body: string;
  onSelectionChange: (_e: SelectionChangeEvent) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID?: string;
}

function QuoteSelectionSurface({
  body,
  onSelectionChange,
  onConfirm,
  onCancel,
  testID = DEFAULT_TEST_ID,
}: QuoteSelectionSurfaceProps): React.JSX.Element {
  return (
    <View>
      <TextInput
        style={styles.bodyInput}
        value={body}
        multiline
        editable
        showSoftInputOnFocus={false}
        caretHidden
        scrollEnabled={false}
        onSelectionChange={onSelectionChange}
        accessibilityLabel="Select a passage to promote"
        testID={`${testID}-input`}
      />
      <View style={styles.quoteSelectActions}>
        <TouchableOpacity
          onPress={() => void onConfirm()}
          accessibilityRole="button"
          accessibilityLabel="Promote the selected passage"
          style={styles.quoteActionButton}
          testID={`${testID}-confirm`}
        >
          <Text style={styles.controlLink}>Promote selection</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel promoting"
          style={styles.quoteActionButton}
          testID={`${testID}-cancel`}
        >
          <Text style={styles.controlLink}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default QuoteSelectionSurface;
