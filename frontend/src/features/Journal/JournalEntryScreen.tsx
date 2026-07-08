/**
 * ``JournalEntryScreen`` — the long-form page the user writes in.
 *
 * Warm editorial layout: an optional serif title and a large growing serif body
 * on a paper ground, with a reserved right-hand margin column that the
 * marginalia UI (``MarginStream``) fills inline. The page autosaves as a draft
 * on idle — there is no send button and no chat UI.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AspectChordControl, { EMPTY_CHORD, type AspectChordValue } from './AspectChordControl';
import CareSupportNote from './CareSupportNote';
import CompletionSuggestionNote from './CompletionSuggestionNote';
import ContractionReflectionNote from './ContractionReflectionNote';
import EditConfirmDialog from './EditConfirmDialog';
import GetResonanceButton, { shouldShowResonance } from './GetResonanceButton';
import HighlightedBody from './HighlightedBody';
import styles from './JournalEntry.styles';
import MarginNote from './MarginNote';
import { useSettleIn } from './motion';
import PrivacyTierControl, { DEFAULT_TIER } from './PrivacyTierControl';
import { promptTitleForWeek } from './promptTitle';
import ResonanceEssayModal from './ResonanceEssayModal';
import { useResonance } from './useResonance';

import { journal, prompts } from '@/api';
import type {
  CheckInResult,
  CompletionSuggestion,
  EntryStatus,
  JournalClassification,
  JournalMessage,
  Marginalia,
} from '@/api';
import { Button } from '@/components/Button';
import { colors } from '@/design/tokens';
import { useIdle } from '@/hooks/useIdle';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { RootStackParamList } from '@/navigation/RootStack';

/** Default idle delay before an edit is persisted. */
export const AUTOSAVE_DELAY_MS = 1500;

/** Below this width the margin column stacks under the writing column. */
const NARROW_BREAKPOINT = 600;

/** Fallback reason shown when resonance is gated off for an intimate entry. */
const INTIMATE_RESONANCE_REASON = 'Intimate entries are kept private — resonance is paused.';

/**
 * Shown when an existing entry fails to load. It also promises the entry is
 * untouched — so a failed load must gate autosave off (see ``useDebouncedSave``)
 * or that reassurance becomes a lie.
 */
const LOAD_ERROR_MESSAGE =
  "We couldn't open this entry. Check your connection and try again — your existing writing is safe.";

/**
 * Shown when the atomic Finish write fails. The Finish write is the only path
 * that flips status, so on failure the entry stays a draft: this reassures the
 * writing is untouched (still in local state, autosave keeps retrying) and asks
 * for a simple retry.
 */
const FINISH_ERROR_MESSAGE =
  "We couldn't finish this entry. Check your connection and tap Finish again — your writing is safe here and still saving.";

type SaveState = 'idle' | 'typing' | 'saving' | 'saved' | 'error';

export type JournalEntryScreenProps = NativeStackScreenProps<RootStackParamList, 'JournalEntry'> & {
  /** Overridable for tests; defaults to {@link AUTOSAVE_DELAY_MS}. */
  autosaveDelayMs?: number;
};

function savedHintLabel(state: SaveState): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'saved') return 'Saved';
  if (state === 'error') return "Couldn't save — keep writing, we'll retry";
  return ' ';
}

/**
 * What context this entry is being written into. A ``weekNumber`` makes it a
 * weekly-prompt response (recorded via the prompt endpoint, which creates the
 * journal entry server-side — so we never also ``journal.create``); the practice
 * ids link a session/stage reflection to its source.
 */
export interface SaveContext {
  weekNumber?: number;
  practiceSessionId?: number;
  userPracticeId?: number;
}

interface WriteEntryRefs {
  entryIdRef: React.MutableRefObject<number | null>;
  respondedRef: React.MutableRefObject<boolean>;
  /** Latest chosen privacy tier; carried on the first ``journal.create``. */
  classificationRef: React.MutableRefObject<JournalClassification>;
  /** Latest chosen Aspect chord; carried on the first ``journal.create``. */
  chordRef: React.MutableRefObject<AspectChordValue>;
}

/**
 * Create the entry with its full body + tags in one call, returning the new
 * server id. Only attaches context keys when present, so a plain entry's payload
 * stays lean rather than carrying explicit nulls. ``classification`` always rides
 * along so the entry's privacy tier is set at birth (defaults to personal).
 */
async function createEntry(refs: WriteEntryRefs, body: string, ctx: SaveContext): Promise<number> {
  const { classificationRef, chordRef } = refs;
  const created = await journal.create({
    message: body,
    classification: classificationRef.current,
    primary_aspect: chordRef.current.primary,
    secondary_aspect: chordRef.current.secondary,
    ...(ctx.practiceSessionId != null && { practice_session_id: ctx.practiceSessionId }),
    ...(ctx.userPracticeId != null && { user_practice_id: ctx.userPracticeId }),
  });
  return created.id;
}

/** A blank title collapses to null so an empty title is stored as absent. */
function titleOrNull(title: string): string | null {
  return title.trim() ? title : null;
}

