/** Paged prompt history, bound to the account and the visit that requested it. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { prompts, PromptDetail } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import { useAccountScope } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/** Rows per request; the route caps limit at 200. */
export const PROMPT_HISTORY_PAGE_SIZE = 20;

export interface PromptHistoryState {
  items: PromptDetail[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

type HistoryPage = Omit<PromptHistoryState, 'loadMore'> & { epoch: number };

function emptyPage(epoch: number): HistoryPage {
  return { epoch, items: [], loading: false, error: null, hasMore: false };
}

/** Namespace adoption precedes Auth's token commit: wait for the matching credential. */
function useHistoryAccount() {
  const { token } = useAuth();
  const scope = useAccountScope();
  const credentialOwner = token ? parseUserId(decodeJwtPayload(token)?.sub) : null;
  return useMemo(
    () => ({
      ...scope,
      token,
      authenticated: scope.owner !== null && credentialOwner === scope.owner,
    }),
    [scope, token, credentialOwner],
  );
}

async function readHistoryPage(
  offset: number,
  fetchHistory: typeof prompts.history,
  account: ReturnType<typeof useHistoryAccount>,
  isCurrent: () => boolean,
  setPage: Dispatch<SetStateAction<HistoryPage>>,
): Promise<void> {
  if (!account.authenticated || !isCurrent()) return;
  setPage((prev) => ({ ...prev, loading: true, error: null }));
  try {
    const page = await fetchHistory(
      { limit: PROMPT_HISTORY_PAGE_SIZE, offset },
      account.token ?? undefined,
    );
    if (!isCurrent()) return;
    setPage((prev) => ({
      ...prev,
      epoch: account.epoch,
      items: offset === 0 ? page.items : [...prev.items, ...page.items],
      hasMore: page.has_more,
    }));
  } catch (err: unknown) {
    if (isCurrent())
      setPage((prev) => ({
        ...prev,
        error: formatApiError(err, { fallback: 'Could not load your past prompts.' }),
      }));
  } finally {
    if (isCurrent()) setPage((prev) => ({ ...prev, loading: false }));
  }
}

export function usePromptHistory(
  visible: boolean,
  fetchHistory: typeof prompts.history,
): PromptHistoryState {
  const account = useHistoryAccount();
  const [page, setPage] = useState(() => emptyPage(account.epoch));
  // A boolean cannot distinguish a late answer from a previous visit once the
  // same surface has reopened. Each focus/credential lifecycle gets a revision.
  const visit = useRef(0);
  const loadPage = useCallback(
    (offset: number) => {
      const revision = visit.current;
      return readHistoryPage(
        offset,
        fetchHistory,
        account,
        () => visit.current === revision && account.isCurrent(),
        setPage,
      );
    },
    [fetchHistory, account],
  );

  useEffect(() => {
    if (!visible || !account.authenticated) return;
    visit.current += 1;
    setPage(emptyPage(account.epoch));
    void loadPage(0);
    return () => {
      visit.current += 1;
    };
  }, [visible, account, loadPage]);

  const loadMore = useCallback(() => {
    if (!page.loading) void loadPage(page.items.length);
  }, [page.loading, page.items.length, loadPage]);
  const current = account.authenticated && page.epoch === account.epoch;
  return { ...(current ? page : emptyPage(account.epoch)), loadMore };
}
