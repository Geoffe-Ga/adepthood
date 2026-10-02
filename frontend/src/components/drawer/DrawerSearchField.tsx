/**
 * A screen drawer's search field with an optional deep-search confirm row. The
 * confirm row is offered only until body search is active. ``DrawerSearchProps``
 * is an exclusive union (the confirm callback and its label travel together or
 * not at all), so this branches the element instead of widening the props and
 * passing ``undefined`` for half of the pair.
 */
import React from 'react';

import DrawerSearch from './DrawerSearch';

export interface DrawerSearchFieldProps {
  /** Test hook for the search-field wrapper. */
  testID: string;
  /** Placeholder for the input. */
  placeholder: string;
  /** Accessibility label for the input. */
  accessibilityLabel: string;
  /** Confirm-row copy inviting a search inside bodies. */
  deepSearchLabel: string;
  /** Match count for the active query, or undefined to hide the caption. */
  resultCount?: number;
  /** True once the deep body search is confirmed; hides the confirm row. */
  bodySearchActive: boolean;
  /** Receives the debounced query (or '' on clear). */
  onQueryChange: (_query: string) => void;
  /** Confirm widening the search into bodies. */
  onConfirmDeepSearch: () => void;
}

/** The search field, offering the deep-search confirm row while body search is off. */
export default function DrawerSearchField({
  testID,
  placeholder,
  accessibilityLabel,
  deepSearchLabel,
  resultCount,
  bodySearchActive,
  onQueryChange,
  onConfirmDeepSearch,
}: DrawerSearchFieldProps): React.JSX.Element {
  const shared = { testID, placeholder, accessibilityLabel, resultCount, onQueryChange };
  if (bodySearchActive) return <DrawerSearch {...shared} />;
  return (
    <DrawerSearch
      {...shared}
      onConfirmDeepSearch={onConfirmDeepSearch}
      deepSearchLabel={deepSearchLabel}
    />
  );
}
