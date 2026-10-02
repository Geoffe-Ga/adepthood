/**
 * `useDetailOverlay` — state for the embedded catalog's in-place practice
 * details (#2451).
 *
 * A row on the Practice tab's Catalog opens its details over the catalog
 * rather than pushing a screen, so declining them leaves the catalog as it
 * was. Choosing the practice there is the row's own "Use" by another door: the
 * overlay closes and ``onCatalogActivated`` flips to the player with its single
 * silent refresh -- never a ``popToTop``, since nothing was pushed.
 *
 * The overlay belongs to the Catalog tab, so leaving that tab by any path
 * closes it, and coming back to the catalog never resurrects a stale overlay.
 * Focus is handed back to the opening row only on a plain dismiss: after a
 * flip or a push, that row is on its way out of view.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PracticeTab } from '@/features/Practice/components/PracticeCatalogSwitcher';
import type { CustomizeCopyParams } from '@/features/Practice/screens/PracticeDetailScreen';
import type { RootStackParamList } from '@/navigation/RootStack';

export interface DetailOverlayState {
  /** The practice whose details float over the catalog, or ``null``. */
  practiceId: number | null;
  openDetail: (_practiceId: number) => void;
  closeDetail: () => void;
  /** An assign or copy from the overlay: close it, then flip to the player. */
  onActivated: () => void;
  /** "Duplicate & edit" from the overlay: close it, then open the wizard. */
  onCustomizeCopy: (_params: CustomizeCopyParams) => void;
  /** The catalog row that opened the overlay, which gets focus back on dismiss. */
  openerRef: React.RefObject<{ focus: () => void } | null>;
}

export function useDetailOverlay(
  tab: PracticeTab,
  onCatalogActivated: () => void,
): DetailOverlayState {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [practiceId, setPracticeId] = useState<number | null>(null);
  const openerRef = useRef<{ focus: () => void } | null>(null);
  const openDetail = useCallback((id: number) => setPracticeId(id), []);
  const closeDetail = useCallback(() => setPracticeId(null), []);
  const leaveWithoutFocus = useCallback(() => {
    openerRef.current = null;
    setPracticeId(null);
  }, []);
  useEffect(() => {
    if (tab !== 'catalog') leaveWithoutFocus();
  }, [tab, leaveWithoutFocus]);
  const onActivated = useCallback(() => {
    leaveWithoutFocus();
    onCatalogActivated();
  }, [leaveWithoutFocus, onCatalogActivated]);
  const onCustomizeCopy = useCallback(
    (params: CustomizeCopyParams) => {
      leaveWithoutFocus();
      navigation.navigate('CreatePractice', params);
    },
    [leaveWithoutFocus, navigation],
  );
  return { practiceId, openDetail, closeDetail, onActivated, onCustomizeCopy, openerRef };
}
