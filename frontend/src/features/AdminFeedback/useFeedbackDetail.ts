import { useCallback, useEffect, useState } from 'react';

import { adminFeedback, type FeedbackStatusT, type FeedbackTriageDetailT } from '@/api';
import { useAuth } from '@/context/AuthContext';

export interface FeedbackDetailState {
  detail: FeedbackTriageDetailT | null;
  loading: boolean;
  failed: boolean;
  /** Set when the last change was refused or lost; cleared by the next success. */
  actionFailed: boolean;
  busy: boolean;
  transition: (_status: FeedbackStatusT) => void;
  linkDuplicate: (_target: string) => void;
  unlinkDuplicate: () => void;
  addNote: (_body: string) => void;
  reload: () => void;
}

interface LoadedDetail {
  detail: FeedbackTriageDetailT | null;
  setDetail: (_detail: FeedbackTriageDetailT | null) => void;
  loading: boolean;
  failed: boolean;
}

/** Load (and on ``attempt`` change, reload) one report's detail. */
function useLoadedDetail(
  publicId: string | null,
  authToken: string | undefined,
  attempt: number,
): LoadedDetail {
  const [detail, setDetail] = useState<FeedbackTriageDetailT | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDetail(null);
    if (publicId === null) return undefined;
    let live = true;
    setLoading(true);
    setFailed(false);
    adminFeedback
      .detail(publicId, authToken)
      .then((loaded) => {
        if (live) setDetail(loaded);
      })
      .catch(() => {
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [publicId, authToken, attempt]);

  return { detail, setDetail, loading, failed };
}

/**
 * One open report, and the four changes an operator can make to it.
 *
 * Every change answers with the report as it now stands, so the pane shows the
 * server's state after each one rather than an optimistic guess -- including
 * which transitions are allowed next, which the server decides.
 */
export function useFeedbackDetail(publicId: string | null): FeedbackDetailState {
  const { token } = useAuth();
  const authToken = token ?? undefined;
  const [attempt, setAttempt] = useState(0);
  const { detail, setDetail, loading, failed } = useLoadedDetail(publicId, authToken, attempt);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setActionFailed(false), [publicId]);

  const withReport = useCallback(
    (change: (_id: string) => Promise<FeedbackTriageDetailT>) => {
      if (publicId === null) return;
      setBusy(true);
      change(publicId)
        .then((updated) => {
          setDetail(updated);
          setActionFailed(false);
        })
        .catch(() => setActionFailed(true))
        .finally(() => setBusy(false));
    },
    [publicId, setDetail],
  );

  return {
    detail,
    loading,
    failed,
    actionFailed,
    busy,
    transition: (status) => withReport((id) => adminFeedback.transition(id, status, authToken)),
    linkDuplicate: (target) =>
      withReport((id) => adminFeedback.linkDuplicate(id, target, authToken)),
    unlinkDuplicate: () => withReport((id) => adminFeedback.unlinkDuplicate(id, authToken)),
    addNote: (body) => withReport((id) => adminFeedback.addNote(id, body, authToken)),
    reload: () => setAttempt((count) => count + 1),
  };
}
