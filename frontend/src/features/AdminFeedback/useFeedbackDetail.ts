import { useCallback, useEffect, useRef, useState } from 'react';

import { adminFeedback, type FeedbackStatusT, type FeedbackTriageDetailT } from '@/api';
import { useAuth } from '@/context/AuthContext';

export interface FeedbackDetailState {
  detail: FeedbackTriageDetailT | null;
  loading: boolean;
  failed: boolean;
  /** Set when the last change was refused or lost; cleared by the next success. */
  actionFailed: boolean;
  busy: boolean;
  /** Each change resolves ``true`` once the server has applied it, else ``false``. */
  transition: (_status: FeedbackStatusT) => Promise<boolean>;
  linkDuplicate: (_target: string) => Promise<boolean>;
  unlinkDuplicate: () => Promise<boolean>;
  addNote: (_body: string) => Promise<boolean>;
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
export function useFeedbackDetail(
  publicId: string | null,
  onChanged?: () => void,
): FeedbackDetailState {
  const { token } = useAuth();
  const authToken = token ?? undefined;
  const [attempt, setAttempt] = useState(0);
  const { detail, setDetail, loading, failed } = useLoadedDetail(publicId, authToken, attempt);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The report open NOW. A change started on another report may answer after
  // the operator has moved on; its answer must not replace this one's detail,
  // or the next action would be aimed at a report the pane no longer shows.
  const openId = useRef(publicId);
  openId.current = publicId;

  useEffect(() => setActionFailed(false), [publicId]);

  const withReport = useCallback(
    async (change: (_id: string) => Promise<FeedbackTriageDetailT>): Promise<boolean> => {
      if (publicId === null) return false;
      setBusy(true);
      try {
        const updated = await change(publicId);
        if (updated.public_id === openId.current) {
          setDetail(updated);
          setActionFailed(false);
        }
        onChanged?.();
        return true;
      } catch {
        if (publicId === openId.current) setActionFailed(true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [publicId, setDetail, onChanged],
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
