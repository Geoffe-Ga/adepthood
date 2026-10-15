import { useCallback, useEffect, useState } from 'react';

import type { OfferSwitchStorage } from './journalOfferSwitches';

import { useActiveUser, useActiveUserGeneration } from '@/storage/useActiveUser';
import { getActiveUser, getActiveUserGeneration } from '@/storage/userScope';

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
  const owner = useActiveUser();
  const epoch = useActiveUserGeneration();
  const [answer, setAnswer] = useState<{
    owner: number | null;
    epoch: number;
    value: boolean;
  } | null>(null);
  const value = answer?.epoch === epoch ? answer.value : null;
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    let live = true;
    setWriting(false);
    void storage.read().then((offered) => {
      if (live && getActiveUser() === owner && getActiveUserGeneration() === epoch)
        setAnswer({ owner, epoch, value: offered });
    });
    return () => {
      live = false;
    };
  }, [storage, owner, epoch]);

  const set = useCallback(
    (next: boolean) => {
      if (getActiveUser() !== owner || getActiveUserGeneration() !== epoch) return;
      setWriting(true);
      void storage.write(next).then((saved) => {
        if (getActiveUser() !== owner || getActiveUserGeneration() !== epoch) return;
        if (saved) setAnswer({ owner, epoch, value: next });
        setWriting(false);
      });
    },
    [storage, owner, epoch],
  );

  return { value: value ?? true, busy: value === null || writing, set };
}
