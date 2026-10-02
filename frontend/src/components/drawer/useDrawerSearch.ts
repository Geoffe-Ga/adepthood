/**
 * Own a screen drawer's search query and its body-search gate. Clearing the
 * query drops back to title-only matching until body search is re-confirmed;
 * confirming flips the gate and asks the host to sweep the bodies in. Matching
 * itself stays with the caller.
 */
import { useCallback, useState } from 'react';

export interface DrawerSearchState {
  /** The debounced query ('' when cleared). */
  query: string;
  /** True once a deep body search is confirmed for the current query. */
  bodySearchActive: boolean;
  /** True while a non-empty query is active. */
  isSearching: boolean;
  /** Feed the field's debounced query here. */
  handleQueryChange: (_next: string) => void;
  /** Feed the field's deep-search confirm here. */
  handleConfirmDeepSearch: () => void;
}

/** The query and body-search gate behind a drawer's ``DrawerSearchField``. */
export function useDrawerSearch(onConfirmBodySearch: () => void): DrawerSearchState {
  const [query, setQuery] = useState('');
  const [bodySearchActive, setBodySearchActive] = useState(false);

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next);
    if (next.length === 0) setBodySearchActive(false);
  }, []);

  const handleConfirmDeepSearch = useCallback(() => {
    setBodySearchActive(true);
    onConfirmBodySearch();
  }, [onConfirmBodySearch]);

  const isSearching = query.length > 0;
  return { query, bodySearchActive, isSearching, handleQueryChange, handleConfirmDeepSearch };
}
