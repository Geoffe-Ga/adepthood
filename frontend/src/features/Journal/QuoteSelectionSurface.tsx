/**
 * ``QuoteSelectionSurface`` — a controlled, effectively read-only serif field
 * that mirrors a body so the reader can select a passage to promote without
 * editing it (soft keyboard suppressed, caret hidden; ``editable`` stays true so
 * Android text selection still works). It guides the whole gesture in place: a
 * warm instruction line worded for the platform's own gesture (long press on a
 * phone, mouse or keyboard in a browser -- see ``selectionSurfaceCopy.ts``), a
 * live preview that echoes the raw selection back, and
 * an honestly disabled "Promote selection" confirm that only lights up once a
 * non-empty passage is chosen (an empty tap surfaces a gentle hint instead of
 * silently promoting nothing). The field trades the browser focus ring for a
 * terracotta rule lit while it holds focus, grows to its text, and the
 * preview, actions and hint sit together in a footer that web pins to the
 * foot of the viewport while a long body scrolls (#2952).
 * Shared by the read-mode promote flow on
 * ``JournalEntryScreen`` and the in-panel re-promotion flow in
 * ``ReflectionSourcesPanel``; ``testID`` prefixes every element so more than one
 * surface can coexist on a page.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import { selectionToAnchorSpan } from './anchorSpan';
import { codePointToUtf16 } from './codePoints';
import styles from './JournalEntry.styles';
import { pinnedFooterStyle } from './readingSurfaceStyles';
import { buildSelectionSurfaceCopy } from './selectionSurfaceCopy';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';
import { useWebSelectionListener } from './webSelectionListener';

import { Button } from '@/components/Button';
import { editorialType, writingFieldFocus } from '@/design/tokens';

type SelectionChangeEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;
type ContentSizeChangeEvent = NativeSyntheticEvent<TextInputContentSizeChangeEventData>;

/** Body lines the field shows at minimum, so a one-line entry is not boxed in blank page. */
const SELECTION_FIELD_MIN_LINES = 2;

/** The selection field's floor in dp; its text takes over above this. */
export const SELECTION_FIELD_MIN_HEIGHT = SELECTION_FIELD_MIN_LINES * editorialType.body.lineHeight;

/**
 * A selection span in Unicode code-point offsets (the anchor API's unit),
 * end-exclusive, with edge whitespace trimmed. It is produced at the single
 * conversion boundary, ``selectionToAnchorSpan``, between the native TextInput's
 * UTF-16 selection and the code-point anchors both send flows post.
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

const DEFAULT_CONFIRM_LABEL = 'Promote selection';

export interface QuoteSelectionSurfaceProps {
  body: string;
  /** Emits the selection as a code-point span (already converted from UTF-16). */
  onSelectionChange: (_span: CodePointSpan) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testID?: string;
  /** Label on the confirm Button; defaults to the promote-flow wording. */
  confirmLabel?: string;
}

/** The derived view state the surface chrome renders from. */
interface SelectionSurfaceState {
  isEmpty: boolean;
  previewSlice: string;
  hintVisible: boolean;
  emitSpan: (_startUtf16: number, _endUtf16: number) => void;
  handleSelectionChange: (_event: SelectionChangeEvent) => void;
  showHint: () => void;
}

/**
 * Own the surface's selection and hint state in one place: hold the raw UTF-16
 * span, emit the trimmed code-point span at the single conversion boundary, and
 * clear the empty-tap hint the moment a real passage is chosen.
 */
function useSelectionSurfaceState(
  body: string,
  onSelectionChange: (_span: CodePointSpan) => void,
): SelectionSurfaceState {
  const [span, setSpan] = useState<Utf16Span>({ start: 0, end: 0 });
  const [hintVisible, setHintVisible] = useState(false);

  const emitSpan = useCallback(
    (startUtf16: number, endUtf16: number) => {
      setSpan({ start: startUtf16, end: endUtf16 });
      const anchor = selectionToAnchorSpan(body, { start: startUtf16, end: endUtf16 });
      onSelectionChange(anchor);
      if (anchor.end > anchor.start) {
        setHintVisible(false);
      }
    },
    [body, onSelectionChange, setSpan, setHintVisible],
  );

  const handleSelectionChange = useCallback(
    (event: SelectionChangeEvent) => {
      const { start, end } = event.nativeEvent.selection;
      emitSpan(start, end);
    },
    [emitSpan],
  );

  const showHint = useCallback(() => setHintVisible(true), [setHintVisible]);

  // Gate emptiness on the span the API actually receives (trimmed, in code
  // points), so the disabled confirm and the posted anchors agree at the same
  // boundary. The preview echoes that same span: exactly what will be stored.
  const anchor = selectionToAnchorSpan(body, span);
  const isEmpty = anchor.end <= anchor.start;
  return {
    isEmpty,
    previewSlice: isEmpty
      ? ''
      : body.slice(codePointToUtf16(body, anchor.start), codePointToUtf16(body, anchor.end)),
    hintVisible,
    emitSpan,
    handleSelectionChange,
    showHint,
  };
}

/** The measured height the field takes, from ``useGrowingFieldHeight``. */
interface FieldGrowth {
  minHeight?: number;
  height?: number;
}

interface SelectionBodyProps {
  body: string;
  onSelectionChange: (_event: SelectionChangeEvent) => void;
  onContentSizeChange: (_event: ContentSizeChangeEvent) => void;
  growth: FieldGrowth;
  inputRef: React.RefObject<TextInput | null>;
  testID: string;
}