/** Create on first save, then update; title is optional and saved separately. */
async function writeEntry(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<void> {
  const { entryIdRef, respondedRef } = refs;
  // Weekly-prompt mode: the respond endpoint persists the entry itself, so we
  // submit exactly once and never pair it with journal.create (no double-create).
  if (ctx.weekNumber != null) {
    if (respondedRef.current) return;
    await prompts.respond(ctx.weekNumber, body, titleOrNull(title));
    respondedRef.current = true;
    return;
  }
  const trimmedTitle = titleOrNull(title);
  if (entryIdRef.current == null) {
    entryIdRef.current = await createEntry(refs, body, ctx);
    if (trimmedTitle != null) {
      await journal.update(entryIdRef.current, { title: trimmedTitle, status: 'draft' });
    }
  } else {
    await journal.update(entryIdRef.current, { message: body, title: trimmedTitle });
  }
}

/**
 * The single authoritative Finish write: one atomic update that carries the FULL
 * body + title alongside the ``finished`` status flip, so an earlier, shorter
 * autosave can never win. Rejects on failure (never swallows) so the caller keeps
 * the entry a draft and surfaces a retry. Resolves to the finished entry's id.
 *
 * Weekly-prompt compose has no local id to finish, so the Finish affordance is
 * withheld there and this path handles only plain/practice entries.
 */
async function finishWrite(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<number> {
  const finishTitle = titleOrNull(title);
  const id = refs.entryIdRef.current;
  if (id == null) {
    const created = await createEntry(refs, body, ctx);
    refs.entryIdRef.current = created;
    await journal.update(created, { title: finishTitle, status: 'finished' });
    return created;
  }
  await journal.update(id, { message: body, title: finishTitle, status: 'finished' });
  return id;
}

interface AutosaveApi {
  title: string;
  body: string;
  status: EntryStatus;
  setStatus: (_status: EntryStatus) => void;
  saveState: SaveState;
  /** The entry's privacy tier; drives the control and the resonance gate. */
  classification: JournalClassification;
  /** The entry's Aspect chord; drives the chord control. */
  chord: AspectChordValue;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  /** Set the privacy tier: updates the control and persists (create/PATCH). */
  onChangeClassification: (_tier: JournalClassification) => void;
  /** Set the Aspect chord: updates the control and persists (create/PATCH). */
  onChangeChord: (_next: AspectChordValue) => void;
  /** Persist the latest text immediately and resolve to the entry id (or null). */
  flush: () => Promise<number | null>;
  /**
   * Perform the single atomic Finish write (full body + title + ``finished``
   * status) after draining any in-flight autosave, resolving to the entry id.
   * Rejects on failure so the caller keeps the entry a draft and offers a retry.
   */
  finish: () => Promise<number>;
  /** Set when loading an existing entry failed; drives the banner. */
  loadError: string | null;
  /**
   * True until an existing entry's load settles (still in flight or failed), so
   * the tier + chord controls stay inert until we know the entry's real values.
   */
  controlsLocked: boolean;
}

/** Load an existing entry once (by route id) and hand it to ``apply``. */
function useEntryLoadEffect(
  routeEntryId: number | null,
  apply: (_entry: JournalMessage) => void,
  onError: () => void,
): void {
  useEffect(() => {
    if (routeEntryId == null) return undefined;
    let active = true;
    void journal
      .get(routeEntryId)
      .then((entry) => {
        if (active) apply(entry);
      })
      .catch(() => {
        // A failed load flags the entry as unloaded so autosave is gated off and
        // the screen surfaces a banner; the untouched entry is never overwritten.
        if (active) onError();
      });
    return () => {
      active = false;
    };
  }, [routeEntryId, apply, onError]);
}

/** Clear a pending timeout on unmount. */
function useTimerCleanup(timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [timerRef],
  );
}

interface ClassificationPersist {
  classificationRef: React.MutableRefObject<JournalClassification>;
  /**
   * Record the tier for the next create and PATCH it when the entry exists.
   * Resolves to the tier the UI should revert to when a PATCH fails and no later
   * change has superseded it, else null.
   */
  changeClassification: (_tier: JournalClassification) => Promise<JournalClassification | null>;
  /**
   * Seed the last-persisted tier from a loaded entry so a failed re-tag reverts
   * to the entry's real tier rather than the module default.
   */
  seedClassification: (_tier: JournalClassification) => void;
}

/**
 * Owns the latest privacy tier: it rides the first ``journal.create`` via the
 * ref, and on an existing entry a change is PATCHed immediately so a
 * re-classification never waits on (or is lost to) the body-save debounce.
 */
function useClassificationPersist(
  entryIdRef: React.MutableRefObject<number | null>,
  entryUnsettledRef: React.MutableRefObject<boolean>,
): ClassificationPersist {
  const classificationRef = useRef<JournalClassification>(DEFAULT_TIER);
  const changeClassification = useCallback(
    async (tier: JournalClassification): Promise<JournalClassification | null> => {
      // Never PATCH until the entry's load settles (still in flight or failed) —
      // the ref is stale and a write here could silently downgrade the stored
      // (unseen) privacy tier.
      if (entryUnsettledRef.current) return null;
      const previous = classificationRef.current;
      classificationRef.current = tier;
      // Create-time: the ref rides the next journal.create, nothing to PATCH yet.
      if (entryIdRef.current == null) return null;
      try {
        await journal.update(entryIdRef.current, { classification: tier });
        return null;
      } catch {
        // A rapid superseding change already owns the ref and the UI — leave both
        // to it rather than reverting to this now-stale tier. Assumes one PATCH in
        // flight at a time; ``previous`` is the optimistic ref, not last-persisted.
        if (classificationRef.current !== tier) return null;
        classificationRef.current = previous;
        return previous;
      }
    },
    [entryIdRef, entryUnsettledRef],
  );
  const seedClassification = useCallback((tier: JournalClassification): void => {
    classificationRef.current = tier;
  }, []);
  return { classificationRef, changeClassification, seedClassification };
}

interface ChordPersist {
  chordRef: React.MutableRefObject<AspectChordValue>;
  /**
   * Record the chord for the next create and PATCH it when the entry exists.
   * Resolves to the chord the UI should revert to when a PATCH fails and no
   * later change has superseded it, else null.
   */
  changeChord: (_next: AspectChordValue) => Promise<AspectChordValue | null>;
  /**
   * Seed the last-persisted chord from a loaded entry so a failed re-tag reverts
   * to the entry's real chord rather than the empty default.
   */
  seedChord: (_next: AspectChordValue) => void;
}

/**
 * Owns the latest Aspect chord: it rides the first ``journal.create`` via the
 * ref, and on an existing entry a change is PATCHed immediately (both notes,
 * including explicit nulls) so re-tagging never waits on the body-save debounce.
 * A failed PATCH resolves to the prior chord so the control reverts to the
 * truth, mirroring the sibling privacy-tier control's revert-on-failure path.
 */
function useChordPersist(
  entryIdRef: React.MutableRefObject<number | null>,
  entryUnsettledRef: React.MutableRefObject<boolean>,
): ChordPersist {
  const chordRef = useRef<AspectChordValue>(EMPTY_CHORD);
  const changeChord = useCallback(
    async (next: AspectChordValue): Promise<AspectChordValue | null> => {
      // Never PATCH until the entry's load settles (still in flight or failed) —
      // the ref is stale and a write here could overwrite the stored (unseen) chord.
      if (entryUnsettledRef.current) return null;
      const previous = chordRef.current;
      chordRef.current = next;
      // Create-time: the ref rides the next journal.create, nothing to PATCH yet.
      if (entryIdRef.current == null) return null;
      try {
        await journal.update(entryIdRef.current, {
          primary_aspect: next.primary,
          secondary_aspect: next.secondary,
        });
        return null;
      } catch {
        // A rapid superseding change already owns the ref and the UI — leave both
        // to it rather than reverting to this now-stale chord. Assumes one PATCH in
        // flight at a time; ``previous`` is the optimistic ref, not last-persisted.
        if (chordRef.current !== next) return null;
        chordRef.current = previous;
        return previous;
      }
    },
    [entryIdRef, entryUnsettledRef],
  );
  const seedChord = useCallback((next: AspectChordValue): void => {
    chordRef.current = next;
  }, []);
  return { chordRef, changeChord, seedChord };
}

type TimerRef = React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
type RunSave = (_title: string, _body: string) => Promise<void>;

interface SaveTimer {
  save: (_title: string, _body: string) => void;
  flush: (_title: string, _body: string) => Promise<number | null>;
}

/** Debounce (``save``) + immediate (``flush``) wrappers around the async writer. */
function useSaveTimer(
  run: RunSave,
  timerRef: TimerRef,
  entryIdRef: React.MutableRefObject<number | null>,
  delayMs: number,
  setTyping: () => void,
): SaveTimer {
  const save = useCallback(
    (title: string, body: string): void => {
      setTyping();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void run(title, body), delayMs);
    },
    [run, delayMs, timerRef, setTyping],
  );
  // Cancel any pending debounce and persist now; resolves to the entry id so a
  // caller (e.g. resonance) can act on the just-saved entry.
  const flush = useCallback(
    async (title: string, body: string): Promise<number | null> => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (body.trim()) await run(title, body);
      return entryIdRef.current;
    },
    [run, timerRef, entryIdRef],
  );
  return { save, flush };
}

