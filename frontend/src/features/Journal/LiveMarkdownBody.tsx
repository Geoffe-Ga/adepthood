/**
 * The journal's body field: a plain multiline ``TextInput`` whose value is
 * always the exact stored source, plus the Markdown editing conveniences
 * layered over it.
 *
 * On web a styled mirror (``LiveMarkdownMirror``) is drawn behind the field
 * and the field's own glyphs go transparent, so the writer sees their Markdown
 * rendered while the textarea keeps the caret, selection, undo, paste and the
 * screen reader. The value is never a display copy: #2891's quote anchors read
 * the textarea selection straight through ``utf16ToSource``.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  TextInput,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import styles from './JournalEntry.styles';
import { utf16ToSource, type SourceSelection } from './journalMarkdown';
import LiveMarkdownMirror from './LiveMarkdownMirror';
import liveStyles, { LIVE_TAB_STYLE } from './LiveMarkdownStyles';
import { continueMarkdownEdit, type MarkdownSelection } from './markdownEditing';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';
import { useLiveMirrorEnabled } from './useLiveMirrorEnabled';
import { useWebSelectionListener } from './webSelectionListener';

import { colors, writingField, writingFieldFocus } from '@/design/tokens';

type SelectionChangeEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;

/** Give the blank writing page most of the viewport before prose begins to grow it. */
const BODY_VIEWPORT_FRACTION = 0.6;
const BODY_MIN_HEIGHT = 320;

export interface LiveMarkdownBodyProps {
  body: string;
  onChangeBody: (_next: string) => void;
  /** Reflection mode: track the body caret so a folded quote lands at the cursor. */
  onBodySelectionChange?: (_e: SelectionChangeEvent) => void;
  bodyPlaceholder: string;
  inputRef: React.RefObject<TextInput | null>;
}

/**
 * Transform Return at the native caret and briefly control the adjusted
 * selection. The caret is also kept as state, in UTF-16 as the field reports
 * it, for what is drawn around it.
 */
function useMarkdownBodyBindings(
  body: string,
  onChangeBody: LiveMarkdownBodyProps['onChangeBody'],
  onBodySelectionChange: LiveMarkdownBodyProps['onBodySelectionChange'],
) {
  const [selection, setSelection] = useState<MarkdownSelection>();
  const [caret, setCaret] = useState<MarkdownSelection>({ start: body.length, end: body.length });
  const nativeSelectionRef = useRef<MarkdownSelection>({ start: body.length, end: body.length });
  const trackCaret = useCallback((next: MarkdownSelection) => {
    nativeSelectionRef.current = next;
    setCaret((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  }, []);
  const changeBody = useCallback(
    (next: string) => {
      const edit = continueMarkdownEdit(body, next, nativeSelectionRef.current);
      if (edit.selection) trackCaret(edit.selection);
      setSelection(edit.selection);
      onChangeBody(edit.text);
    },
    [body, onChangeBody, trackCaret],
  );
  const changeSelection = useCallback(
    (event: SelectionChangeEvent) => {
      trackCaret(event.nativeEvent.selection);
      setSelection(undefined);
      onBodySelectionChange?.(event);
    },
    [onBodySelectionChange, trackCaret],
  );
  return { selection, caret, trackCaret, changeBody, changeSelection };
}

/**
 * The field's caret in SOURCE positions, for what is drawn around it.
 *
 * iOS Safari fires no ``select`` event for selection-handle drags, so on web
 * the textarea's own selection is also read on the document's
 * ``selectionchange``.
 */
function useSourceCaret(
  body: string,
  markdown: ReturnType<typeof useMarkdownBodyBindings>,
  inputRef: React.RefObject<TextInput | null>,
): SourceSelection {
  const { trackCaret } = markdown;
  const emitWebSelection = useCallback(
    (start: number, end: number) => trackCaret({ start, end }),
    [trackCaret],
  );
  useWebSelectionListener(inputRef, emitWebSelection);
  return {
    start: utf16ToSource(body, markdown.caret.start),
    end: utf16ToSource(body, markdown.caret.end),
  };
}

/** The prose field starts generous and grows into the page-level scroll surface. */
export default function LiveMarkdownBody({
  body,
  onChangeBody,
  onBodySelectionChange,
  bodyPlaceholder,
  inputRef,
}: LiveMarkdownBodyProps) {
  const viewportHeight = useWindowDimensions().height;
  const minimumBodyHeight = Math.max(BODY_MIN_HEIGHT, viewportHeight * BODY_VIEWPORT_FRACTION);
  const growth = useGrowingFieldHeight(minimumBodyHeight);
  const markdown = useMarkdownBodyBindings(body, onChangeBody, onBodySelectionChange);
  const mirrored = useLiveMirrorEnabled();
  const sourceSelection = useSourceCaret(body, markdown, inputRef);
  return (
    <View style={liveStyles.frame}>
      {mirrored ? (
        <LiveMarkdownMirror body={body} selection={sourceSelection} textStyle={LIVE_TAB_STYLE} />
      ) : null}
      <TextInput
        ref={inputRef}
        style={[
          styles.bodyInput,
          writingFieldFocus,
          growth.style,
          mirrored ? [liveStyles.inputMirrored, LIVE_TAB_STYLE] : null,
        ]}
        value={body}
        onChangeText={markdown.changeBody}
        onContentSizeChange={growth.onContentSizeChange}
        selection={markdown.selection}
        onSelectionChange={markdown.changeSelection}
        placeholder={bodyPlaceholder}
        placeholderTextColor={colors.paper.inkSoft}
        selectionColor={writingField.caret}
        cursorColor={writingField.caret}
        multiline
        scrollEnabled={false}
        accessibilityLabel="Entry body"
        testID="journal-body-input"
      />
    </View>
  );
}
