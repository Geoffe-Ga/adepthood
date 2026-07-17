/**
 * Presentational, uncontrolled search field for a screen drawer: a debounced
 * text input plus an optional result caption and an optional "search all"
 * confirm row. It emits the debounced query and leaves matching to the caller.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import DrawerItem from './DrawerItem';

import {
  INTERACTIVE_TEXT_MIN,
  SPACING,
  accent,
  editorialType,
  ink,
  radius,
  surface,
  touchTarget,
} from '@/design/tokens';

const DEBOUNCE_DELAY_MS = 300;
const DEFAULT_PLACEHOLDER = 'Search...';
const DEFAULT_ACCESSIBILITY_LABEL = 'Search';
const NO_RESULTS_LABEL = 'No results';
const INPUT_BORDER_WIDTH = 1;

interface DrawerSearchBaseProps {
  /** Fired with the debounced query, or '' when the field is cleared. */
  onQueryChange: (_query: string) => void;
  /** Number of matches for the active query; omit to hide the caption. */
  resultCount?: number;
  /** Placeholder text for the input. */
  placeholder?: string;
  /** Accessibility label for the input. */
  accessibilityLabel?: string;
  /** Test hook for the wrapper. */
  testID?: string;
}

type DrawerSearchDeepProps =
  | { onConfirmDeepSearch: () => void; deepSearchLabel: string }
  | { onConfirmDeepSearch?: never; deepSearchLabel?: never };

export type DrawerSearchProps = DrawerSearchBaseProps & DrawerSearchDeepProps;

/** Singular/plural result copy, ASCII-only. */
function resultCaption(resultCount: number): string {
  if (resultCount === 0) return NO_RESULTS_LABEL;
  const noun = resultCount === 1 ? 'result' : 'results';
  return `${resultCount} ${noun}`;
}

/** The warm text field; owns its own accent-on-focus border. */
const DrawerSearchInput = ({
  text,
  placeholder,
  accessibilityLabel,
  onChangeText,
}: {
  text: string;
  placeholder: string;
  accessibilityLabel: string;
  onChangeText: (_value: string) => void;
}): React.JSX.Element => {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      testID="drawer-search-input"
      accessibilityLabel={accessibilityLabel}
      style={[styles.input, focused && styles.inputFocused]}
      value={text}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      placeholderTextColor={ink.muted}
    />
  );
};

/** The count / "no results" caption, shown only for an active query. */
const ResultCaption = ({
  query,
  resultCount,
}: {
  query: string;
  resultCount?: number;
}): React.JSX.Element | null =>
  query && resultCount != null ? (
    <Text style={styles.resultCount} testID="drawer-search-result-count">
      {resultCaption(resultCount)}
    </Text>
  ) : null;

/** The "search all" confirm row, shown only when a deep handler and query exist. */
const DeepSearchRow = ({
  query,
  onConfirmDeepSearch,
  deepSearchLabel,
}: {
  query: string;
  onConfirmDeepSearch?: () => void;
  deepSearchLabel?: string;
}): React.JSX.Element | null => {
  if (!onConfirmDeepSearch || !query || deepSearchLabel == null) return null;
  return (
    <DrawerItem
      label={deepSearchLabel}
      onPress={onConfirmDeepSearch}
      testID="drawer-search-deep-search"
    />
  );
};

/** A debounced drawer search field with optional count and deep-search row. */
export default function DrawerSearch({
  onQueryChange,
  resultCount,
  placeholder = DEFAULT_PLACEHOLDER,
  accessibilityLabel = DEFAULT_ACCESSIBILITY_LABEL,
  testID,
  onConfirmDeepSearch,
  deepSearchLabel,
}: DrawerSearchProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChangeText = useCallback(
    (value: string) => {
      setText(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setDebouncedQuery(value);
        onQueryChange(value);
      }, DEBOUNCE_DELAY_MS);
    },
    [onQueryChange],
  );

  return (
    <View style={styles.container} testID={testID}>
      <DrawerSearchInput
        text={text}
        placeholder={placeholder}
        accessibilityLabel={accessibilityLabel}
        onChangeText={handleChangeText}
      />
      <ResultCaption query={debouncedQuery} resultCount={resultCount} />
      <DeepSearchRow
        query={debouncedQuery}
        onConfirmDeepSearch={onConfirmDeepSearch}
        deepSearchLabel={deepSearchLabel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  input: {
    height: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.lg,
    borderWidth: INPUT_BORDER_WIDTH,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
    fontSize: INTERACTIVE_TEXT_MIN,
    color: ink.primary,
  },
  inputFocused: {
    borderColor: accent.primary,
  },
  resultCount: {
    ...editorialType.caption,
    color: ink.muted,
    marginTop: SPACING.xs,
  },
});