/**
 * The read-only body field, isolated in ``React.memo`` behind stable handlers
 * and a memoised growth object so preview/hint/confirm state changes re-render
 * only the surrounding chrome, never the mirrored text. It owns its own focus
 * flag for the same reason: lighting the focus rule must not re-render the
 * chrome either.
 */
const SelectionBody = React.memo(function SelectionBody({
  body,
  onSelectionChange,
  onContentSizeChange,
  growth,
  inputRef,
  testID,
}: SelectionBodyProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={inputRef}
      style={[
        styles.quoteSelectField,
        writingFieldFocus,
        growth,
        focused && styles.quoteSelectFieldFocused,
      ]}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      value={body}
      multiline
      editable
      showSoftInputOnFocus={false}
      caretHidden
      scrollEnabled={false}
      onSelectionChange={onSelectionChange}
      onContentSizeChange={onContentSizeChange}
      accessibilityLabel="Select a passage to promote"
      testID={`${testID}-input`}
    />
  );
});

/**
 * Size the field to its text (no blank-page floor, no inner scroll pane),
 * handing the body a growth object that changes only when the measured height
 * does, so the memoised body is not re-rendered by the chrome.
 */
function useSelectionFieldGrowth(): {
  growth: FieldGrowth;
  onContentSizeChange: (_event: ContentSizeChangeEvent) => void;
} {
  const measured = useGrowingFieldHeight(SELECTION_FIELD_MIN_HEIGHT);
  const { minHeight, height } = measured.style;
  const growth = useMemo<FieldGrowth>(() => ({ minHeight, height }), [minHeight, height]);
  return { growth, onContentSizeChange: measured.onContentSizeChange };
}

interface SelectionActionsProps {
  isEmpty: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  showHint: () => void;
  testID: string;
  confirmLabel: string;
}

/**
 * The confirm/cancel row. An empty tap lands on the guard (a hint) and
 * ``onConfirm`` never fires on an empty span. The guard loses its handler once
 * the Button enables; it must not become a disabled ancestor, because web
 * accessibility semantics would then disable the enabled descendant too.
 */
function SelectionActions({
  isEmpty,
  onConfirm,
  onCancel,
  showHint,
  testID,
  confirmLabel,
}: SelectionActionsProps): React.JSX.Element {
  return (
    <View style={styles.quoteSelectActions}>
      <Pressable
        accessible={false}
        onPress={isEmpty ? showHint : undefined}
        testID={`${testID}-confirm-guard`}
      >
        <Button
          variant="primary"
          label={confirmLabel}
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

interface SelectionFooterProps {
  /** The echoed passage; empty when nothing is selected, and then no card shows. */
  previewSlice: string;
  /** The empty-tap hint to show, or null while it is hidden. */
  emptyHint: string | null;
  testID: string;
  children: React.ReactNode;
}

/**
 * The preview card, the action row (``children``) and the empty-tap hint on
 * one opaque plate that web pins to the foot of the scroll viewport, so a
 * reader deep in a long body always has the echo and the confirm in view.
 */
function SelectionFooter({
  previewSlice,
  emptyHint,
  testID,
  children,
}: SelectionFooterProps): React.JSX.Element {
  return (
    <View style={[styles.quoteSelectFooter, pinnedFooterStyle]} testID={`${testID}-footer`}>
      {previewSlice !== '' && (
        <View style={styles.quoteSelectPreview}>
          <Text style={styles.quoteSelectPreviewText} testID={`${testID}-preview`}>
            {previewSlice}
          </Text>
        </View>
      )}
      {children}
      {emptyHint != null && (
        <Text style={styles.quoteSelectHint} testID={`${testID}-hint`}>
          {emptyHint}
        </Text>
      )}
    </View>
  );
}

function QuoteSelectionSurface({
  body,
  onSelectionChange,
  onConfirm,
  onCancel,
  testID = DEFAULT_TEST_ID,
  confirmLabel = DEFAULT_CONFIRM_LABEL,
}: QuoteSelectionSurfaceProps): React.JSX.Element {
  const { isEmpty, previewSlice, hintVisible, emitSpan, handleSelectionChange, showHint } =
    useSelectionSurfaceState(body, onSelectionChange);
  const inputRef = useRef<TextInput>(null);
  useWebSelectionListener(inputRef, emitSpan);
  const { growth, onContentSizeChange } = useSelectionFieldGrowth();
  // Resolved per render rather than at module load so the wording follows the
  // platform the surface is actually mounted on (and so a test that sets
  // Platform.OS after import sees the copy change).
  const copy = buildSelectionSurfaceCopy(Platform.OS);

  return (
    <View>
      <Text style={styles.quoteSelectInstruction} testID={`${testID}-instruction`}>
        {copy.instruction}
      </Text>
      <SelectionBody
        body={body}
        onSelectionChange={handleSelectionChange}
        onContentSizeChange={onContentSizeChange}
        growth={growth}
        inputRef={inputRef}
        testID={testID}
      />
      <SelectionFooter
        previewSlice={previewSlice}
        emptyHint={hintVisible ? copy.emptyHint : null}
        testID={testID}
      >
        <SelectionActions
          isEmpty={isEmpty}
          onConfirm={onConfirm}
          onCancel={onCancel}
          showHint={showHint}
          testID={testID}
          confirmLabel={confirmLabel}
        />
      </SelectionFooter>
    </View>
  );
}

export default QuoteSelectionSurface;