/**
 * Wrap a revert-on-failure persister so a failed PATCH also surfaces the shared
 * save-error hint (used identically by the privacy-tier and chord controls).
 */
function useErrorSurfacingPersist<T>(
  change: (_value: T) => Promise<T | null>,
  setSaveState: (_state: SaveState) => void,
): (_value: T) => Promise<T | null> {
  return useCallback(
    async (value: T): Promise<T | null> => {
      const revertTo = await change(value);
      if (revertTo != null) setSaveState('error');
      return revertTo;
    },
    [change, setSaveState],
  );
}

/** Persist once, tracking the save state; the returned task never rejects. */
function trackedWrite(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
  setSaveState: (_state: SaveState) => void,
  onSaved: (() => void) | undefined,
): Promise<void> {
  return (async () => {
    try {
      await writeEntry(refs, title, body, ctx);
      setSaveState('saved');
      onSaved?.();
    } catch {
      // Surface a distinct error state so the hint isn't mistaken for "untouched".
      setSaveState('error');
    }
  })();
}

/** The refs the single-flight writer reads: the write payload plus its gates. */
type SaveRunnerRefs = WriteEntryRefs & {
  entryUnsettledRef: React.MutableRefObject<boolean>;
  ctxRef: React.MutableRefObject<SaveContext>;
  onSavedRef: React.MutableRefObject<(() => void) | undefined>;
  inFlightRef: React.MutableRefObject<Promise<void> | null>;
};

/**
 * The debounced writer, single-flighted: if a save is already in flight, this
 * awaits it (letting a pending create set ``entryIdRef``) before starting, so two
 * overlapping saves of an id-less entry never each fire ``journal.create``.
 */
function useSaveRunner(refs: SaveRunnerRefs, setSaveState: (_state: SaveState) => void): RunSave {
  const { entryIdRef, respondedRef, classificationRef, chordRef } = refs;
  const { entryUnsettledRef, ctxRef, onSavedRef, inFlightRef } = refs;
  return useCallback<RunSave>(
    async (title, body) => {
      // Never overwrite an entry until its load settles (still in flight or failed).
      if (entryUnsettledRef.current) return;
      if (!body.trim()) return; // never persist an empty draft
      // Drain every in-flight save before starting: a released run re-registers
      // inFlightRef synchronously, so this serializes the whole pile onto one
      // create. Awaiting only once would let a create that fails release all
      // queued saves together — each re-creating (the duplicate this guards).
      // The tracked task never rejects, so awaiting a pending save never throws.
      while (inFlightRef.current) await inFlightRef.current;
      setSaveState('saving');
      const writeRefs = { entryIdRef, respondedRef, classificationRef, chordRef };
      const task = trackedWrite(
        writeRefs,
        title,
        body,
        ctxRef.current,
        setSaveState,
        onSavedRef.current,
      );
      inFlightRef.current = task;
      try {
        await task;
      } finally {
        if (inFlightRef.current === task) inFlightRef.current = null;
      }
    },
    [
      entryIdRef,
      respondedRef,
      classificationRef,
      chordRef,
      entryUnsettledRef,
      ctxRef,
      onSavedRef,
      inFlightRef,
      setSaveState,
    ],
  );
}

/** The refs the Finish writer reads: the write payload plus its timers + gates. */
type FinishRunnerRefs = WriteEntryRefs & {
  entryUnsettledRef: React.MutableRefObject<boolean>;
  ctxRef: React.MutableRefObject<SaveContext>;
  inFlightRef: React.MutableRefObject<Promise<void> | null>;
  timerRef: TimerRef;
};

/** Raised when Finish is pressed before an existing entry's load has settled. */
const UNSETTLED_FINISH_ERROR = 'Cannot finish an entry that has not finished loading.';

type RunFinish = (_title: string, _body: string) => Promise<number>;

/**
 * The Finish action: cancel any pending debounce, drain in-flight autosaves so a
 * shorter one can't land after us, then issue the single atomic Finish write.
 * Tracks the save state and rethrows on failure so the caller keeps the draft.
 */
function useFinishWriter(
  refs: FinishRunnerRefs,
  setSaveState: (_state: SaveState) => void,
): RunFinish {
  const { entryIdRef, respondedRef, classificationRef, chordRef } = refs;
  const { entryUnsettledRef, ctxRef, inFlightRef, timerRef } = refs;
  return useCallback<RunFinish>(
    async (title, body) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // The tracked autosave never rejects, so draining it is safe; this ensures a
      // slower, shorter autosave can't overwrite the body after the Finish write.
      while (inFlightRef.current) await inFlightRef.current;
      if (entryUnsettledRef.current) throw new Error(UNSETTLED_FINISH_ERROR);
      setSaveState('saving');
      const writeRefs = { entryIdRef, respondedRef, classificationRef, chordRef };
      const task = finishWrite(writeRefs, title, body, ctxRef.current);
      // Register a never-rejecting shadow in the single-flight slot so a keystroke
      // that schedules an autosave mid-finish drains onto us (and sees the id our
      // create set) rather than firing a second journal.create.
      const shadow = task.then(
        () => undefined,
        () => undefined,
      );
      inFlightRef.current = shadow;
      try {
        const id = await task;
        setSaveState('saved');
        return id;
      } catch (error) {
        setSaveState('error');
        throw error;
      } finally {
        if (inFlightRef.current === shadow) inFlightRef.current = null;
      }
    },
    [
      entryIdRef,
      respondedRef,
      classificationRef,
      chordRef,
      entryUnsettledRef,
      ctxRef,
      inFlightRef,
      timerRef,
      setSaveState,
    ],
  );
}

