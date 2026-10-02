import { useCallback, useEffect, useState } from 'react';

import type { OfferSwitchStorage } from './journalOfferSwitches';

/** What a switch row needs: its position, whether it can move, and how to move it. */
export interface OfferSwitch {
  value: boolean;
  busy: boolean;
  set: (_next: boolean) => void;
}

/**
 * Drive one Settings switch from a device-kept flag.
 *
 * The position is read once on mount, so a decline made in the journal is
 * reflected here the next time Settings opens — the switch turns itself off
 * without anyone touching it. A move writes first and shows the new position
 * only once the write has landed: a switch that shows "on" after a failed
 * restore would be promising an offer the device will not make. Until the
 * first read answers, and while a write is out, the row is disabled, so the
 * position shown is never one the device has not confirmed and a second tap
 * cannot race the first.
 */
export function useOfferSwitch(storage: OfferSwitchStorage): OfferSwitch {
  const [value, setValue] = useState<boolean | null>(null);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    let live = true;
    void storage.read().then((offered) => {
      if (live) setValue(offered);
    });
    return () => {
      live = false;
    };
  }, [storage]);

  const set = useCallback(
    (next: boolean) => {
      setWriting(true);
      void storage.write(next).then((saved) => {
        if (saved) setValue(next);
        setWriting(false);
      });
    },
    [storage],
  );

  return { value: value ?? true, busy: value === null || writing, set };
}
