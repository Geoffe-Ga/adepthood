/**
 * The driver behind a multi-page transcription run: the single seam that turns the
 * pure {@link transcriptionRunReducer} state into real {@link journal.transcribePage}
 * calls and back.
 *
 * This hook owns the ONLY call-site of `transcribePage` in the feature, and it
 * starts exactly the pages {@link selectStartable} offers — never more than the
 * concurrency bound at once, and never a page that has already been read. Each
 * launch reads the live {@link CapturePage}'s base64 by id at call time (the run
 * state holds no image), so a retake's fresh bytes are picked up for free.
 *
 * WALLET INTEGRITY: a page is charged at most once per attempt. Three guards make a
 * double-charge structurally impossible: the reducer's `start` is inert off
 * `pending`; `selectStartable` yields only `pending` ids; and a per-`(id, attempt)`
 * launch ledger (a ref) means even a re-entrant effect run cannot fire the same read
 * twice. The only way to re-read a settled page is an explicit `retry`.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject } from 'react';

import { MAX_TRANSCRIBE_IMAGE_BYTES } from './capture/prepareImage';
import type { CapturePage } from './captureSession';
import {
  hasTerminalError,
  isRunComplete,
  mergeBlocks,
  progressLabel,
  selectStartable,
  transcriptionRunReducer,
} from './transcriptionRun';
import type { TranscriptionBlock, TranscriptionRunState } from './transcriptionRun';

import { TranscriptionError, journal } from '@/api';

/** An empty run — the reducer's initial state before any page is seeded. */
const EMPTY_RUN: TranscriptionRunState = { order: [], blocks: {} };

/** A stable empty set so the initial redo-confirm state never re-triggers renders. */
const NO_REDO_CONFIRM: ReadonlySet<string> = new Set();

/** Join a launch-ledger key from an id and its attempt (session ids never contain a pipe). */
function launchKey(id: string, attempt: number): string {
  return `${id}|${attempt}`;
}

/** Add an id to a redo-confirm set, returning a fresh set (or the same if present). */
function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

/** Remove an id from a redo-confirm set, returning a fresh set (or the same if absent). */
function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

/** Coerce any thrown value into a {@link TranscriptionError} so its `kind` is always
 *  readable (the API already throws these; this guards the unforeseen). */
export function asTranscriptionError(err: unknown): TranscriptionError {
  return err instanceof TranscriptionError ? err : new TranscriptionError('unknown', null, err);
}

/** What the screen and its preview need from a live run. */
export interface TranscriptionRunModel {
  blocks: Record<string, TranscriptionBlock>;
  isComplete: boolean;
  hasTerminalError: boolean;
  progress: string;
  mergedText: string;
  editBlock: (_id: string, _text: string) => void;
  retryBlock: (_block: TranscriptionBlock) => void;
  confirmRedo: (_id: string) => void;
  retakeBlock: (_id: string) => void;
  removeBlock: (_id: string) => void;
  isConfirmingRedo: (_id: string) => boolean;
}

/** The session context a run drives against, plus the two page-swapping offramps. */
export interface UseTranscriptionRunArgs {
  /** The session's current pages, authoritative for order and membership. */
  pages: CapturePage[];
  /** True once the writer has tapped Transcribe — the run is inert until then. */
  started: boolean;
  /** Re-pick just this page and substitute it in place (a fresh-id CapturePage). */
  onRetake: (_id: string) => void;
  /** Drop this page from the session entirely, releasing its image. */
  onRemove: (_id: string) => void;
  /** Release this page's transient device files once it has been read (its
   *  in-memory base64 stays for edits and redos). Best-effort and idempotent. */
  onPageTranscribed?: (_id: string) => void;
}

/** Keep the run's membership reconciled to the session's live page list. */
function usePageSync(
  started: boolean,
  pageIdsKey: string,
  pagesRef: MutableRefObject<CapturePage[]>,
  dispatch: Dispatch<Parameters<typeof transcriptionRunReducer>[1]>,
): void {
  useEffect(() => {
    if (!started) return;
    dispatch({ type: 'pagesSynced', orderedIds: pagesRef.current.map((page) => page.id) });
  }, [started, pageIdsKey, pagesRef, dispatch]);
}

/**
 * The inline redo-confirm gate. Redoing a page the writer has hand-edited is a
 * destructive act, so it waits for an explicit confirm; every other retry (a
 * failure, or an untouched redo) is an immediate, explicit re-read.
 */
