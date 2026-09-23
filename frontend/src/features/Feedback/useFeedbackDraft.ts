/**
 * The composer's draft: hydrated from the device, persisted on every change,
 * and carrying the one idempotency key its report will be sent under.
 *
 * The key is minted when a draft is first created and is written to storage --
 * awaited -- before `hydrated` turns true, and the composer keeps Send disabled
 * until then. A remount, a navigation away and back, or an app restart therefore
 * reads the SAME key back, so no path can file this draft twice. It is a raw
 * UUID rather than `idempotencyKey(...)`: nothing about a draft's identity is
 * derivable from domain data, and the API helper is the API layer's own.
 *
 * Hydrating never sends anything. A restored draft -- frozen attempt included --
 * waits for a press.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import type { FeedbackAnswerField } from './feedbackCategories';
import { EMPTY_FEEDBACK_ANSWERS } from './feedbackPayload';

import type { FeedbackCategory, FeedbackCreate, FeedbackImpact } from '@/api';
import {
  clearFeedbackDraft,
  loadFeedbackDraft,
  saveFeedbackDraft,
  type StoredFeedbackDraft,
} from '@/storage/feedbackDraftStorage';

const WARN_SAVE = '[feedback] could not save the draft on this device';
const WARN_CLEAR = '[feedback] could not clear the sent draft on this device';

/** A brand-new draft under a freshly minted key. */
export function freshFeedbackDraft(): StoredFeedbackDraft {
  return {
    category: null,
    impact: null,
    answers: { ...EMPTY_FEEDBACK_ANSWERS },
    idempotencyKey: uuidv4(),
    attempt: null,
  };
}

export interface FeedbackDraftApi {
  /** False until the stored draft (or a fresh, persisted one) is in hand. */
  hydrated: boolean;
  draft: StoredFeedbackDraft;
  setCategory: (category: FeedbackCategory) => void;
  setImpact: (impact: FeedbackImpact) => void;
  setAnswer: (field: FeedbackAnswerField, value: string) => void;
  /** Record an attempt whose outcome is unknown, so a retry resends it exactly. */
  freezeAttempt: (payload: FeedbackCreate) => Promise<void>;
  /** Drop a frozen attempt to edit again -- under a NEW key. */
  reopenForEdit: () => Promise<void>;
  /** Remove the draft once its receipt is confirmed. */
  clear: () => Promise<void>;
}

async function persist(draft: StoredFeedbackDraft): Promise<void> {
  try {
    await saveFeedbackDraft(draft);
  } catch {
    console.warn(WARN_SAVE);
  }
}

async function loadOrCreate(): Promise<StoredFeedbackDraft> {
  const stored = await loadFeedbackDraft();
  if (stored !== null) return stored;
  const created = freshFeedbackDraft();
  await persist(created);
  return created;
}

type Commit = (next: StoredFeedbackDraft) => Promise<void>;

/** Load the stored draft once on mount; ignore a load that lands after unmount. */
function useHydration(adopt: (loaded: StoredFeedbackDraft) => void): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let active = true;
    void loadOrCreate().then((loaded) => {
      if (!active) return;
      adopt(loaded);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [adopt]);
  return hydrated;
}

type DraftEdits = Omit<FeedbackDraftApi, 'hydrated' | 'draft' | 'clear'>;

function useDraftEdits(draftRef: React.RefObject<StoredFeedbackDraft>, commit: Commit): DraftEdits {
  const update = useCallback(
    (patch: Partial<StoredFeedbackDraft>): void => {
      void commit({ ...draftRef.current, ...patch });
    },
    [commit, draftRef],
  );
  const setCategory = useCallback((category: FeedbackCategory) => update({ category }), [update]);
  const setImpact = useCallback((impact: FeedbackImpact) => update({ impact }), [update]);
  const setAnswer = useCallback(
    (field: FeedbackAnswerField, value: string) =>
      update({ answers: { ...draftRef.current.answers, [field]: value } }),
    [update, draftRef],
  );
  const freezeAttempt = useCallback(
    (payload: FeedbackCreate) =>
      commit({ ...draftRef.current, attempt: { key: draftRef.current.idempotencyKey, payload } }),
    [commit, draftRef],
  );
  const reopenForEdit = useCallback(
    () => commit({ ...draftRef.current, attempt: null, idempotencyKey: uuidv4() }),
    [commit, draftRef],
  );
  return { setCategory, setImpact, setAnswer, freezeAttempt, reopenForEdit };
}

async function clearDraft(): Promise<void> {
  try {
    await clearFeedbackDraft();
  } catch {
    console.warn(WARN_CLEAR);
  }
}

export function useFeedbackDraft(): FeedbackDraftApi {
  const [draft, setDraft] = useState<StoredFeedbackDraft>(freshFeedbackDraft);
  const draftRef = useRef(draft);

  const adopt = useCallback((next: StoredFeedbackDraft): void => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  const commit = useCallback(
    (next: StoredFeedbackDraft): Promise<void> => {
      adopt(next);
      return persist(next);
    },
    [adopt],
  );

  const hydrated = useHydration(adopt);
  const edits = useDraftEdits(draftRef, commit);
  return { hydrated, draft, ...edits, clear: clearDraft };
}
