/**
 * ``QuoteSelectionSurface`` — a controlled, effectively read-only serif field
 * that mirrors a body so the reader can select a passage to promote without
 * editing it (soft keyboard suppressed, caret hidden; ``editable`` stays true so
 * Android text selection still works). It guides the whole gesture in place: a
 * warm instruction line, a live preview that echoes the raw selection back, and
 * an honestly disabled "Promote selection" confirm that only lights up once a
 * non-empty passage is chosen (an empty tap surfaces a gentle hint instead of
 * silently promoting nothing). Shared by the read-mode promote flow on
 * ``JournalEntryScreen`` and the in-panel re-promotion flow in
 * ``ReflectionSourcesPanel``; ``testID`` prefixes every element so more than one
 * surface can coexist on a page.
 */
import React, { useCallback, useState } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import { utf16ToCodePoint } from './codePoints';
import styles from './JournalEntry.styles';

import { Button } from '@/components/Button';

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

/** The raw UTF-16 selection kept locally so the preview can slice ``body``. */
interface Utf16Span {
  start: number;
  end: number;
}

/** Prefix for the surface's testIDs; the read-mode flow relies on this default. */
const DEFAULT_TEST_ID = 'quote-select';

const INSTRUCTION_COPY = 'Touch and hold a passage, then drag to choose it.';
const EMPTY_HINT_COPY = 'Choose a passage first — touch and hold the text.';

export interface QuoteSelectionSurfaceProps {
  body: string;
  /** Emits the selection as a code-point span (already converted from UTF-16). */
  onSelectionChange: (_span: CodePointSpan) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID?: string;
}

/** The derived view state the surface chrome renders from. */
interface SelectionSurfaceState {
  isEmpty: boolean;
  previewSlice: string;
  hintVisible: boolean;
  handleSelectionChange: (_event: SelectionChangeEvent) => void;
  showHint: () => void;
}

/**
 * Own the surface's selection and hint state in one place: hold the raw UTF-16
 * span (so the preview can slice ``body`` verbatim), emit the code-point span at
 * the single conversion boundary, and clear the empty-tap hint the moment a real
 * passage is chosen.
 */
function useSelectionSurfaceState(
  body: string,
  onSelectionChange: (_span: CodePointSpan) => void,
): SelectionSurfaceState {
  const [span, setSpan] = useState<Utf16Span>({ start: 0, end: 0 });
  const [hintVisible, setHintVisible] = useState(false);

  const handleSelectionChange = useCallback(
    (event: SelectionChangeEvent) => {
      const { start, end } = event.nativeEvent.selection;
      setSpan({ start, end });
      onSelectionChange({
        start: utf16ToCodePoint(body, start),
        end: utf16ToCodePoint(body, end),
      });
      if (end > start) {
        setHintVisible(false);
      }
    },
    [body, onSelectionChange, setSpan, setHintVisible],
  );

  const showHint = useCallback(() => setHintVisible(true), [setHintVisible]);

  // Gate emptiness on the code-point span the API actually receives (not the raw
  // UTF-16 span), so the disabled confirm and the posted anchors agree at the
  // same boundary the rest of this module is careful about. The preview still
  // slices the raw UTF-16 span to echo exactly what the reader highlighted.
  const codePointStart = utf16ToCodePoint(body, span.start);
  const codePointEnd = utf16ToCodePoint(body, span.end);
  const isEmpty = codePointEnd <= codePointStart;
  return {
    isEmpty,
    previewSlice: isEmpty ? '' : body.slice(span.start, span.end),
    hintVisible,
    handleSelectionChange,
    showHint,
  };
}

interface SelectionBodyProps {
  body: string;
  onSelectionChange: (_event: SelectionChangeEvent) => void;
  testID: string;
}

/**
 * The read-only body field, isolated in ``React.memo`` behind a stable handler so
 * preview/hint/confirm state changes re-render only the surrounding chrome, never
 * the mirrored text.
 */
const SelectionBody = React.memo(function SelectionBody({
  body,
  onSelectionChange,
  testID,
}: SelectionBodyProps): React.JSX.Element {
  return (
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
  );
});

interface SelectionActionsProps {
  isEmpty: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  showHint: () => void;
  testID: string;
}

/**
 * The confirm/cancel row. Exactly one of {guard, Button} is enabled, so an empty
 * tap lands on the guard (a hint) and ``onConfirm`` never fires on an empty span.
 */
function SelectionActions({
  isEmpty,
  onConfirm,
  onCancel,
  showHint,
  testID,
}: SelectionActionsProps): React.JSX.Element {
  return (
    <View style={styles.quoteSelectActions}>
      <Pressable
        accessible={false}
        disabled={!isEmpty}
        onPress={showHint}
        testID={`${testID}-confirm-guard`}
      >
        <Button
          variant="primary"
          label="Promote selection"
          disabled={isEmpty}
          onPress={() => void onConfirm()}
          testID={`${testID}-confirm`}
        />
      </Pressable>
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
  );
}

function QuoteSelectionSurface({
  body,
  onSelectionChange,
  onConfirm,
  onCancel,
  testID = DEFAULT_TEST_ID,
}: QuoteSelectionSurfaceProps): React.JSX.Element {
  const { isEmpty, previewSlice, hintVisible, handleSelectionChange, showHint } =
    useSelectionSurfaceState(body, onSelectionChange);

  return (
    <View>
      <Text style={styles.quoteSelectInstruction} testID={`${testID}-instruction`}>
        {INSTRUCTION_COPY}
      </Text>
      <SelectionBody body={body} onSelectionChange={handleSelectionChange} testID={testID} />
      {!isEmpty && (
        <View style={styles.quoteSelectPreview}>
          <Text style={styles.quoteSelectPreviewText} testID={`${testID}-preview`}>
            {previewSlice}
          </Text>
        </View>
      )}
      <SelectionActions
        isEmpty={isEmpty}
        onConfirm={onConfirm}
        onCancel={onCancel}
        showHint={showHint}
        testID={testID}
      />
      {hintVisible && (
        <Text style={styles.quoteSelectHint} testID={`${testID}-hint`}>
          {EMPTY_HINT_COPY}
        </Text>
      )}
    </View>
  );
}

export default QuoteSelectionSurface;
