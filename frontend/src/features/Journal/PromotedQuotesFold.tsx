/**
 * The Promoted quotes screen's multi-select fold-in (#2885), kept beside the
 * screen rather than inside it.
 *
 * Quotes only ever fold into a REVIEW -- the server marks a quote included
 * only in a hierarchical reflection (#1458) -- so the screen has two arms:
 *
 * - Opened from a review being written, the route carries that review's
 *   hand-off token (``injectInto``). "Fold N quotes into this review" delivers
 *   the checked quotes under it and goes back; the review, still mounted
 *   beneath, collects them.
 * - Opened from anywhere else there is nothing to fold into, so the action is
 *   "Write a review with N quotes": it opens the review picker, and the chosen
 *   review opens with a fresh token under which the quotes wait.
 *
 * Either way the quotes go in the order the passages sit (``byPassageOrder``),
 * the sources panel's own order, attributed exactly as the panel would.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { byPassageOrder, candidateFromListItem, type FoldCandidate } from './quoteBatch';
import { foldSelectedLabel, writeReviewWithLabel } from './quoteFoldCopy';
import { QuoteFoldBar } from './QuoteSelectionControls';
import ReviewScopePicker from './ReviewScopePicker';
import type { ReviewEntryParams } from './reviewScopes';
import type { QuoteSection } from './usePromotedQuoteSection';
import type { QuoteSelection } from './useQuoteSelection';

import type { RootStackParamList } from '@/navigation/RootStack';
import { usePromotedQuoteHandoffStore } from '@/store/usePromotedQuoteHandoffStore';

type ScreenNavigation = NativeStackNavigationProp<RootStackParamList>;

/** The checked pending quotes, as fold candidates, in the order they will go in. */
export function orderedCandidates(
  section: QuoteSection,
  selected: ReadonlySet<number>,
): FoldCandidate[] {
  return section.items
    .filter((quote) => selected.has(quote.id))
    .sort(byPassageOrder)
    .map(candidateFromListItem);
}

/** What the footer needs: the action's words and press, and the carry picker. */
export interface ScreenFold {
  label: string;
  onPress: () => void;
  /** True while the picker for "Write a review with N quotes" is open. */
  carrying: boolean;
  /** Open the chosen review, carrying the checked quotes under a fresh token. */
  chooseCarried: (_params: ReviewEntryParams) => void;
}

/**
 * The screen's fold arm for the current selection. Also prunes the selection
 * to the rows still listed, so a removed quote -- or one a reload moved to
 * "Used in a review" -- can never be folded from a stale checkbox.
 */
export function useScreenFold(
  injectInto: string | undefined,
  pending: QuoteSection,
  selection: QuoteSelection,
): ScreenFold {
  const navigation = useNavigation<ScreenNavigation>();
  const openHandoff = usePromotedQuoteHandoffStore((store) => store.open);
  const deliver = usePromotedQuoteHandoffStore((store) => store.deliver);
  const [carrying, setCarrying] = useState(false);
  const { selected, keepOnly } = selection;

  const { items } = pending;
  useEffect(() => {
    keepOnly(items.map((quote) => quote.id));
  }, [items, keepOnly]);

  const foldBack = useCallback(() => {
    if (injectInto == null || selected.size === 0) return;
    deliver(injectInto, orderedCandidates(pending, selected));
    navigation.goBack();
  }, [injectInto, selected, pending, deliver, navigation]);

  const chooseCarried = useCallback(
    (params: ReviewEntryParams) => {
      setCarrying(false);
      const token = openHandoff();
      deliver(token, orderedCandidates(pending, selected));
      navigation.navigate('JournalEntry', { ...params, injectQuotes: token });
    },
    [openHandoff, deliver, pending, selected, navigation],
  );

  const count = selected.size;
  if (injectInto != null) {
    return { label: foldSelectedLabel(count), onPress: foldBack, carrying: false, chooseCarried };
  }
  return {
    label: writeReviewWithLabel(count),
    onPress: () => setCarrying((open) => !open),
    carrying,
    chooseCarried,
  };
}

/** The footer while selecting: the carry picker (when open) above the one action. */
export function ScreenFoldFooter({
  fold,
  count,
  refreshKey,
}: {
  fold: ScreenFold;
  count: number;
  refreshKey: number;
}): React.JSX.Element {
  return (
    <View>
      <ReviewScopePicker
        enabled={fold.carrying && count > 0}
        refreshKey={refreshKey}
        onChoose={fold.chooseCarried}
      />
      <QuoteFoldBar label={fold.label} count={count} onPress={fold.onPress} />
    </View>
  );
}
