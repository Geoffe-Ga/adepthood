import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import styles from './Journal.styles';

const DEBOUNCE_DELAY_MS = 300;

interface SearchBarProps {
  onSearch: (_query: string) => void;
  resultCount?: number;
  searchQuery?: string;
}

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
    return (
      <View style={styles.searchBarCollapsed}>
        <TouchableOpacity testID="search-toggle" onPress={handleToggle} style={styles.searchToggle}>
          <Text style={styles.searchIcon}>?</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.searchBarExpanded}>
      <View style={styles.searchInputRow}>
        <TouchableOpacity testID="search-toggle" onPress={handleToggle} style={styles.searchToggle}>
          <Text style={styles.searchIcon}>?</Text>
        </TouchableOpacity>
        <TextInput
          testID="search-input"
          style={styles.searchTextInput}
          value={text}
          onChangeText={handleChangeText}
          placeholder="Search journal..."
          placeholderTextColor="#999"
          autoFocus
        />
        <TouchableOpacity testID="search-clear" onPress={handleClear} style={styles.searchClear}>
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
};

export default SearchBar;
