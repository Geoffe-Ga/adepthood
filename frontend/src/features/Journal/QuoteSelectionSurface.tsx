/**
 * ``QuoteSelectionSurface`` — a controlled, effectively read-only serif field
 * that mirrors a body so the reader can select a passage to promote without
 * editing it (soft keyboard suppressed, caret hidden; ``editable`` stays true so
 * Android text selection still works). Shared by the read-mode promote flow on
 * ``JournalEntryScreen`` and the in-panel re-promotion flow in
 * ``ReflectionSourcesPanel``; ``testID`` prefixes every element so more than one
 * surface can coexist on a page.
 */
import React, { useCallback } from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import { utf16ToCodePoint } from './codePoints';
import styles from './JournalEntry.styles';

type SelectionChangeEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;

/**
 * A selection span in Unicode code-point offsets (the anchor API's unit),
 * end-exclusive. This is the single conversion boundary between the native
 * TextInput's UTF-16 selection and the code-point anchors both send flows post.
 */
export interface CodePointSpan {
  start: number;
  end: number;
}

/** Prefix for the surface's testIDs; the read-mode flow relies on this default. */
const DEFAULT_TEST_ID = 'quote-select';

export interface QuoteSelectionSurfaceProps {
  body: string;
  /** Emits the selection as a code-point span (already converted from UTF-16). */
  onSelectionChange: (_span: CodePointSpan) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID?: string;
}

/**
 * Adapt the native UTF-16 selection event into a code-point span emitter — the
 * single conversion boundary, lifted out of the component so its body stays lean.
 */
function useCodePointSelection(
  body: string,
  onSelectionChange: (_span: CodePointSpan) => void,
): (_event: SelectionChangeEvent) => void {
  return useCallback(
    (event: SelectionChangeEvent) => {
      const { start, end } = event.nativeEvent.selection;
      onSelectionChange({
        start: utf16ToCodePoint(body, start),
        end: utf16ToCodePoint(body, end),
      });
    },
    [body, onSelectionChange],
  );
}

function QuoteSelectionSurface({
  body,
  onSelectionChange,
  onConfirm,
  onCancel,
  testID = DEFAULT_TEST_ID,
}: QuoteSelectionSurfaceProps): React.JSX.Element {
  const handleSelectionChange = useCodePointSelection(body, onSelectionChange);

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
        onSelectionChange={handleSelectionChange}
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
