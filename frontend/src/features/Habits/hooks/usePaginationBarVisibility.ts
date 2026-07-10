// Owns the show/hide state of the in-body pagination bar. Defaults to visible,
// loads the persisted flag once on mount, and persists the inverse on toggle so
// the next launch honours the last choice.
import { useEffect, useState } from 'react';

import {
  loadPaginationBarHidden,
  savePaginationBarHidden,
} from '../../../storage/paginationVisibilityStorage';

export interface PaginationBarVisibility {
  /** Whether the in-body pagination bar should render. */
  barVisible: boolean;
  /** Flip visibility and persist the matching hidden flag. */
  toggleBarVisible: () => void;
}

/** Track pagination-bar visibility, hydrating from and writing back to storage. */
export function usePaginationBarVisibility(): PaginationBarVisibility {
  const [barVisible, setBarVisible] = useState(true);

  useEffect(() => {
    let mounted = true;
    loadPaginationBarHidden()
      .then((hidden) => {
        if (mounted) setBarVisible(!hidden);
      })
      .catch(() => {
        // loadPaginationBarHidden already fails open; nothing to recover here.
      });
    return () => {
      mounted = false;
    };
  }, []);

  const toggleBarVisible = (): void => {
    setBarVisible((prev) => {
      const next = !prev;
      void savePaginationBarHidden(!next);
      return next;
    });
  };

  return { barVisible, toggleBarVisible };
}