/**
 * Compose the tier + chord persisters: their refs (read by the writer), their
 * seeders (for load), and error-surfacing change wrappers sharing the save hint.
 */
function usePersistControls(
  entryIdRef: React.MutableRefObject<number | null>,
  setSaveState: (_state: SaveState) => void,
  entryUnsettledRef: React.MutableRefObject<boolean>,
) {
  const { classificationRef, changeClassification, seedClassification } = useClassificationPersist(
    entryIdRef,
    entryUnsettledRef,
  );
  const { chordRef, changeChord, seedChord } = useChordPersist(entryIdRef, entryUnsettledRef);
  const seedPersist = useCallback(
    (tier: JournalClassification, chord: AspectChordValue): void => {
      seedClassification(tier);
      seedChord(chord);
    },
    [seedClassification, seedChord],
  );
  return {
    classificationRef,
    chordRef,
    seedPersist,
    persistClassification: useErrorSurfacingPersist(changeClassification, setSaveState),
    persistChord: useErrorSurfacingPersist(changeChord, setSaveState),
  };
}

/** The debounced save + immediate flush + atomic finish, over one shared ref bundle. */
type DraftWriters = SaveTimer & { finish: (_title: string, _body: string) => Promise<number> };

/** Wire the three writers (debounced save, flush, atomic finish) over shared refs. */
function useDraftWriters(
  refs: SaveRunnerRefs & FinishRunnerRefs,
  delayMs: number,
  setSaveState: (_state: SaveState) => void,
): DraftWriters {
  const setTyping = useCallback(() => setSaveState('typing'), [setSaveState]);
  const run = useSaveRunner(refs, setSaveState);
  const { save, flush } = useSaveTimer(run, refs.timerRef, refs.entryIdRef, delayMs, setTyping);
  const finish = useFinishWriter(refs, setSaveState);
  return { save, flush, finish };
}

/** Debounced create-then-update draft saver; tracks the save state. */
function useDebouncedSave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  entryUnsettled: boolean,
  onSaved?: () => void,
) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const entryIdRef = useRef<number | null>(routeEntryId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Single-flight guard: the in-flight save, so overlapping saves of an id-less
  // entry can't each fire journal.create (a duplicate-entry TOCTOU otherwise).
  const inFlightRef = useRef<Promise<void> | null>(null);
  // A weekly-prompt response is write-once; this guards against the debounce or
  // flush submitting it twice (the backend 409s on a duplicate week).
  const respondedRef = useRef(false);
  // Refs so non-memoised inputs don't churn the save callbacks below.
  const onSavedRef = useRef(onSaved);
  const ctxRef = useRef(ctx);
  // Until an existing entry's load settles (still in flight or failed), entryIdRef
  // points at the real, unloaded entry with a blank body — so any save (or
  // tier/chord PATCH) here would overwrite it. Gate on the latest flag; declared
  // before the persisters so they can read it too.
  const entryUnsettledRef = useRef(entryUnsettled);
  const persist = usePersistControls(entryIdRef, setSaveState, entryUnsettledRef);
  useEffect(() => {
    onSavedRef.current = onSaved;
    ctxRef.current = ctx;
    entryUnsettledRef.current = entryUnsettled;
  });
  useTimerCleanup(timerRef);

  const { save, flush, finish } = useDraftWriters(
    {
      entryIdRef,
      respondedRef,
      classificationRef: persist.classificationRef,
      chordRef: persist.chordRef,
      entryUnsettledRef,
      ctxRef,
      onSavedRef,
      inFlightRef,
      timerRef,
    },
    delayMs,
    setSaveState,
  );

  return {
    saveState,
    save,
    flush,
    finish,
    changeClassification: persist.persistClassification,
    changeChord: persist.persistChord,
    seedPersist: persist.seedPersist,
  };
}

type StrRef = React.MutableRefObject<string>;

/** Bind flush + finish to the latest title/body refs so callers pass no args. */
function useBoundWriters(
  flush: (_title: string, _body: string) => Promise<number | null>,
  finish: (_title: string, _body: string) => Promise<number>,
  titleRef: StrRef,
  bodyRef: StrRef,
): { flushNow: () => Promise<number | null>; finishNow: () => Promise<number> } {
  const flushNow = useCallback(
    () => flush(titleRef.current, bodyRef.current),
    [flush, titleRef, bodyRef],
  );
  const finishNow = useCallback(
    () => finish(titleRef.current, bodyRef.current),
    [finish, titleRef, bodyRef],
  );
  return { flushNow, finishNow };
}

/** Referentially-stable change handlers; each save reads the other field's ref. */
function useFieldHandlers(
  titleRef: StrRef,
  bodyRef: StrRef,
  save: (_t: string, _b: string) => void,
  setTitle: (_v: string) => void,
  setBody: (_v: string) => void,
) {
  const onChangeTitle = useCallback(
    (next: string) => {
      titleRef.current = next;
      setTitle(next);
      save(next, bodyRef.current);
    },
    [titleRef, bodyRef, save, setTitle],
  );
  const onChangeBody = useCallback(
    (next: string) => {
      bodyRef.current = next;
      setBody(next);
      save(titleRef.current, next);
    },
    [titleRef, bodyRef, save, setBody],
  );
  return { onChangeTitle, onChangeBody };
}

interface EntryState {
  title: string;
  body: string;
  status: EntryStatus;
  setStatus: (_status: EntryStatus) => void;
  classification: JournalClassification;
  setClassification: (_tier: JournalClassification) => void;
  chord: AspectChordValue;
  setChord: (_next: AspectChordValue) => void;
  setTitle: (_v: string) => void;
  setBody: (_v: string) => void;
  titleRef: StrRef;
  bodyRef: StrRef;
  /** Set (to {@link LOAD_ERROR_MESSAGE}) when loading an existing entry failed. */
  loadError: string | null;
  /** Flips true once an existing entry's values have been applied to state. */
  loaded: boolean;
}

