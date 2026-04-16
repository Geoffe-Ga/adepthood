import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { colors } from '../../design/tokens';

import styles from './Journal.styles';

const DEBOUNCE_DELAY_MS = 300;

interface SearchBarProps {
  onSearch: (_query: string) => void;
  resultCount?: number;
  searchQuery?: string;
}

const CollapsedSearchBar = ({ onToggle }: { onToggle: () => void }): React.JSX.Element => (
  <View style={styles.searchBarCollapsed}>
    <TouchableOpacity
      testID="search-toggle"
      onPress={onToggle}
      style={styles.searchToggle}
      accessibilityLabel="Open journal search"
      accessibilityRole="button"
    >
      <Text style={styles.searchIcon}>?</Text>
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

const ExpandedSearchBarContent = ({
  text,
  onChangeText,
  onToggle,
  onClear,
  searchQuery,
  resultCount,
}: ExpandedSearchBarProps): React.JSX.Element => (
  <View style={styles.searchBarExpanded}>
    <View style={styles.searchInputRow}>
      <TouchableOpacity
        testID="search-toggle"
        onPress={onToggle}
        style={styles.searchToggle}
        accessibilityLabel="Focus journal search"
        accessibilityRole="button"
      >
        <Text style={styles.searchIcon}>?</Text>
      </TouchableOpacity>
      <TextInput
        testID="search-input"
        accessibilityLabel="Search journal"
        style={styles.searchTextInput}
        value={text}
        onChangeText={onChangeText}
        placeholder="Search journal..."
        placeholderTextColor={colors.text.tertiary}
        autoFocus
      />
      <TouchableOpacity
        testID="search-clear"
        onPress={onClear}
        style={styles.searchClear}
        accessibilityLabel="Clear search"
        accessibilityRole="button"
      >
        <Text style={styles.searchClearText}>X</Text>
      </TouchableOpacity>
    </View>
    {searchQuery && resultCount != null && (
      <Text style={styles.searchResultCount}>
        {resultCount} results for &apos;{searchQuery}&apos;
      </Text>
    )}
  </View>
);

const SearchBar = ({ onSearch, resultCount, searchQuery }: SearchBarProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState(!!searchQuery);
  const [text, setText] = useState(searchQuery ?? '');
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

export default SearchBar;
