/**
 * The journal's body field: a plain multiline ``TextInput`` whose value is
 * always the exact stored source, plus the Markdown editing conveniences
 * layered over it.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  TextInput,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import styles from './JournalEntry.styles';
import { continueMarkdownEdit, type MarkdownSelection } from './markdownEditing';
import { useGrowingFieldHeight } from './useGrowingFieldHeight';

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

/** Transform Return at the native caret and briefly control the adjusted selection. */
function useMarkdownBodyBindings(
  body: string,
  onChangeBody: LiveMarkdownBodyProps['onChangeBody'],
  onBodySelectionChange: LiveMarkdownBodyProps['onBodySelectionChange'],
) {
  const [selection, setSelection] = useState<MarkdownSelection>();
  const nativeSelectionRef = useRef<MarkdownSelection>({ start: body.length, end: body.length });
  const changeBody = useCallback(
    (next: string) => {
      const edit = continueMarkdownEdit(body, next, nativeSelectionRef.current);
      if (edit.selection) nativeSelectionRef.current = edit.selection;
      setSelection(edit.selection);
      onChangeBody(edit.text);
    },
    [body, onChangeBody],
  );
  const changeSelection = useCallback(
    (event: SelectionChangeEvent) => {
      nativeSelectionRef.current = event.nativeEvent.selection;
      setSelection(undefined);
      onBodySelectionChange?.(event);
    },
    [onBodySelectionChange],
  );
  return { selection, changeBody, changeSelection };
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
  return (
    <TextInput
      ref={inputRef}
      style={[styles.bodyInput, writingFieldFocus, growth.style]}
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
  );
}
