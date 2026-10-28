import { useCallback, useEffect, useRef, useState } from 'react';

import { captureCourseSession, type CourseSession } from './courseSession';

import { depthPreferences } from '@/api';
import { hasOnlySessionEnded } from '@/api/sessionToken';
import { useMountedRef } from '@/hooks/useMountedRef';
import { getActiveUserGeneration } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

export type EnergyHandoffStatus = 'idle' | 'checking' | 'disabled' | 'error';

/** A cold tab's default-on cache cannot establish the caller's confirmed choice. */
export function useEnergyScaffoldingHandoff(
  enabled: boolean,
  onOpen: (_session: CourseSession) => void,
) {
  const [status, setStatus] = useState<EnergyHandoffStatus>('idle');
  const pending = useRef(false);
  const sequence = useRef(0);
  const mounted = useMountedRef();
  const generation = getActiveUserGeneration();

  useEffect(() => {
    sequence.current += 1;
    pending.current = false;
    setStatus('idle');
  }, [generation, enabled]);

  const start = useCallback(() => {
    const session = captureCourseSession();
    if (pending.current || !session || !useDepthPreferencesStore.getState().enable_habits) return;
    const request = ++sequence.current;
    const current = () => mounted.current && sequence.current === request && session.current();
    // The same account in a later session: never open, but release the button (#3423).
    const sessionEnded = () =>
      mounted.current && sequence.current === request && hasOnlySessionEnded(session);
    pending.current = true;
    setStatus('checking');
    void depthPreferences
      .get(session.token)
      .then((confirmed) => {
        if (!current()) {
          if (sessionEnded()) setStatus('error');
          return;
        }
        if (!confirmed.enable_habits || !useDepthPreferencesStore.getState().enable_habits) {
          setStatus('disabled');
        } else {
          setStatus('idle');
          onOpen(session);
        }
      })
      .catch(() => {
        if (current() || sessionEnded()) setStatus('error');
      })
      .finally(() => {
        if (sequence.current === request) pending.current = false;
      });
  }, [mounted, onOpen]);

  return { status, start };
}
