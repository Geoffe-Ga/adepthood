import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { formatApiError } from '@/api/errorMessages';

/**
 * Shared submit state-machine for the Auth screens.
 *
 * Every auth form is the same shape: an ``error``/``submitting`` pair wrapped
 * around one async call whose failures map through ``formatApiError``. This hook
 * owns that try/catch/finally so Login/Signup/Forgot/Reset/Reauth don't each
 * re-derive it. ``run`` keeps a stable identity (config is stashed in a ref and
 * re-read every call, mirroring ``useOptimisticMutation``) and an in-flight guard
 * makes a synchronous second ``run()`` a no-op until the first settles.
 */

interface AuthSubmit {
  submitting: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  run: () => Promise<void>;
}

interface AuthSubmitConfig {
  fn: () => Promise<void>;
  fallback: string;
}

export function useAuthSubmit(
  fn: () => Promise<void>,
  { fallback }: { fallback: string },
): AuthSubmit {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const cfgRef = useRef<AuthSubmitConfig>({ fn, fallback });
  cfgRef.current = { fn, fallback };

  const inFlightRef = useRef(false);

  const run = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    const cfg = cfgRef.current;
    setError(null);
    setSubmitting(true);
    try {
      await cfg.fn();
    } catch (err: unknown) {
      // BUG-FRONTEND-INFRA-016: formatApiError maps timeouts and backend codes to user copy.
      setError(formatApiError(err, { fallback: cfg.fallback }));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  return { submitting, error, setError, run };
}
