import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  practiceSessions,
  userPractices,
  type PracticeStoryResponse,
  type UserPractice,
} from '@/api';
import { captureSessionToken, getAuthSession } from '@/api/sessionToken';
import { useAuth } from '@/context/AuthContext';
import { usePracticeRecordRevision } from '@/features/Practice/practiceRecordEvents';
import { toError } from '@/features/Practice/utils/toError';
import { useMountedRef } from '@/hooks/useMountedRef';
import { useRefetchOnReturn } from '@/hooks/useRefetchOnReturn';
import { useAccountScope } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

function credentialOwner(token: string | null | undefined): number | null {
  return token ? parseUserId(decodeJwtPayload(token)?.sub) : null;
}

/** Prefer the requested stage's live adoption; a historical adoption still names lifetime work. */
function chooseAdoption(rows: UserPractice[], practiceId: number, stageNumber: number) {
  const mine = rows.filter((row) => row.practice_id === practiceId);
  return (
    mine.find((row) => row.stage_number === stageNumber && row.end_date === null) ??
    mine.sort((a, b) => b.start_date.localeCompare(a.start_date) || b.id - a.id)[0]
  );
}
interface StoryState {
  key: string;
  story: PracticeStoryResponse | null;
  isLoading: boolean;
  error: Error | null;
}
function useStoryContext(practiceId: number, stageNumber: number) {
  const auth = useAuth();
  const scope = useAccountScope();
  const session = getAuthSession();
  const timezone = auth.userTimezone;
  const key = `${scope.owner}:${scope.epoch}:${session}:${practiceId}:${stageNumber}:${timezone}`;
  return useMemo(
    () => ({
      scope,
      session,
      token: auth.token,
      key,
      timezone,
      practiceId,
      stageNumber,
      ready: auth.authStatus === 'authenticated' && auth.userTimezoneReady,
    }),
    [
      scope,
      session,
      auth.token,
      auth.authStatus,
      auth.userTimezoneReady,
      key,
      timezone,
      practiceId,
      stageNumber,
    ],
  );
}
type StoryContext = ReturnType<typeof useStoryContext>;
function storyIdentityIsCurrent(context: StoryContext): boolean {
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
async function fetchStory(context: StoryContext, current: () => boolean) {
  const token = context.token ?? undefined;
  const rows = await userPractices.list(token);
  if (!current()) return undefined;
  const adopted = chooseAdoption(rows, context.practiceId, context.stageNumber);
  return adopted === undefined ? null : practiceSessions.story(adopted.id, token);
}
/** Own request ordering and mount lifetime independently from refresh triggers. */
function useStoryRead(context: StoryContext) {
  const latest = useRef(context);
  latest.current = context;
  const mounted = useMountedRef();
  const ticket = useRef(0);
  const key = context.key;
  const [state, setState] = useState<StoryState>({
    key,
    story: null,
    isLoading: true,
    error: null,
  });
  const canRead = useCallback(
    () => mounted.current && latest.current === context && storyIdentityIsCurrent(context),
    [context, mounted],
  );
  const refresh = useCallback(async () => {
    if (!canRead()) return;
    const request = ++ticket.current;
    const current = () => canRead() && ticket.current === request;
    setState({ key, story: null, isLoading: true, error: null });
    try {
      const story = await fetchStory(context, current);
      if (story !== undefined && current()) setState({ key, story, isLoading: false, error: null });
    } catch (error) {
      if (current()) setState({ key, story: null, isLoading: false, error: toError(error) });
    }
  }, [canRead, context, key]);
  return { state, refresh, canRead };
}
export function usePracticeStory(practiceId: number, stageNumber: number) {
  const context = useStoryContext(practiceId, stageNumber);
  const { state, refresh, canRead } = useStoryRead(context);
  const revision = usePracticeRecordRevision();
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  useRefetchOnReturn(() => {
    void refresh();
  });
  const visible = state.key === context.key && canRead();
  return {
    story: visible ? state.story : null,
    isLoading: visible ? state.isLoading : false,
    error: visible ? state.error : null,
    refresh,
    timezone: context.timezone,
  };
}
