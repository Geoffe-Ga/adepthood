/**
 * Wire a screen's header-left toggle to a local open/close drawer state. Installs
 * a ``DrawerToggle`` as the navigator's ``headerLeft`` while the screen is mounted
 * and clears it on unmount, so each screen owns its own drawer affordance. Uses
 * ``createElement`` (not JSX) so this stays a plain ``.ts`` module.
 */
import React, { useCallback, useLayoutEffect, useState } from 'react';

import DrawerToggle from './DrawerToggle';

import { useAppNavigation } from '@/navigation/hooks';

export interface ScreenDrawerState {
  /** Whether the drawer is currently open. */
  isOpen: boolean;
  /** Open the drawer. */
  open: () => void;
  /** Close the drawer. */
  close: () => void;
}

/** Manage a screen's drawer state and its header-left toggle affordance. */
export function useScreenDrawer(screenName: string): ScreenDrawerState {
  const navigation = useAppNavigation();
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const renderHeaderLeft = useCallback(
    () => React.createElement(DrawerToggle, { screenName, expanded: isOpen, onPress: open }),
    [screenName, isOpen, open],
  );

  useLayoutEffect(() => {
    navigation.setOptions({ headerLeft: renderHeaderLeft });
    return () => {
      navigation.setOptions({ headerLeft: undefined });
    };
  }, [navigation, renderHeaderLeft]);

  return { isOpen, open, close };
}
