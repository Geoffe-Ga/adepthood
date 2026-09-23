/**
 * The composer's draft: hydrated from the device, persisted on every change,
 * and carrying the one idempotency key its report will be sent under.
 *
 * The key is minted when a draft is first created and is written to storage --
 * awaited -- before `hydrated` turns true, and the composer keeps Send hidden
 * until then. A remount, a navigation away and back, or an app restart therefore
 * reads the SAME key back, so no path can file this draft twice. It is a raw
 * UUID rather than `idempotencyKey(...)`: nothing about a draft's identity is
 * derivable from domain data, and the API helper is the API layer's own.
 *
 * Every write goes to the storage key of the account that OPENED the composer,
 * resolved once at mount, and only while that account is still the active one.
 * A send can outlive the composer and the session; after a logout or an account
 * switch its late writes are dropped rather than landing under someone else's
 * key -- or back on disk after the wipe.
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
  feedbackDraftKey,
  readFeedbackDraft,
  saveFeedbackDraft,
  settleFeedbackAttempt,
  type StoredFeedbackDraft,
} from '@/storage/feedbackDraftStorage';
import { getActiveUser } from '@/storage/userScope';

const WARN_SAVE = '[feedback] could not save the draft on this device';
const WARN_SETTLE = '[feedback] could not update the sent draft on this device';
const WARN_UNREADABLE =
  '[feedback] the saved draft could not be read; starting a new one without replacing it';

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

/** How a sent attempt ended, as far as the stored draft is concerned. */
export type AttemptOutcome = 'sent' | 'unfreeze';

export interface FeedbackDraftApi {
  /** False until the stored draft (or a fresh, persisted one) is in hand. */
  hydrated: boolean;
  draft: StoredFeedbackDraft;
  setCategory: (category: FeedbackCategory) => void;
  setImpact: (impact: FeedbackImpact) => void;
  setAnswer: (field: FeedbackAnswerField, value: string) => void;
  /** Record the attempt about to be sent, so a restart resends it exactly. */
  freezeAttempt: (payload: FeedbackCreate) => Promise<void>;
  /** Drop a frozen attempt to edit again -- under a NEW key. */
  reopenForEdit: () => Promise<void>;
  /**
   * Settle the attempt sent under `sentKey`: `sent` removes the draft,
   * `unfreeze` makes it editable again under the same key. Applied to what is
   * stored now, and skipped entirely if the account has changed since mount.
   */
  settleAttempt: (sentKey: string, outcome: AttemptOutcome) => Promise<void>;
}

/** Whose draft this composer holds, fixed when it mounts. */
interface DraftScope {
  owner: number | null;
  key: string;
  /** False when the stored draft could not be read: never write over it. */
  writable: boolean;
}

function currentScope(): DraftScope {
  return { owner: getActiveUser(), key: feedbackDraftKey(), writable: true };
}

function ownsStorage(scope: DraftScope): boolean {
  return scope.writable && getActiveUser() === scope.owner;
}

async function persist(scope: DraftScope, draft: StoredFeedbackDraft): Promise<void> {
  if (!ownsStorage(scope)) return;
  try {
    await saveFeedbackDraft(draft, scope.key);
  } catch {
    console.warn(WARN_SAVE);
  }
}

/**
 * The draft to start from, or `null` when the composer closed before it was
 * known -- in which case no key is minted and nothing is written.
 */
async function loadOrCreate(
  scope: DraftScope,
  isActive: () => boolean,
): Promise<StoredFeedbackDraft | null> {
  const read = await readFeedbackDraft(scope.key);
  if (read.kind === 'draft') return read.draft;
  if (read.kind === 'unreadable') {
    // A read blip is not an empty slot: writing a fresh draft here would
    // destroy the saved one, its frozen attempt and its key.
    console.warn(WARN_UNREADABLE);
    scope.writable = false;
    return freshFeedbackDraft();
  }
  if (!isActive()) return null;
  const created = freshFeedbackDraft();
  await persist(scope, created);
  return created;
}

/** Load the stored draft once on mount; ignore a load that lands after unmount. */
function useHydration(scope: DraftScope, adopt: (loaded: StoredFeedbackDraft) => void): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let active = true;
    void loadOrCreate(scope, () => active).then((loaded) => {
      if (!active || loaded === null) return;
      adopt(loaded);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [adopt, scope]);
  return hydrated;
}

type Commit = (next: StoredFeedbackDraft) => Promise<void>;

type DraftEdits = Omit<FeedbackDraftApi, 'hydrated' | 'draft' | 'settleAttempt'>;

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

function useSettleAttempt(
  scope: DraftScope,
  draftRef: React.RefObject<StoredFeedbackDraft>,
  adopt: (next: StoredFeedbackDraft) => void,
): FeedbackDraftApi['settleAttempt'] {
  return useCallback(
    async (sentKey: string, outcome: AttemptOutcome): Promise<void> => {
      if (getActiveUser() !== scope.owner) return;
      if (scope.writable) {
        try {
          await settleFeedbackAttempt(scope.key, sentKey, outcome);
        } catch {
          console.warn(WARN_SETTLE);
        }
      }
      if (outcome === 'unfreeze' && draftRef.current.attempt?.key === sentKey) {
        adopt({ ...draftRef.current, attempt: null });
      }
    },
    [scope, draftRef, adopt],
  );
}

export function useFeedbackDraft(): FeedbackDraftApi {
  const [scope] = useState(currentScope);
  const [draft, setDraft] = useState<StoredFeedbackDraft>(freshFeedbackDraft);
  const draftRef = useRef(draft);

  const adopt = useCallback((next: StoredFeedbackDraft): void => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  const commit = useCallback(
    (next: StoredFeedbackDraft): Promise<void> => {
      adopt(next);
      return persist(scope, next);
    },
    [adopt, scope],
  );

  const hydrated = useHydration(scope, adopt);
  const edits = useDraftEdits(draftRef, commit);
  const settleAttempt = useSettleAttempt(scope, draftRef, adopt);
  return { hydrated, draft, ...edits, settleAttempt };
}