/** The entry's editable state (title/body/status/tier) + one-time load-on-open. */
function useEntryState(routeEntryId: number | null, initialTitle: string): EntryState {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<EntryStatus>('draft');
  const [classification, setClassification] = useState<JournalClassification>(DEFAULT_TIER);
  const [chord, setChord] = useState<AspectChordValue>(EMPTY_CHORD);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Refs mirror the latest text so the change handlers stay referentially stable.
  const titleRef = useRef(initialTitle);
  const bodyRef = useRef('');

  useEntryLoadEffect(
    routeEntryId,
    useCallback((entry: JournalMessage) => {
      titleRef.current = entry.title ?? '';
      bodyRef.current = entry.message;
      setTitle(titleRef.current);
      setBody(bodyRef.current);
      setStatus(entry.status ?? 'draft');
      // Pre-select the server's tier so an intimate entry loads intimate.
      setClassification(entry.classification ?? DEFAULT_TIER);
      // Pre-select the server's chord so a tagged entry loads its Aspects.
      setChord({
        primary: entry.primary_aspect ?? null,
        secondary: entry.secondary_aspect ?? null,
      });
      // Signal the load so the persist refs can be seeded from these values.
      setLoaded(true);
    }, []),
    useCallback(() => setLoadError(LOAD_ERROR_MESSAGE), []),
  );

  return {
    title,
    body,
    status,
    setStatus,
    classification,
    setClassification,
    chord,
    setChord,
    setTitle,
    setBody,
    titleRef,
    bodyRef,
    loadError,
    loaded,
  };
}

interface ChoiceHandlers {
  onChangeClassification: (_tier: JournalClassification) => void;
  onChangeChord: (_next: AspectChordValue) => void;
}

/** Reflect a privacy/chord choice in local state, then persist it (ref or PATCH). */
function useChoiceHandlers(
  entry: EntryState,
  changeClassification: (_tier: JournalClassification) => Promise<JournalClassification | null>,
  changeChord: (_next: AspectChordValue) => Promise<AspectChordValue | null>,
): ChoiceHandlers {
  const { setClassification, setChord } = entry;
  // Reflect the choice optimistically, then persist it (create-time ref or PATCH);
  // a failed PATCH resolves to the prior tier so the control reverts to the truth,
  // unless a later change superseded it (then it resolves null and we keep that).
  const onChangeClassification = useCallback(
    (tier: JournalClassification) => {
      setClassification(tier);
      void changeClassification(tier).then((revertTo) => {
        if (revertTo != null) setClassification(revertTo);
      });
    },
    [changeClassification, setClassification],
  );
  const onChangeChord = useCallback(
    (next: AspectChordValue) => {
      setChord(next);
      void changeChord(next).then((revertTo) => {
        if (revertTo != null) setChord(revertTo);
      });
    },
    [changeChord, setChord],
  );
  return { onChangeClassification, onChangeChord };
}

/**
 * Seed the persist refs from a loaded entry exactly once, so a failed re-tag
 * reverts to the entry's real tier/chord rather than the module default. The
 * guard keeps later optimistic changes (which own the refs themselves) from
 * being clobbered.
 */
function useSeedPersistOnLoad(
  entry: Pick<EntryState, 'loaded' | 'classification' | 'chord'>,
  seedPersist: (_tier: JournalClassification, _chord: AspectChordValue) => void,
): void {
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !entry.loaded) return;
    seededRef.current = true;
    seedPersist(entry.classification, entry.chord);
  }, [entry.loaded, entry.classification, entry.chord, seedPersist]);
}

/** Owns the entry's text + debounced draft autosave (create-then-update). */
function useJournalAutosave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  initialTitle: string,
  onSaved?: () => void,
): AutosaveApi {
  const entry = useEntryState(routeEntryId, initialTitle);
  const { titleRef, bodyRef } = entry;
  // An existing entry is "unsettled" until its load settles: entry.loaded flips
  // true only in the success apply, so it stays false through both the in-flight
  // and failed-load windows (and is irrelevant for a new entry — routeEntryId is
  // null). Gate the writer + controls on this so neither touches an unseen entry.
  const entryUnsettled = routeEntryId != null && !entry.loaded;
  const { saveState, save, flush, finish, changeClassification, changeChord, seedPersist } =
    useDebouncedSave(routeEntryId, delayMs, ctx, entryUnsettled, onSaved);
  useSeedPersistOnLoad(entry, seedPersist);

  const { onChangeTitle, onChangeBody } = useFieldHandlers(
    titleRef,
    bodyRef,
    save,
    entry.setTitle,
    entry.setBody,
  );
  const { flushNow, finishNow } = useBoundWriters(flush, finish, titleRef, bodyRef);
  const { onChangeClassification, onChangeChord } = useChoiceHandlers(
    entry,
    changeClassification,
    changeChord,
  );

  return {
    title: entry.title,
    body: entry.body,
    status: entry.status,
    setStatus: entry.setStatus,
    saveState,
    classification: entry.classification,
    chord: entry.chord,
    onChangeTitle,
    onChangeBody,
    onChangeClassification,
    onChangeChord,
    flush: flushNow,
    finish: finishNow,
    loadError: entry.loadError,
    controlsLocked: entryUnsettled,
  };
}

interface WritingColumnProps {
  title: string;
  body: string;
  saveState: SaveState;
  classification: JournalClassification;
  chord: AspectChordValue;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  onChangeClassification: (_tier: JournalClassification) => void;
  onChangeChord: (_next: AspectChordValue) => void;
  onFinish?: () => void;
  /** True while the Finish write is in flight; drives the busy/disabled control. */
  finishing: boolean;
  /** Set (to {@link FINISH_ERROR_MESSAGE}) when the Finish write failed. */
  finishError: string | null;
  bodyPlaceholder?: string;
  /**
   * Disables the tier + chord controls until an existing entry's load settles
   * (still in flight or failed), so they never write against an unseen entry.
   */
  controlsDisabled: boolean;
}

/** Quiet control to mark a draft finished, with a warm retry notice on failure. */
function FinishControl({
  onFinish,
  finishing,
  finishError,
}: {
  onFinish: () => void;
  finishing: boolean;
  finishError: string | null;
}) {
  return (
    <>
      <Button
        variant="tertiary"
        onPress={onFinish}
        accessibilityLabel="Mark this entry finished"
        testID="journal-finish-button"
        label="Finish"
        busy={finishing}
        disabled={finishing}
      />
      {finishError == null ? null : (
        <Text style={styles.marginError} testID="journal-finish-error">
          {finishError}
        </Text>
      )}
    </>
  );
}

