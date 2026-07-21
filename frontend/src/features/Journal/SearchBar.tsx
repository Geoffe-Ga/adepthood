import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  radius,
  surface,
  touchTarget,
  uiType,
} from '@/design/tokens';

const DEBOUNCE_DELAY_MS = 300;

interface SearchBarProps {
  onSearch: (_query: string) => void;
  resultCount?: number;
  searchQuery?: string;
}

const CollapsedSearchBar = ({ onToggle }: { onToggle: () => void }): React.JSX.Element => (
  <View testID="search-bar-collapsed" style={styles.searchBarCollapsed}>
    <TouchableOpacity
      testID="search-toggle"
      onPress={onToggle}
      style={styles.searchToggle}
      accessibilityLabel="Open journal search"
      accessibilityRole="button"
    >
      <Text style={styles.searchIcon}>🔍</Text>
    </TouchableOpacity>
  </View>
);

interface ExpandedSearchBarProps {
  text: string;
  onChangeText: (_value: string) => void;
  onToggle: () => void;
  onClear: () => void;
  searchQuery?: string;
  resultCount?: number;
}

/** The result line: "No results …" when a query came back empty, else the count. */
function resultLine(searchQuery: string, resultCount: number): string {
  if (resultCount === 0) return `No results for '${searchQuery}'`;
  const noun = resultCount === 1 ? 'result' : 'results';
  return `${resultCount} ${noun} for '${searchQuery}'`;
}

/** The warm-palette text field; owns its own accent-on-focus border. */
const SearchTextInput = ({
  text,
  onChangeText,
}: {
  text: string;
  onChangeText: (_value: string) => void;
}): React.JSX.Element => {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      testID="search-input"
      accessibilityLabel="Search journal"
      style={[styles.searchTextInput, focused && styles.searchTextInputFocused]}
      value={text}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder="Search journal..."
      placeholderTextColor={ink.muted}
      autoFocus
    />
  );
};

/** The count / "no results" caption, shown only for an active query. */
const SearchResultLine = ({
  searchQuery,
  resultCount,
}: {
  searchQuery?: string;
  resultCount?: number;
}): React.JSX.Element | null =>
  searchQuery && resultCount != null ? (
    <Text style={styles.searchResultCount} testID="search-result-count">
      {resultLine(searchQuery, resultCount)}
    </Text>
  ) : null;

const ExpandedSearchBarContent = ({
  text,
  onChangeText,
  onToggle,
  onClear,
  searchQuery,
  resultCount,
}: ExpandedSearchBarProps): React.JSX.Element => (
  <View testID="search-bar-expanded" style={styles.searchBarExpanded}>
    <View style={styles.searchInputRow}>
      <TouchableOpacity
        testID="search-toggle"
        onPress={onToggle}
        style={styles.searchToggle}
        accessibilityLabel="Focus journal search"
        accessibilityRole="button"
      >
        <Text style={styles.searchIcon}>🔍</Text>
      </TouchableOpacity>
      <SearchTextInput text={text} onChangeText={onChangeText} />
      <TouchableOpacity
        testID="search-clear"
        onPress={onClear}
        style={styles.searchClear}
        accessibilityLabel="Clear search"
        accessibilityRole="button"
      >
        <Text style={styles.searchClearText}>×</Text>
      </TouchableOpacity>
    </View>
    <SearchResultLine searchQuery={searchQuery} resultCount={resultCount} />
  </View>
);

const SearchBar = ({ onSearch, resultCount, searchQuery }: SearchBarProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(!!searchQuery);
  const [text, setText] = useState(searchQuery ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the local text in sync when the parent resets the searchQuery prop
  // (e.g. clearing on tab change), so the field mirrors the controlled value.
  useEffect(() => {
    setText((current) => (current === (searchQuery ?? '') ? current : (searchQuery ?? '')));
  }, [searchQuery]);

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
        onSearch(value);
      }, DEBOUNCE_DELAY_MS);
    },
    [onSearch],
  );

  const handleToggle = useCallback(() => {
    setExpanded(true);
  }, []);

  const handleClear = useCallback(() => {
    setText('');
    setExpanded(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    onSearch('');
  }, [onSearch]);

  if (!expanded) {
    return <CollapsedSearchBar onToggle={handleToggle} />;
  }

  return (
    <ExpandedSearchBarContent
      text={text}
      onChangeText={handleChangeText}
      onToggle={handleToggle}
      onClear={handleClear}
      searchQuery={searchQuery}
      resultCount={resultCount}
    />
  );
};

const styles = StyleSheet.create({
  searchBarCollapsed: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xs,
  },
  searchBarExpanded: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xs,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchToggle: {
    width: touchTarget.minimum,
    height: touchTarget.minimum,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchIcon: {
    ...uiType.button,
    color: ink.soft,
  },
  searchTextInput: {
    flex: 1,
    marginHorizontal: SPACING.sm,
    height: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
    fontSize: editorialType.note.fontSize,
    color: ink.primary,
  },
  searchTextInputFocused: {
    borderColor: accent.primary,
  },
  searchClear: {
    width: touchTarget.minimum,
    height: touchTarget.minimum,
    borderRadius: BORDER_RADIUS.circle,
    backgroundColor: surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearText: {
    ...uiType.button,
    color: ink.soft,
  },
  searchResultCount: {
    ...editorialType.caption,
    color: ink.muted,
    marginTop: SPACING.xs,
    marginLeft: touchTarget.minimum + SPACING.sm,
  },
});

export default SearchBar;
