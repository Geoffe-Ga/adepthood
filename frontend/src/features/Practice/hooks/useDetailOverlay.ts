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
 *
 * Every open is a numbered session, and an assign or copy reports back with
 * the session that started it. The X, the scrim and Escape stay live while a
 * request is pending -- a slow network must never trap someone in a sheet --
 * so a request can land after its sheet is gone and another is on show. Such
 * a stale success still happened on the server, so the player's selection is
 * re-read quietly; it never closes the sheet now on show or flips the tab.
 *
 * A choice also says where focus goes. react-native-web's Modal hands focus
 * back, as it unmounts, to whatever held it before it opened: the catalog row.
 * After a flip that row is still mounted for the cross-fade, but aria-hidden
 * and out of reach, and once it unmounts focus falls to the page body. So the
 * live choice lands focus on ``landingRef`` -- the player's Practice tab --
 * from an effect of the commit that closes the sheet, which React runs after
 * the Modal's own unmount cleanup. Native readers get the same landing.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { View } from 'react-native';

import type { PracticeTab } from '@/features/Practice/components/PracticeCatalogSwitcher';
import type { CustomizeCopyParams } from '@/features/Practice/screens/PracticeDetailScreen';
import type { RootStackParamList } from '@/navigation/RootStack';
import { moveAccessibilityFocus } from '@/utils/accessibilityFocus';

export interface DetailOverlayState {
  /** The practice whose details float over the catalog, or ``null``. */
  practiceId: number | null;
  /** Which open this is; a fresh number every time the overlay opens. */
  session: number;
  openDetail: (_practiceId: number) => void;
  closeDetail: () => void;
  /**
   * An assign or copy from the overlay's ``session`` succeeded: close it and
   * flip to the player when that session is still the one on show, else only
   * re-read the player's selection.
   */
  onActivated: (_session: number) => void;
  /** "Duplicate & edit" from the overlay: close it, then open the wizard. */
  onCustomizeCopy: (_params: CustomizeCopyParams) => void;
  /** The catalog row that opened the overlay, which gets focus back on dismiss. */
  openerRef: React.RefObject<{ focus: () => void } | null>;
  /** Where focus lands after a choice flips to the player: the Practice tab. */
  landingRef: React.RefObject<View | null>;
}

interface OpenDetail {
  practiceId: number;
  session: number;
}

/** The open sheet, numbered per open; ``live`` names the session on show. */
function useDetailSessions(): {
  open: OpenDetail | null;
  live: React.RefObject<number | null>;
  openDetail: (_practiceId: number) => void;
  closeDetail: () => void;
} {
  const [open, setOpen] = useState<OpenDetail | null>(null);
  const opened = useRef(0);
  const live = useRef<number | null>(null);
  const openDetail = useCallback((practiceId: number) => {
    opened.current += 1;
    live.current = opened.current;
    setOpen({ practiceId, session: opened.current });
  }, []);
  const closeDetail = useCallback(() => {
    live.current = null;
    setOpen(null);
  }, []);
  return { open, live, openDetail, closeDetail };
}

/** A focus target, and a request to land on it once the current commit settles. */
function useFocusLanding(): { landingRef: React.RefObject<View | null>; land: () => void } {
  const landingRef = useRef<View>(null);
  const [landings, setLandings] = useState(0);
  useEffect(() => {
    if (landings > 0) moveAccessibilityFocus(landingRef.current);
  }, [landings]);
  const land = useCallback(() => setLandings((count) => count + 1), []);
  return { landingRef, land };
}

export function useDetailOverlay(
  tab: PracticeTab,
  onCatalogActivated: () => void,
  refresh: (_opts?: { silent?: boolean }) => Promise<void>,
): DetailOverlayState {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { open, live, openDetail, closeDetail } = useDetailSessions();
  const openerRef = useRef<{ focus: () => void } | null>(null);
  const { landingRef, land } = useFocusLanding();
  const leaveWithoutFocus = useCallback(() => {
    openerRef.current = null;
    closeDetail();
  }, [closeDetail]);
  useEffect(() => {
    if (tab !== 'catalog') leaveWithoutFocus();
  }, [tab, leaveWithoutFocus]);
  const onActivated = useCallback(
    (session: number) => {
      if (session !== live.current) {
        void refresh({ silent: true });
        return;
      }
      leaveWithoutFocus();
      land();
      onCatalogActivated();
    },
    [live, refresh, leaveWithoutFocus, land, onCatalogActivated],
  );
  const onCustomizeCopy = useCallback(
    (params: CustomizeCopyParams) => {
      leaveWithoutFocus();
      navigation.navigate('CreatePractice', params);
    },
    [leaveWithoutFocus, navigation],
  );
  return {
    practiceId: open?.practiceId ?? null,
    session: open?.session ?? 0,
    openDetail,
    closeDetail,
    onActivated,
    onCustomizeCopy,
    openerRef,
    landingRef,
  };
}