/** The privacy-tier + Aspect-chord choosers, both gated off until load settles. */
function EntryTagControls({
  classification,
  chord,
  onChangeClassification,
  onChangeChord,
  controlsDisabled,
}: Pick<
  WritingColumnProps,
  'classification' | 'chord' | 'onChangeClassification' | 'onChangeChord' | 'controlsDisabled'
>) {
  return (
    <>
      <PrivacyTierControl
        value={classification}
        onChange={onChangeClassification}
        disabled={controlsDisabled}
      />
      <AspectChordControl value={chord} onChange={onChangeChord} disabled={controlsDisabled} />
    </>
  );
}

/** The title + growing body inputs (the raw editable text of the entry). */
function WritingFields({
  title,
  body,
  onChangeTitle,
  onChangeBody,
  bodyPlaceholder,
}: Pick<WritingColumnProps, 'title' | 'body' | 'onChangeTitle' | 'onChangeBody'> & {
  bodyPlaceholder: string;
}) {
  return (
    <>
      <TextInput
        style={styles.titleInput}
        value={title}
        onChangeText={onChangeTitle}
        placeholder="Title"
        placeholderTextColor={colors.paper.inkSoft}
        accessibilityLabel="Entry title"
        testID="journal-title-input"
      />
      <View style={styles.hairline} />
      <TextInput
        style={styles.bodyInput}
        value={body}
        onChangeText={onChangeBody}
        placeholder={bodyPlaceholder}
        placeholderTextColor={colors.paper.inkSoft}
        multiline
        // The outer ScrollView owns scrolling so the field grows freely and long
        // entries stay reachable (iOS multiline TextInput won't scroll its own
        // content inside a flex parent).
        scrollEnabled={false}
        accessibilityLabel="Entry body"
        testID="journal-body-input"
      />
    </>
  );
}

/** The scrollable writing column (title + growing body + save hint). */
function WritingColumn({
  title,
  body,
  saveState,
  classification,
  chord,
  onChangeTitle,
  onChangeBody,
  onChangeClassification,
  onChangeChord,
  onFinish,
  finishing,
  finishError,
  bodyPlaceholder = 'Begin writing…',
  controlsDisabled,
}: WritingColumnProps) {
  return (
    <ScrollView
      style={styles.writingColumn}
      contentContainerStyle={styles.writingColumnContent}
      keyboardShouldPersistTaps="handled"
    >
      <EntryTagControls
        classification={classification}
        chord={chord}
        onChangeClassification={onChangeClassification}
        onChangeChord={onChangeChord}
        controlsDisabled={controlsDisabled}
      />
      <WritingFields
        title={title}
        body={body}
        onChangeTitle={onChangeTitle}
        onChangeBody={onChangeBody}
        bodyPlaceholder={bodyPlaceholder}
      />
      <Text style={styles.savedHint} testID="journal-save-hint">
        {savedHintLabel(saveState)}
      </Text>
      {onFinish ? (
        <FinishControl onFinish={onFinish} finishing={finishing} finishError={finishError} />
      ) : null}
    </ScrollView>
  );
}

/** Margin content for the no-notes case: surfaces a resonance error, if any. */
function ResonanceMargin({ error }: { error: string | null }) {
  return error ? (
    <Text style={styles.marginError} testID="journal-resonance-error">
      {error}
    </Text>
  ) : null;
}

