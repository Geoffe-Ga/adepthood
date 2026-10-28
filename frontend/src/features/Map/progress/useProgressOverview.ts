import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { progress, type ApiProgressOverview } from '@/api';
import { captureSessionToken, getAuthSession } from '@/api/sessionToken';
import { useAuth } from '@/context/AuthContext';
import { useMountedRef } from '@/hooks/useMountedRef';
import { useRefetchOnReturn } from '@/hooks/useRefetchOnReturn';
import { useAccountScope } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

const credentialOwner = (token: string | null | undefined): number | null =>
  token ? parseUserId(decodeJwtPayload(token)?.sub) : null;

interface OverviewState {
  key: string;
  overview: ApiProgressOverview | null;
  loading: boolean;
  error: Error | null;
}

function useOverviewContext() {
  const auth = useAuth();
  const scope = useAccountScope();
  const session = getAuthSession();
  const key = `${scope.owner}:${scope.epoch}:${session}:${auth.userTimezone}`;
  return useMemo(
    () => ({
      scope,
      session,
      key,
      token: auth.token,
      ready: auth.authStatus === 'authenticated' && auth.userTimezoneReady,
    }),
    [scope, session, key, auth.token, auth.authStatus, auth.userTimezoneReady],
  );
}
type OverviewContext = ReturnType<typeof useOverviewContext>;

/**
 * A read may only land for the account, session and credential that asked for
 * it: the same guard `usePracticeStory` and `usePaymentScope` keep.
 */
function identityIsCurrent(context: OverviewContext): boolean {
  const { scope, token, session } = context;
  return (
    context.ready &&
    scope.owner !== null &&
    scope.isCurrent() &&
    getAuthSession() === session &&
    credentialOwner(token) === scope.owner &&
    credentialOwner(captureSessionToken()) === scope.owner
  );
}

/** Own request ordering and the held-while-reloading state. */
function useOverviewRead(context: OverviewContext) {
  const latest = useRef(context);
  latest.current = context;
  const mounted = useMountedRef();
  const ticket = useRef(0);
  const [state, setState] = useState<OverviewState>({
    key: '',
    overview: null,
    loading: false,
    error: null,
  });
  const canRead = useCallback(
    () => mounted.current && latest.current === context && identityIsCurrent(context),
    [context, mounted],
  );
  const refresh = useCallback(async () => {
    if (!canRead()) return;
    const request = ++ticket.current;
    const current = () => canRead() && ticket.current === request;
    const { key, token } = context;
    setState((previous) => ({
      key,
      overview: previous.key === key ? previous.overview : null,
      loading: true,
      error: null,
    }));
    try {
      const overview = await progress.overview(token ?? undefined);
      if (current()) setState({ key, overview, loading: false, error: null });
    } catch (error) {
      if (current()) setState({ key, overview: null, loading: false, error: toError(error) });
    }
  }, [canRead, context]);
  return { state, refresh, canRead };
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Read the whole-person Progress Overview (#3522) for the Map's Progress screen,
 * re-reading on return to the screen. A re-read keeps the previous overview on
 * screen (``loading`` lets the screen dim it); another account never sees it.
 */
export function useProgressOverview() {
  const context = useOverviewContext();
  const { state, refresh, canRead } = useOverviewRead(context);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRefetchOnReturn(() => {
    void refresh();
  });
  const shown = state.key === context.key && canRead();
  return {
    overview: shown ? state.overview : null,
    loading: shown ? state.loading : true,
    error: shown ? state.error : null,
    refresh,
  };
}
