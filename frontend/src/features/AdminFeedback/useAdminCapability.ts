import { useCallback, useEffect, useState } from 'react';

import { adminFeedback, ApiError } from '@/api';
import { useAuth } from '@/context/AuthContext';

/**
 * Whether this account may open the feedback inbox, as the SERVER says.
 *
 * - ``unknown`` while the answer is in flight -- nothing admin-only renders;
 * - ``admin`` only after ``GET /admin/capabilities`` returned 200 and said so;
 * - ``not-admin`` on a 401 or 403, or when nobody is signed in (no request is
 *   made at all then);
 * - ``unavailable`` when the question could not be answered (offline, 5xx).
 *
 * There is no client-side role inference anywhere: no token is decoded and no
 * user object is consulted. A cached or optimistic "admin" would be exactly the
 * inference the server-confirmed signal exists to replace.
 */
export type AdminCapability = 'unknown' | 'admin' | 'not-admin' | 'unavailable';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** The two answers that mean "not an operator" rather than "could not ask". */
const DENIED_STATUSES: ReadonlySet<number> = new Set([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN]);

function capabilityFromError(error: unknown): AdminCapability {
  return error instanceof ApiError && DENIED_STATUSES.has(error.status)
    ? 'not-admin'
    : 'unavailable';
}

export interface AdminCapabilityState {
  capability: AdminCapability;
  /** Ask again, e.g. after ``unavailable``. */
  recheck: () => void;
}

export function useAdminCapability(): AdminCapabilityState {
  const { token } = useAuth();
  const [capability, setCapability] = useState<AdminCapability>('unknown');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) {
      setCapability('not-admin');
      return undefined;
    }
    let live = true;
    setCapability('unknown');
    adminFeedback
      .capabilities(token)
      .then((granted) => {
        if (live) setCapability(granted.feedback_triage ? 'admin' : 'not-admin');
      })
      .catch((error: unknown) => {
        if (live) setCapability(capabilityFromError(error));
      });
    return () => {
      live = false;
    };
  }, [token, attempt]);

  const recheck = useCallback(() => setAttempt((count) => count + 1), []);
  return { capability, recheck };
}