/** Read-mode body: the title + the highlighted passage tree + an Edit affordance. */
function ReadColumn({
  title,
  body,
  notes,
  onOpen,
  onEdit,
}: {
  title: string;
  body: string;
  notes: Marginalia[];
  onOpen: (_note: Marginalia) => void;
  onEdit: () => void;
}) {
  return (
    <ScrollView
      style={styles.writingColumn}
      contentContainerStyle={styles.writingColumnContent}
      keyboardShouldPersistTaps="handled"
    >
      {title ? <Text style={styles.titleInput}>{title}</Text> : null}
      <View style={styles.hairline} />
      <HighlightedBody body={body} notes={notes} onOpen={onOpen} />
      <TouchableOpacity
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel="Edit this entry"
        testID="journal-edit-button"
      >
        <Text style={styles.controlLink}>Edit</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

type MarginItem =
  | { key: string; anchor: number; note: Marginalia }
  | { key: string; anchor: number; suggestion: CompletionSuggestion };

/** Literary notes + actionable suggestions interleaved by anchor position. */
interface MarginStreamProps {
  notes: Marginalia[];
  suggestions: CompletionSuggestion[];
  acceptedCheckIns: Record<number, CheckInResult | null>;
  onOpen: (_note: Marginalia) => void;
  onAccept: (_id: number) => void | Promise<void>;
  onDismiss: (_id: number) => void | Promise<void>;
}

function buildMarginItems(notes: Marginalia[], suggestions: CompletionSuggestion[]): MarginItem[] {
  const items: MarginItem[] = [
    ...notes.map((note) => ({ key: `note-${note.id}`, anchor: note.anchor_start, note })),
    ...suggestions
      .filter((s) => s.status !== 'dismissed')
      .map((s) => ({ key: `suggestion-${s.id}`, anchor: s.anchor_start, suggestion: s })),
  ];
  return items.sort((a, b) => a.anchor - b.anchor);
}

function MarginStream({
  notes,
  suggestions,
  acceptedCheckIns,
  onOpen,
  onAccept,
  onDismiss,
}: MarginStreamProps) {
  return (
    <>
      {buildMarginItems(notes, suggestions).map((item) => (
        <View key={item.key} style={styles.marginNoteSlot}>
          {'note' in item ? (
            <MarginNote note={item.note} onOpen={onOpen} />
          ) : (
            <CompletionSuggestionNote
              suggestion={item.suggestion}
              checkIn={acceptedCheckIns[item.suggestion.id] ?? null}
              onAccept={onAccept}
              onDismiss={onDismiss}
            />
          )}
        </View>
      ))}
    </>
  );
}

type ScreenNavigation = JournalEntryScreenProps['navigation'];

/** The essay-modal open/close state + essay caching. */
function useEssayModal(updateNote: (_note: Marginalia) => void) {
  const [openNote, setOpenNote] = useState<Marginalia | null>(null);
  const onOpenNote = useCallback((note: Marginalia) => setOpenNote(note), []);
  const onCloseNote = useCallback(() => setOpenNote(null), []);
  // Cache the freshly-loaded essay back onto the note and keep the modal current.
  const onEssayLoaded = useCallback(
    (updated: Marginalia) => {
      updateNote(updated);
      setOpenNote(updated);
    },
    [updateNote],
  );
  return { openNote, onOpenNote, onCloseNote, onEssayLoaded };
}

interface EditGateArgs {
  status: EntryStatus;
  setStatus: (_status: EntryStatus) => void;
  finish: () => Promise<number>;
  body: string;
  navigation: ScreenNavigation;
  onConfirmEdit: () => void;
}

/** The deliberate edit gate for finished entries + the draft "Finish" action. */
function useEditGate({ status, setStatus, finish, body, navigation, onConfirmEdit }: EditGateArgs) {
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  // A finished entry is read-only until the user deliberately chooses to edit.
  const editMode = editing || status !== 'finished';

  const requestEdit = useCallback(() => setConfirmOpen(true), []);
  const cancelEdit = useCallback(() => setConfirmOpen(false), []);
  const confirmEdit = useCallback(() => {
    setConfirmOpen(false);
    setEditing(true);
    onConfirmEdit();
  }, [onConfirmEdit]);
  const startNew = useCallback(() => {
    setConfirmOpen(false);
    navigation.push('JournalEntry');
  }, [navigation]);
  // Only flip to finished once the single atomic write resolves; on failure the
  // entry stays a draft (editable) and the error invites a retry.
  const markFinished = useCallback(async () => {
    setFinishError(null);
    setFinishing(true);
    try {
      await finish();
      setStatus('finished');
      setEditing(false);
    } catch {
      setFinishError(FINISH_ERROR_MESSAGE);
    } finally {
      setFinishing(false);
    }
  }, [finish, setStatus]);

  const canFinish = status === 'draft' && body.trim().length > 0;
  return {
    editMode,
    confirmOpen,
    requestEdit,
    cancelEdit,
    confirmEdit,
    startNew,
    markFinished,
    canFinish,
    finishing,
    finishError,
  };
}

/** Wrap the autosave change handlers so each keystroke also bumps the idle timer. */
function useBumpedHandlers(bump: () => void, autosave: AutosaveApi) {
  const { onChangeTitle, onChangeBody } = autosave;
  const handleTitle = useCallback(
    (t: string) => {
      bump();
      onChangeTitle(t);
    },
    [bump, onChangeTitle],
  );
  const handleBody = useCallback(
    (t: string) => {
      bump();
      onChangeBody(t);
    },
    [bump, onChangeBody],
  );
  return { handleTitle, handleBody };
}

interface ResonanceGate {
  /** Whether the resonance affordance is shown at all (hidden in prompt-compose). */
  visible: boolean;
  /** Shown-but-disabled: an intimate entry is never sent to AI. */
  resonanceDisabled: boolean;
  /** One-line reason accompanying a disabled/withheld resonance affordance. */
  resonanceReason: string;
}

interface ResonanceGateArgs {
  isIdle: boolean;
  isLoading: boolean;
  body: string;
  classification: JournalClassification;
  isPromptCompose: boolean;
  privateMessage: string | null;
}

/** Derive whether/how the resonance affordance shows, incl. the intimate gate. */
function deriveResonanceGate(args: ResonanceGateArgs): ResonanceGate {
  const hasContent = args.body.trim().length > 0;
  // In weekly-prompt compose mode the entry is created by prompts.respond, which
  // doesn't return a local id — so resonance can't run here. Hide the button; the
  // reflection gains resonance normally once reopened from the shelf (with an id).
  const visible =
    !args.isPromptCompose &&
    shouldShowResonance({ isIdle: args.isIdle, hasContent, isLoading: args.isLoading });
  return {
    visible,
    // Client-side privacy gate: an intimate entry is never sent to AI, so the
    // resonance affordance is shown-but-disabled with a visible reason.
    resonanceDisabled: args.classification === 'intimate',
    resonanceReason: args.privateMessage ?? INTIMATE_RESONANCE_REASON,
  };
}

interface RefreshAfterEdit {
  refreshRef: React.MutableRefObject<() => Promise<void>>;
  /** Fires the deferred marginalia refresh after the first post-edit save. */
  handleSaved: () => void;
  /** Arms the deferred refresh when the user confirms an edit of a finished entry. */
  onConfirmEdit: () => void;
}

/**
 * A finished entry's notes re-anchor/stale on the first save after an edit, so
 * the refresh is deferred: ``onConfirmEdit`` arms it and the next ``handleSaved``
 * fires it once (via ``refreshRef``, wired to resonance.refresh by the caller).
 */
function useRefreshAfterEdit(): RefreshAfterEdit {
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const pendingRefreshRef = useRef(false);
  const handleSaved = useCallback(() => {
    if (!pendingRefreshRef.current) return;
    pendingRefreshRef.current = false;
    void refreshRef.current();
  }, []);
  const onConfirmEdit = useCallback(() => {
    pendingRefreshRef.current = true;
  }, []);
  return { refreshRef, handleSaved, onConfirmEdit };
}

/** Compose the autosave + idle + resonance hooks into the screen's view-model. */
function useJournalEntryController(
  routeEntryId: number | null,
  autosaveDelayMs: number,
  navigation: ScreenNavigation,
  ctx: SaveContext,
  initialTitle: string,
) {
  const { refreshRef, handleSaved, onConfirmEdit } = useRefreshAfterEdit();

  const autosave = useJournalAutosave(
    routeEntryId,
    autosaveDelayMs,
    ctx,
    initialTitle,
    handleSaved,
  );
  const { isIdle, bump } = useIdle();
  const resonance = useResonance({ routeEntryId, flush: autosave.flush });
  refreshRef.current = resonance.refresh;

  const modal = useEssayModal(resonance.updateNote);
  const editGate = useEditGate({
    status: autosave.status,
    setStatus: autosave.setStatus,
    finish: autosave.finish,
    body: autosave.body,
    navigation,
    onConfirmEdit,
  });

  const { handleTitle, handleBody } = useBumpedHandlers(bump, autosave);
  const gate = deriveResonanceGate({
    isIdle,
    isLoading: resonance.loading,
    body: autosave.body,
    classification: autosave.classification,
    isPromptCompose: ctx.weekNumber != null,
    privateMessage: resonance.privateMessage,
  });

  return {
    autosave,
    resonance,
    isIdle,
    visible: gate.visible,
    resonanceDisabled: gate.resonanceDisabled,
    resonanceReason: gate.resonanceReason,
    handleTitle,
    handleBody,
    modal,
    editGate,
    // Weekly-prompt compose withholds Finish (no local id); title stays editable.
    isPromptCompose: ctx.weekNumber != null,
  };
}

type Controller = ReturnType<typeof useJournalEntryController>;

/** The body column: the editable writing surface, or the read-mode highlighted view. */
function PageBodyColumn({ ctl, bodyPlaceholder }: { ctl: Controller; bodyPlaceholder: string }) {
  const { title, body, saveState, classification, chord } = ctl.autosave;
  const { editMode, canFinish, markFinished, requestEdit } = ctl.editGate;
  const { finishing, finishError } = ctl.editGate;
  // Until an existing entry's load settles (still in flight or failed) the
  // controls are bound to an unseen entry, so disable them.
  const controlsDisabled = ctl.autosave.controlsLocked;
  // Withhold Finish in weekly-prompt compose: the respond endpoint has no local
  // id to finish, so the affordance would be a dead end.
  const canOfferFinish = canFinish && !ctl.isPromptCompose;
  return editMode ? (
    <WritingColumn
      title={title}
      body={body}
      saveState={saveState}
      classification={classification}
      chord={chord}
      onChangeTitle={ctl.handleTitle}
      onChangeBody={ctl.handleBody}
      onChangeClassification={ctl.autosave.onChangeClassification}
      onChangeChord={ctl.autosave.onChangeChord}
      onFinish={canOfferFinish ? markFinished : undefined}
      finishing={finishing}
      finishError={finishError}
      bodyPlaceholder={bodyPlaceholder}
      controlsDisabled={controlsDisabled}
    />
  ) : (
    <ReadColumn
      title={title}
      body={body}
      notes={ctl.resonance.marginalia}
      onOpen={ctl.modal.onOpenNote}
      onEdit={requestEdit}
    />
  );
}

function JournalPage({ ctl, bodyPlaceholder }: { ctl: Controller; bodyPlaceholder: string }) {
  const narrow = useWindowDimensions().width < NARROW_BREAKPOINT;
  const settle = useSettleIn(useReducedMotion());
  const notes = ctl.resonance.marginalia;
  const suggestions = ctl.resonance.suggestions;
  const hasVisibleSuggestions = suggestions.some((s) => s.status !== 'dismissed');

  let marginContent: React.ReactNode;
  if (notes.length > 0 || hasVisibleSuggestions) {
    marginContent = (
      <MarginStream
        notes={notes}
        suggestions={suggestions}
        acceptedCheckIns={ctl.resonance.acceptedCheckIns}
        onOpen={ctl.modal.onOpenNote}
        onAccept={ctl.resonance.acceptSuggestion}
        onDismiss={ctl.resonance.dismissSuggestion}
      />
    );
  } else marginContent = <ResonanceMargin error={ctl.resonance.error} />;

  return (
    <View style={styles.desk}>
      <Animated.View
        style={[styles.sheet, narrow && styles.sheetNarrow, settle]}
        testID="journal-sheet"
      >
        <View style={[styles.page, narrow && styles.pageNarrow]} testID="journal-page">
          <PageBodyColumn ctl={ctl} bodyPlaceholder={bodyPlaceholder} />
          <View
            style={[styles.marginColumn, narrow && styles.marginColumnNarrow]}
            testID="journal-margin-column"
          >
            {marginContent}
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

interface EntryEntrypoint {
  ctx: SaveContext;
  initialTitle: string;
  bodyPlaceholder: string;
}

/** Translate the route params into the save context + pre-filled title/placeholder. */
function readEntrypoint(params: RootStackParamList['JournalEntry']): EntryEntrypoint {
  const p = params ?? {};
  const initialTitle =
    p.prefillTitle ?? (p.weekNumber != null ? promptTitleForWeek(p.weekNumber) : '');
  return {
    ctx: {
      weekNumber: p.weekNumber,
      practiceSessionId: p.practiceSessionId,
      userPracticeId: p.userPracticeId,
    },
    initialTitle,
    bodyPlaceholder: p.promptQuestion ?? 'Begin writing…',
  };
}

/**
 * The one-line reason shown when resonance is gated off for an intimate entry.
 * A sibling above the floating button so it reads as the button's own caption.
 */
function PrivacyResonanceReason({
  visible,
  reason,
}: {
  visible: boolean;
  reason: string;
}): React.JSX.Element | null {
  if (!visible) return null;
  return (
    <Text style={styles.privacyResonanceReason} testID="privacy-resonance-reason">
      {reason}
    </Text>
  );
}

/**
 * Warm inline notice shown when an existing entry fails to load. A sibling above
 * the page (never a margin note) so it reads as the page's own — and its promise
 * that writing is safe is kept true by the autosave gate in ``useDebouncedSave``.
 */
function LoadErrorBanner({ message }: { message: string | null }): React.JSX.Element | null {
  if (message == null) return null;
  return (
    <View style={styles.loadErrorBanner}>
      <Text style={styles.loadErrorText} testID="journal-load-error">
        {message}
      </Text>
    </View>
  );
}

function JournalEntryScreen({
  route,
  navigation,
  autosaveDelayMs = AUTOSAVE_DELAY_MS,
}: JournalEntryScreenProps): React.JSX.Element {
  const { ctx, initialTitle, bodyPlaceholder } = readEntrypoint(route.params);
  const ctl = useJournalEntryController(
    route.params?.entryId ?? null,
    autosaveDelayMs,
    navigation,
    ctx,
    initialTitle,
  );
  const { editGate, modal } = ctl;
  return (
    <SafeAreaView style={styles.safeArea} testID="journal-screen">
      {/* Screen-level care surface (NORTH-STAR §10): a sibling ABOVE the page,
          never nested in the margin column — so on an acute-distress signal the
          human + professional support reads as the page's own, not a margin note. */}
      <CareSupportNote care={ctl.resonance.care} />
      {/* Foundation reflection: a warm, declinable "tend your foundation"
          sibling rendered AFTER the care surface so an acute-distress signal
          always reads first. Hidden (renders nothing) on healthy passes. */}
      <ContractionReflectionNote contraction={ctl.resonance.contraction} />
      <LoadErrorBanner message={ctl.autosave.loadError} />
      <JournalPage ctl={ctl} bodyPlaceholder={bodyPlaceholder} />
      <PrivacyResonanceReason
        visible={ctl.visible && ctl.resonanceDisabled}
        reason={ctl.resonanceReason}
      />
      <GetResonanceButton
        visible={ctl.visible}
        loading={ctl.resonance.loading}
        disabled={ctl.resonanceDisabled}
        onPress={ctl.resonance.requestResonance}
      />
      <ResonanceEssayModal
        note={modal.openNote}
        onClose={modal.onCloseNote}
        onEssayLoaded={modal.onEssayLoaded}
      />
      <EditConfirmDialog
        visible={editGate.confirmOpen}
        onEdit={editGate.confirmEdit}
        onStartNew={editGate.startNew}
        onCancel={editGate.cancelEdit}
      />
    </SafeAreaView>
  );
}

export default JournalEntryScreen;
