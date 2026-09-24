/**
 * The journal's body field: a plain multiline ``TextInput`` whose value is
 * always the exact stored source, plus the Markdown editing conveniences
 * layered over it.
 *
 * On web a styled mirror (``LiveMarkdownMirror``) is drawn in register over the field
 * and the field's own glyphs go transparent, so the writer sees their Markdown
 * rendered while the textarea keeps the caret, selection, undo, paste and the
 * screen reader. The value is never a display copy: #2891's quote anchors read
 * the textarea selection straight through ``utf16ToSource``.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  TextInput,
  View,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import { editorPrimaryModifier } from './editorPrimaryModifier';
import styles from './JournalEntry.styles';
import { utf16ToSource, type SourceSelection } from './journalMarkdown';
import LiveMarkdownMirror from './LiveMarkdownMirror';
import liveStyles, { LIVE_TAB_STYLE } from './LiveMarkdownStyles';
import {
  applyMarkdownCommand,
  keyCommand,
  markdownCommandState,
  type MarkdownCommand,
  type MarkdownKeyEvent,
} from './markdownCommands';
import { continueMarkdownEdit, type MarkdownEdit, type MarkdownSelection } from './markdownEditing';
import MarkdownFormatToolbar from './MarkdownFormatToolbar';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';
import { useLiveMirrorEnabled } from './useLiveMirrorEnabled';
import { useWebSelectionListener } from './webSelectionListener';
import { applyEditToTextarea } from './webTextareaEdit';

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
 * The field's last reported selection (UTF-16), as a ref for handlers that
 * must read it synchronously and as state for what is drawn around it.
 */
function useTrackedCaret(body: string) {
  const [caret, setCaret] = useState<MarkdownSelection>({ start: body.length, end: body.length });
  const nativeSelectionRef = useRef<MarkdownSelection>({ start: body.length, end: body.length });
  const trackCaret = useCallback((next: MarkdownSelection) => {
    nativeSelectionRef.current = next;
    setCaret((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  }, []);
  return { caret, nativeSelectionRef, trackCaret };
}

/**
 * Apply a command's edit through the browser, so native undo records it, and
 * fall back to ``commit`` (a controlled value) where that is unavailable.
 */
function useApplyEdit(
  inputRef: LiveMarkdownBodyProps['inputRef'],
  applyingCommandRef: React.MutableRefObject<boolean>,
  commit: (edit: MarkdownEdit) => void,
  trackCaret: (next: MarkdownSelection) => void,
) {
  return useCallback(
    (edit: MarkdownEdit) => {
      applyingCommandRef.current = true;
      let applied = false;
      try {
        applied = applyEditToTextarea(inputRef.current, edit);
      } finally {
        applyingCommandRef.current = false;
      }
      if (!applied) commit(edit);
      else if (edit.selection) trackCaret(edit.selection);
    },
    [applyingCommandRef, commit, inputRef, trackCaret],
  );
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
  inputRef: LiveMarkdownBodyProps['inputRef'],
) {
  const [selection, setSelection] = useState<MarkdownSelection>();
  const { caret, nativeSelectionRef, trackCaret } = useTrackedCaret(body);
  // True while a command is being applied through the browser: the input
  // event it fires is the command's own text and must pass through verbatim.
  const applyingCommandRef = useRef(false);
  /** Hand the body a new value, briefly controlling the caret when the edit moves it. */
  const commit = useCallback(
    (edit: MarkdownEdit) => {
      if (edit.selection) trackCaret(edit.selection);
      setSelection(edit.selection);
      onChangeBody(edit.text);
    },
    [onChangeBody, trackCaret],
  );
  const changeBody = useCallback(
    (next: string) =>
      commit(
        applyingCommandRef.current
          ? { text: next }
          : continueMarkdownEdit(body, next, nativeSelectionRef.current),
      ),
    [body, commit, nativeSelectionRef],
  );
  const changeSelection = useCallback(
    (event: SelectionChangeEvent) => {
      trackCaret(event.nativeEvent.selection);
      setSelection(undefined);
      onBodySelectionChange?.(event);
    },
    [onBodySelectionChange, trackCaret],
  );
  const applyEdit = useApplyEdit(inputRef, applyingCommandRef, commit, trackCaret);
  return {
    selection,
    caret,
    nativeSelectionRef,
    trackCaret,
    changeBody,
    changeSelection,
    applyEdit,
  };
}

type BodyBindings = ReturnType<typeof useMarkdownBodyBindings>;

/** The key a TextInput reports, with the modifiers react-native-web passes through on web. */
type BodyKeyPressEvent = NativeSyntheticEvent<TextInputKeyPressEventData & MarkdownKeyEvent>;

/**
 * Keyboard commands on the body field. Being the field's own handler, it only
 * ever sees keys pressed while the body is focused; a key that is not an
 * editor command, or a command that does not apply here (``pass``), is left to
 * the browser untouched.
 */
function useMarkdownKeyCommands(body: string, bindings: BodyBindings) {
  const { applyEdit, nativeSelectionRef } = bindings;
  const primary = useMemo(editorPrimaryModifier, []);
  return useCallback(
    (event: BodyKeyPressEvent) => {
      const command = keyCommand(event.nativeEvent, primary);
      if (command == null) return;
      const result = applyMarkdownCommand(body, nativeSelectionRef.current, command);
      if (result.kind === 'pass') return;
      event.preventDefault();
      if (result.kind === 'edit') applyEdit(result.edit);
    },
    [applyEdit, body, nativeSelectionRef, primary],
  );
}

/**
 * The toolbar's view of the field: what is in force at the selection, and a
 * press handler that runs the same command the keyboard would. The field is
 * focused first, because the browser applies an edit only to the focused
 * element and a press has just moved focus to the button.
 */
function useToolbarCommands(
  body: string,
  bindings: BodyBindings,
  inputRef: LiveMarkdownBodyProps['inputRef'],
) {
  const { applyEdit, nativeSelectionRef, caret } = bindings;
  const toolbarState = useMemo(() => markdownCommandState(body, caret), [body, caret]);
  const runCommand = useCallback(
    (command: MarkdownCommand) => {
      inputRef.current?.focus();
      const result = applyMarkdownCommand(body, nativeSelectionRef.current, command);
      if (result.kind === 'edit') applyEdit(result.edit);
    },
    [applyEdit, body, inputRef, nativeSelectionRef],
  );
  return { toolbarState, runCommand };
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
  markdown: BodyBindings,
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
  const markdown = useMarkdownBodyBindings(body, onChangeBody, onBodySelectionChange, inputRef);
  const onKeyPress = useMarkdownKeyCommands(body, markdown);
  const { toolbarState, runCommand } = useToolbarCommands(body, markdown, inputRef);
  const mirrored = useLiveMirrorEnabled();
  const sourceSelection = useSourceCaret(body, markdown, inputRef);
  return (
    <>
      <MarkdownFormatToolbar state={toolbarState} onCommand={runCommand} />
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
          onKeyPress={onKeyPress}
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
    </>
  );
}