function useRedoConfirm(dispatch: Dispatch<Parameters<typeof transcriptionRunReducer>[1]>): {
  retryBlock: (_block: TranscriptionBlock) => void;
  confirmRedo: (_id: string) => void;
  isConfirmingRedo: (_id: string) => boolean;
} {
  const [redoConfirm, setRedoConfirm] = useState<ReadonlySet<string>>(NO_REDO_CONFIRM);

  const retryBlock = useCallback(
    (block: TranscriptionBlock): void => {
      if (block.status === 'done' && block.edited) {
        setRedoConfirm((prev) => withId(prev, block.id));
        return;
      }
      setRedoConfirm((prev) => withoutId(prev, block.id));
      dispatch({ type: 'retry', id: block.id });
    },
    [dispatch],
  );

  const confirmRedo = useCallback(
    (id: string): void => {
      setRedoConfirm((prev) => withoutId(prev, id));
      dispatch({ type: 'retry', id });
    },
    [dispatch],
  );

  const isConfirmingRedo = useCallback((id: string): boolean => redoConfirm.has(id), [redoConfirm]);
  return { retryBlock, confirmRedo, isConfirmingRedo };
}

/**
 * Read one page into the run: reject an oversize page on device without spending a
 * call (or the wallet), otherwise transcribe it, record the result, and release its
 * transient files on success (its in-memory base64 stays for edits and redos).
 */
async function transcribePageInto(
  page: CapturePage,
  attempt: number,
  dispatch: Dispatch<Parameters<typeof transcriptionRunReducer>[1]>,
  onTranscribed: ((_id: string) => void) | undefined,
): Promise<void> {
  if (page.byteLength >= MAX_TRANSCRIBE_IMAGE_BYTES) {
    dispatch({ type: 'reject', id: page.id, attempt, error: 'image_too_large' });
    return;
  }
  try {
    const { text } = await journal.transcribePage({
      imageBase64: page.imageBase64,
      mediaType: page.mediaType,
    });
    dispatch({ type: 'resolve', id: page.id, attempt, text });
    onTranscribed?.(page.id);
  } catch (err: unknown) {
    dispatch({ type: 'reject', id: page.id, attempt, error: asTranscriptionError(err).kind });
  }
}

/** Launch the startable pages, staying within the run's concurrency bound. */
function useRunLoop(
  started: boolean,
  runState: TranscriptionRunState,
  transcribeOne: (_id: string, _attempt: number) => Promise<void>,
  launchedRef: MutableRefObject<Set<string>>,
  dispatch: Dispatch<Parameters<typeof transcriptionRunReducer>[1]>,
): void {
  useEffect(() => {
    if (!started) return;
    for (const id of selectStartable(runState)) {
      const block = runState.blocks[id];
      if (!block) continue;
      const key = launchKey(id, block.attempt);
      if (launchedRef.current.has(key)) continue;
      launchedRef.current.add(key);
      dispatch({ type: 'start', id, attempt: block.attempt });
      void transcribeOne(id, block.attempt);
    }
  }, [started, runState, transcribeOne, launchedRef, dispatch]);
}

/**
 * Drive a multi-page transcription run for `pages`, exposing the per-block state,
 * the derived save-gate/progress/merge, and the block-level user gestures.
 */
export function useTranscriptionRun({
  pages,
  started,
  onRetake,
  onRemove,
  onPageTranscribed,
}: UseTranscriptionRunArgs): TranscriptionRunModel {
  const [runState, dispatch] = useReducer(transcriptionRunReducer, EMPTY_RUN);
  const pagesRef = useRef<CapturePage[]>(pages);
  pagesRef.current = pages;
  const launchedRef = useRef<Set<string>>(new Set());
  // Read the latest cleanup callback from a ref so `transcribeOne` stays stable
  // (its identity gates the run loop) regardless of the caller's memoization.
  const onTranscribedRef = useRef(onPageTranscribed);
  onTranscribedRef.current = onPageTranscribed;

  const transcribeOne = useCallback(async (id: string, attempt: number): Promise<void> => {
    const page = pagesRef.current.find((candidate) => candidate.id === id);
    if (!page) return; // The page left the session mid-flight; its reply is inert.
    await transcribePageInto(page, attempt, dispatch, onTranscribedRef.current);
  }, []);

  const pageIdsKey = pages.map((page) => page.id).join('|');
  usePageSync(started, pageIdsKey, pagesRef, dispatch);
  useRunLoop(started, runState, transcribeOne, launchedRef, dispatch);

  const editBlock = useCallback((id: string, text: string): void => {
    dispatch({ type: 'edit', id, text });
  }, []);

  const { retryBlock, confirmRedo, isConfirmingRedo } = useRedoConfirm(dispatch);

  return {
    blocks: runState.blocks,
    isComplete: isRunComplete(runState, pages),
    hasTerminalError: hasTerminalError(runState),
    progress: progressLabel(runState, pages),
    mergedText: mergeBlocks(runState, pages),
    editBlock,
    retryBlock,
    confirmRedo,
    retakeBlock: onRetake,
    removeBlock: onRemove,
    isConfirmingRedo,
  };
}
