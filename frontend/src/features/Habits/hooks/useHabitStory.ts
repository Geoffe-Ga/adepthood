import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { habits as habitsApi, type ApiHabitStory } from '@/api';
import { captureSessionToken, getAuthSession } from '@/api/sessionToken';
import { useAuth } from '@/context/AuthContext';
import type { Habit } from '@/features/Habits/Habits.types';
import { isServerBackedHabit } from '@/features/Habits/services/serverIds';
import { useMountedRef } from '@/hooks/useMountedRef';
import { useAccountScope } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/** What a Story read needs to know about a habit: its id and where that id came from. */
export type StoryTarget = Pick<Habit, 'isDemoSeed' | 'hasClientMintedIds'> & {
  id?: number | null;
};

/** What the Story sheet needs: a target to read and a name for its header. */
export type StoryHabit = StoryTarget & Pick<Habit, 'name'>;

const credentialOwner = (token: string | null | undefined): number | null =>
  token ? parseUserId(decodeJwtPayload(token)?.sub) : null;

interface StoryState {
  key: string;
  story: ApiHabitStory | null;
  loading: boolean;
  error: Error | null;
}

const IDLE: StoryState = { key: '', story: null, loading: false, error: null };

function useStoryContext(habit: StoryTarget | null, visible: boolean) {
  const auth = useAuth();
  const scope = useAccountScope();
  const session = getAuthSession();
  const habitId = habit?.id ?? null;
  const remote = habit !== null && isServerBackedHabit(habit);
  const key = `${scope.owner}:${scope.epoch}:${session}:${habitId}:${auth.userTimezone}`;
  return useMemo(
    () => ({
      scope,
      session,
      token: auth.token,
      key,
      habitId,
      timezone: auth.userTimezone,
      wanted: visible && remote && habitId !== null,
      ready: auth.authStatus === 'authenticated' && auth.userTimezoneReady,
    }),
    [
      scope,
      session,
      auth.token,
      auth.authStatus,
      auth.userTimezoneReady,
      auth.userTimezone,
      key,
      habitId,
      visible,
      remote,
    ],
  );
}
type StoryContext = ReturnType<typeof useStoryContext>;

/** A read may only land for the account, session and credential that asked for it. */
function identityIsCurrent(context: StoryContext): boolean {
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

/**
 * Read one habit's Story (#3524) while its sheet is open.
 *
 * A re-read of the same habit keeps the previous story on screen (``loading``
 * lets the sheet dim it) rather than flashing empty; a different habit, account
 * or timezone never shows another's story. Demo and client-minted rows have no
 * server record, so nothing is requested for them and ``local`` says so.
 */
export function useHabitStory(habit: StoryTarget | null, visible: boolean) {
  const context = useStoryContext(habit, visible);
  const latest = useRef(context);
  latest.current = context;
  const mounted = useMountedRef();
  const ticket = useRef(0);
  const [state, setState] = useState<StoryState>(IDLE);
  const canRead = useCallback(
    () => mounted.current && latest.current === context && identityIsCurrent(context),
    [context, mounted],
  );
  const refresh = useCallback(async () => {
    if (!context.wanted || context.habitId === null || !canRead()) return;
    const request = ++ticket.current;
    const current = () => canRead() && ticket.current === request;
    const { key, habitId, token } = context;
    setState((previous) => ({
      key,
      story: previous.key === key ? previous.story : null,
      loading: true,
      error: null,
    }));
    try {
      const story = await habitsApi.getStory(habitId, token ?? undefined);
      if (current()) setState({ key, story, loading: false, error: null });
    } catch (error) {
      if (current())
        setState({
          key,
          story: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
    }
  }, [canRead, context]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const shown = context.wanted && state.key === context.key && canRead();
  return {
    story: shown ? state.story : null,
    loading: shown ? state.loading : context.wanted,
    error: shown ? state.error : null,
    local: habit !== null && !isServerBackedHabit(habit),
    refresh,
    timezone: context.timezone,
  };
}
