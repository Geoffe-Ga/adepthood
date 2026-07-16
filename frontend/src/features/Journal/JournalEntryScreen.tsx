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
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AspectChordControl, { EMPTY_CHORD, type AspectChordValue } from './AspectChordControl';
import CareSupportNote from './CareSupportNote';
import CompletionSuggestionNote from './CompletionSuggestionNote';
import ContractionReflectionNote from './ContractionReflectionNote';
import EditConfirmDialog from './EditConfirmDialog';
import GetResonanceButton, { shouldShowResonance } from './GetResonanceButton';
import HighlightedBody from './HighlightedBody';
import { JournalScreenDrawer } from './JournalDrawer';
import styles from './JournalEntry.styles';
import MarginNote from './MarginNote';
import PrivacyTierControl, { DEFAULT_TIER } from './PrivacyTierControl';
import { promptTitleForWeek } from './promptTitle';
import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import ReflectionSourcesPanel from './ReflectionSourcesPanel';
import ResonanceEssayModal from './ResonanceEssayModal';
import { usePromotions } from './usePromotions';
import { useReflectionMode } from './useReflectionMode';
import { useResonance } from './useResonance';

import { journal, prompts, reflections } from '@/api';
import type {
  CheckInResult,
  CompletionSuggestion,
  EntryStatus,
  JournalClassification,
  JournalEntryUpdate,
  JournalMessage,
  Marginalia,
  PromotedQuote,
  ReflectionLevel,
} from '@/api';
import { Button } from '@/components/Button';
import { useScreenDrawer, type ScreenDrawerState } from '@/components/drawer';
import { colors } from '@/design/tokens';
import { useEntrance } from '@/hooks/useEntrance';
import { useIdle } from '@/hooks/useIdle';
import type { RootStackParamList } from '@/navigation/RootStack';

/** Default idle delay before an edit is persisted. */
const AUTOSAVE_DELAY_MS = 1500;

/** Below this width the margin column stacks under the writing column. */
const NARROW_BREAKPOINT = 600;

/** Body-field placeholder for a free-write with no prompt to echo. */
const DEFAULT_BODY_PLACEHOLDER = 'Begin writing…';

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
interface SaveContext {
  weekNumber?: number;
  practiceSessionId?: number;
  userPracticeId?: number;
  /** Reflection scope this page closes (7th-day reflection compose mode). */
  reflectionLevel?: ReflectionLevel;
  /** The scope key the reflection covers (e.g. ``c1:w14``); pairs with ``reflectionLevel``. */
  reflectionScopeKey?: string;
}

/** HTTP status the backend returns when a reflection already exists for the scope. */
const REFLECTION_CONFLICT_STATUS = 409;

/**
 * Warm, declinable hint shown when a folded quote could not be marked included.
 * The quote stays pending and the entry is safe — the writer can simply try
 * again later; there is deliberately no urgency or blame here.
 */
const QUOTE_INCLUSION_HINT =
  "That quote is saved but didn't fold in just yet — no rush, you can add it again anytime.";

/** True for a create rejection that means "this reflection already exists". */
function isCreateConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === REFLECTION_CONFLICT_STATUS
  );
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
    ...(ctx.reflectionLevel != null && { reflection_level: ctx.reflectionLevel }),
    ...(ctx.reflectionScopeKey != null && { reflection_scope_key: ctx.reflectionScopeKey }),
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

interface RefPersist<T> {
  /** The optimistic ref holding the latest value; the create writer rides it. */
  ref: React.MutableRefObject<T>;
  /**
   * Record the value for the next create and PATCH it when the entry exists.
   * Resolves to the value the UI should revert to when a PATCH fails and no
   * later change has superseded it, else null.
   */
  change: (_value: T) => Promise<T | null>;
  /**
   * Seed the last-persisted value from a loaded entry so a failed re-tag reverts
   * to the entry's real value rather than the module default.
   */
  seed: (_value: T) => void;
}

/**
 * Owns the latest value behind a control that persists optimistically: the ref
 * rides the first ``journal.create``, and on an existing entry a change is
 * PATCHed immediately (via ``toPatch``) so re-tagging never waits on (or is lost
 * to) the body-save debounce. A failed PATCH reverts to the prior value so the
 * control shows the truth, unless a rapid later change has already superseded
 * it. Assumes one PATCH in flight at a time; ``previous`` is the optimistic ref,
 * not the last-persisted value. Shared by the privacy-tier and Aspect-chord
 * controls; ``toPatch`` must be referentially stable to keep ``change`` stable.
 */
function useRefPersist<T>(
  entryIdRef: React.MutableRefObject<number | null>,
  entryUnsettledRef: React.MutableRefObject<boolean>,
  initial: T,
  toPatch: (_value: T) => JournalEntryUpdate,
): RefPersist<T> {
  const ref = useRef<T>(initial);
  const change = useCallback(
    async (value: T): Promise<T | null> => {
      // Never PATCH until the entry's load settles (still in flight or failed) —
      // the ref is stale and a write here could overwrite the stored (unseen) value.
      if (entryUnsettledRef.current) return null;
      const previous = ref.current;
      ref.current = value;
      // Create-time: the ref rides the next journal.create, nothing to PATCH yet.
      if (entryIdRef.current == null) return null;
      try {
        await journal.update(entryIdRef.current, toPatch(value));
        return null;
      } catch {
        // A rapid superseding change already owns the ref and the UI — leave both
        // to it rather than reverting to this now-stale value.
        if (ref.current !== value) return null;
        ref.current = previous;
        return previous;
      }
    },
    [entryIdRef, entryUnsettledRef, toPatch],
  );
  const seed = useCallback((value: T): void => {
    ref.current = value;
  }, []);
  return { ref, change, seed };
}

// Module-level so the mappers stay referentially stable across renders, keeping
// each ``useRefPersist`` ``change`` callback's identity stable (as the inlined
// twins were) rather than churning every render.
const classificationToPatch = (tier: JournalClassification): JournalEntryUpdate => ({
  classification: tier,
});
const chordToPatch = (chord: AspectChordValue): JournalEntryUpdate => ({
  primary_aspect: chord.primary,
  secondary_aspect: chord.secondary,
});

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
  onConflict: (() => void) | undefined,
): Promise<void> {
  return (async () => {
    try {
      await writeEntry(refs, title, body, ctx);
      setSaveState('saved');
      onSaved?.();
    } catch (error) {
      // Surface a distinct error state so the hint isn't mistaken for "untouched".
      setSaveState('error');
      // Additive: a reflection-scope create can 409 because the reflection
      // already exists. Hand that case to the caller (which routes to the
      // existing entry); every other failure keeps the plain save-error hint.
      // This never rejects, so the single-flight drain loops stay safe.
      if (isCreateConflict(error)) onConflict?.();
    }
  })();
}

/** The refs the single-flight writer reads: the write payload plus its gates. */
type SaveRunnerRefs = WriteEntryRefs & {
  entryUnsettledRef: React.MutableRefObject<boolean>;
  ctxRef: React.MutableRefObject<SaveContext>;
  onSavedRef: React.MutableRefObject<(() => void) | undefined>;
  /** Additively invoked on a reflection-scope create 409 (routes to the existing entry). */
  onConflictRef: React.MutableRefObject<(() => void) | undefined>;
  inFlightRef: React.MutableRefObject<Promise<void> | null>;
};

/**
 * The debounced writer, single-flighted: if a save is already in flight, this
 * awaits it (letting a pending create set ``entryIdRef``) before starting, so two
 * overlapping saves of an id-less entry never each fire ``journal.create``.
 */
function useSaveRunner(refs: SaveRunnerRefs, setSaveState: (_state: SaveState) => void): RunSave {
  const { entryIdRef, respondedRef, classificationRef, chordRef } = refs;
  const { entryUnsettledRef, ctxRef, onSavedRef, onConflictRef, inFlightRef } = refs;
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
        onConflictRef.current,
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
      onConflictRef,
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
  const {
    ref: classificationRef,
    change: changeClassification,
    seed: seedClassification,
  } = useRefPersist<JournalClassification>(
    entryIdRef,
    entryUnsettledRef,
    DEFAULT_TIER,
    classificationToPatch,
  );
  const {
    ref: chordRef,
    change: changeChord,
    seed: seedChord,
  } = useRefPersist<AspectChordValue>(entryIdRef, entryUnsettledRef, EMPTY_CHORD, chordToPatch);
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

/** The non-memoised inputs the writer reads through refs (kept fresh each render). */
interface MirroredInputs {
  onSaved?: () => void;
  onConflict?: () => void;
  ctx: SaveContext;
  entryUnsettled: boolean;
}

/** Mirror the latest non-memoised writer inputs onto their refs (no callback churn). */
function useMirroredInputs(
  onSavedRef: React.MutableRefObject<(() => void) | undefined>,
  onConflictRef: React.MutableRefObject<(() => void) | undefined>,
  ctxRef: React.MutableRefObject<SaveContext>,
  entryUnsettledRef: React.MutableRefObject<boolean>,
  values: MirroredInputs,
): void {
  useEffect(() => {
    onSavedRef.current = values.onSaved;
    onConflictRef.current = values.onConflict;
    ctxRef.current = values.ctx;
    entryUnsettledRef.current = values.entryUnsettled;
  });
}

/** The stable refs the draft writer reads (created once, mirrored each render). */
interface DraftRefs {
  entryIdRef: React.MutableRefObject<number | null>;
  timerRef: TimerRef;
  inFlightRef: React.MutableRefObject<Promise<void> | null>;
  respondedRef: React.MutableRefObject<boolean>;
  onSavedRef: React.MutableRefObject<(() => void) | undefined>;
  onConflictRef: React.MutableRefObject<(() => void) | undefined>;
  ctxRef: React.MutableRefObject<SaveContext>;
  entryUnsettledRef: React.MutableRefObject<boolean>;
}

/**
 * Create the draft writer's refs and keep the non-memoised ones mirrored.
 *
 * ``entryUnsettledRef`` gates every write: until an existing entry's load
 * settles, ``entryIdRef`` points at the real, unloaded entry with a blank body,
 * so a save (or tier/chord PATCH) would overwrite it. ``respondedRef`` makes a
 * weekly-prompt response write-once, and ``inFlightRef`` single-flights saves so
 * two id-less saves can't each fire ``journal.create``.
 */
function useDraftRefs(routeEntryId: number | null, values: MirroredInputs): DraftRefs {
  const entryIdRef = useRef<number | null>(routeEntryId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const respondedRef = useRef(false);
  const onSavedRef = useRef(values.onSaved);
  const onConflictRef = useRef(values.onConflict);
  const ctxRef = useRef(values.ctx);
  const entryUnsettledRef = useRef(values.entryUnsettled);
  useMirroredInputs(onSavedRef, onConflictRef, ctxRef, entryUnsettledRef, values);
  return {
    entryIdRef,
    timerRef,
    inFlightRef,
    respondedRef,
    onSavedRef,
    onConflictRef,
    ctxRef,
    entryUnsettledRef,
  };
}

/** Debounced create-then-update draft saver; tracks the save state. */
function useDebouncedSave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  entryUnsettled: boolean,
  onSaved?: () => void,
  onConflict?: () => void,
) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const refs = useDraftRefs(routeEntryId, { onSaved, onConflict, ctx, entryUnsettled });
  const persist = usePersistControls(refs.entryIdRef, setSaveState, refs.entryUnsettledRef);
  useTimerCleanup(refs.timerRef);

  const { save, flush, finish } = useDraftWriters(
    { ...refs, classificationRef: persist.classificationRef, chordRef: persist.chordRef },
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
  onConflict?: () => void,
): AutosaveApi {
  const entry = useEntryState(routeEntryId, initialTitle);
  const { titleRef, bodyRef } = entry;
  // An existing entry is "unsettled" until its load settles: entry.loaded flips
  // true only in the success apply, so it stays false through both the in-flight
  // and failed-load windows (and is irrelevant for a new entry — routeEntryId is
  // null). Gate the writer + controls on this so neither touches an unseen entry.
  const entryUnsettled = routeEntryId != null && !entry.loaded;
  const { saveState, save, flush, finish, changeClassification, changeChord, seedPersist } =
    useDebouncedSave(routeEntryId, delayMs, ctx, entryUnsettled, onSaved, onConflict);
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
  bodyPlaceholder: string;
  /**
   * Disables the tier + chord controls until an existing entry's load settles
   * (still in flight or failed), so they never write against an unseen entry.
   */
  controlsDisabled: boolean;
  /** Reflection mode: track the body caret so a folded quote lands at the cursor. */
  onBodySelectionChange?: (_e: SelectionChangeEvent) => void;
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
  onBodySelectionChange,
  bodyPlaceholder,
}: Pick<
  WritingColumnProps,
  'title' | 'body' | 'onChangeTitle' | 'onChangeBody' | 'onBodySelectionChange'
> & {
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
        onSelectionChange={onBodySelectionChange}
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
  bodyPlaceholder,
  controlsDisabled,
  onBodySelectionChange,
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
        onBodySelectionChange={onBodySelectionChange}
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

type SelectionChangeEvent = NativeSyntheticEvent<TextInputSelectionChangeEventData>;

/** The read-mode quote surface: the promoted-quote list plus its UI gestures. */
interface QuotePromotion {
  quotes: PromotedQuote[];
  /** Warm, declinable copy for the latest failed promote/remove; null otherwise. */
  hint: string | null;
  /** True while a promote POST is in flight; drives the in-flight notice + busy control. */
  promoting: boolean;
  /** True briefly after a successful promote; drives the transient success notice. */
  promoted: boolean;
  /** Re-post the last failed span with the same anchors; null unless a promote failed. */
  retryPromote: (() => Promise<void>) | null;
  /** True while the reader is choosing a span in the selection TextInput. */
  selecting: boolean;
  /** The quote whose "Remove promotion" affordance is currently revealed, if any. */
  removeTargetId: number | null;
  startSelecting: () => void;
  cancelSelecting: () => void;
  onSelectionChange: (_span: CodePointSpan) => void;
  confirmSelection: () => Promise<void>;
  onQuotePress: (_quote: PromotedQuote) => void;
  confirmRemove: () => void;
  /** Dismiss the revealed remove card without removing (tap elsewhere in the body). */
  dismissRemove: () => void;
}

/** The gesture slice of {@link QuotePromotion} owned by {@link useQuoteInteraction}. */
type QuoteInteraction = Omit<
  QuotePromotion,
  'quotes' | 'hint' | 'promoting' | 'promoted' | 'retryPromote'
>;

/** The read-mode selection/removal gestures over the {@link usePromotions} state. */
function useQuoteInteraction(
  promote: (_start: number, _end: number) => Promise<void>,
  removePromotion: (_id: number) => Promise<void>,
): QuoteInteraction {
  const [selecting, setSelecting] = useState(false);
  const [removeTargetId, setRemoveTargetId] = useState<number | null>(null);
  // The latest selection, held in a ref so a keystroke-free selection change
  // doesn't re-render the read-only surface until the reader confirms.
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const startSelecting = useCallback(() => {
    setRemoveTargetId(null);
    selectionRef.current = { start: 0, end: 0 };
    setSelecting(true);
  }, []);
  const cancelSelecting = useCallback(() => setSelecting(false), []);
  // The surface converts the native UTF-16 selection to a code-point span; store
  // it verbatim so ``confirmSelection`` posts anchors in the API's code-point unit.
  const onSelectionChange = useCallback((span: CodePointSpan) => {
    selectionRef.current = span;
  }, []);
  // Leave selection mode first so a 422 returns the reader to their place in the
  // read view; ``promote`` never throws (it maps failures to a hint). The surface
  // only enables confirm for a non-empty span, so no empty-span guard is needed.
  const confirmSelection = useCallback(async () => {
    const { start, end } = selectionRef.current;
    setSelecting(false);
    await promote(start, end);
  }, [promote]);
  const onQuotePress = useCallback((quote: PromotedQuote) => setRemoveTargetId(quote.id), []);
  const confirmRemove = useCallback(() => {
    const id = removeTargetId;
    setRemoveTargetId(null);
    if (id != null) void removePromotion(id);
  }, [removeTargetId, removePromotion]);
  const dismissRemove = useCallback(() => setRemoveTargetId(null), []);

  return {
    selecting,
    removeTargetId,
    startSelecting,
    cancelSelecting,
    onSelectionChange,
    confirmSelection,
    onQuotePress,
    confirmRemove,
    dismissRemove,
  };
}

/** Compose the promoted-quote state with its read-mode selection gestures. */
function useQuotePromotion(routeEntryId: number | null): QuotePromotion {
  const { quotes, hint, promote, removePromotion, promoting, promoted, retryPromote } =
    usePromotions({ entryId: routeEntryId ?? 0 });
  const interaction = useQuoteInteraction(promote, removePromotion);
  return { quotes, hint, promoting, promoted, retryPromote, ...interaction };
}

/** Read-mode affordances: the Promote-a-quote action and the Edit link. */
function ReadModeControls({ quote, onEdit }: { quote: QuotePromotion; onEdit: () => void }) {
  return (
    <>
      <Button
        variant="tertiary"
        onPress={quote.startSelecting}
        accessibilityLabel="Promote a quote"
        testID="promote-quote-button"
        label="Promote a quote"
        busy={quote.promoting}
      />
      <TouchableOpacity
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel="Edit this entry"
        testID="journal-edit-button"
      >
        <Text style={styles.controlLink}>Edit</Text>
      </TouchableOpacity>
    </>
  );
}

/** Copy for the promote-lifecycle notices (real ellipsis inside the in-flight line). */
const PROMOTING_COPY = 'Promoting…';
const PROMOTED_COPY = 'Promoted';

/** Transient success confirmation that settles in (motion-safe via useEntrance). */
function PromotedNotice(): React.JSX.Element {
  const settle = useEntrance();
  return (
    <Animated.Text
      style={[styles.promotionSuccess, settle]}
      testID="quote-promotion-success"
      accessibilityRole="text"
    >
      {PROMOTED_COPY}
    </Animated.Text>
  );
}

/** The failed-promote notice: a legible error line plus a same-anchors retry. */
function PromotionErrorNotice({ quote }: { quote: QuotePromotion }): React.JSX.Element {
  const retry = quote.retryPromote;
  return (
    <>
      <Text style={styles.promotionErrorText} testID="quote-promotion-error">
        {quote.hint}
      </Text>
      {retry != null ? (
        <Button
          variant="tertiary"
          label="Try again"
          accessibilityLabel="Try again"
          testID="quote-promotion-retry"
          onPress={() => void retry()}
        />
      ) : null}
    </>
  );
}

/**
 * In-flight / error / success feedback for the promote lifecycle, under the body.
 * An error (``hint``) outranks a lingering success notice so a failed remove that
 * lands while a prior "Promoted" confirmation is still up reads honestly.
 */
function QuotePromotionFeedback({ quote }: { quote: QuotePromotion }): React.JSX.Element | null {
  if (quote.promoting) {
    return (
      <Text style={styles.promotionInflight} testID="quote-promotion-inflight">
        {PROMOTING_COPY}
      </Text>
    );
  }
  if (quote.hint != null) return <PromotionErrorNotice quote={quote} />;
  if (quote.promoted) return <PromotedNotice />;
  return null;
}

/** Read-mode body: the title + the highlighted passage tree + an Edit affordance. */
function ReadColumn({
  title,
  body,
  notes,
  quote,
  onOpen,
  onEdit,
}: {
  title: string;
  body: string;
  notes: Marginalia[];
  quote: QuotePromotion;
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
      {quote.selecting ? (
        <QuoteSelectionSurface
          body={body}
          onSelectionChange={quote.onSelectionChange}
          onConfirm={quote.confirmSelection}
          onCancel={quote.cancelSelecting}
        />
      ) : (
        <>
          <HighlightedBody
            body={body}
            notes={notes}
            onOpen={onOpen}
            quotes={quote.quotes}
            onQuotePress={quote.onQuotePress}
            removeTargetId={quote.removeTargetId}
            onConfirmRemove={quote.confirmRemove}
            onDismissRemove={quote.dismissRemove}
          />
          <QuotePromotionFeedback quote={quote} />
        </>
      )}
      {quote.selecting ? null : <ReadModeControls quote={quote} onEdit={onEdit} />}
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
/**
 * A reflection-scope create can 409 because the reflection already exists.
 * Consult the due window and, when it points at an existing reflection for the
 * same scope, route there instead of leaving a dead-ended save error.
 */
function useCreateConflictHandler(ctx: SaveContext, navigation: ScreenNavigation): () => void {
  return useCallback(() => {
    const scopeKey = ctx.reflectionScopeKey;
    if (scopeKey == null) return;
    void reflections
      .due()
      .then(({ due }) => {
        if (due != null && due.scope_key === scopeKey && due.existing_entry_id != null) {
          navigation.replace('JournalEntry', { entryId: due.existing_entry_id });
        }
      })
      .catch(() => {
        // Fall back to the plain save-error hint; the draft is safe and retryable.
      });
  }, [ctx.reflectionScopeKey, navigation]);
}

/**
 * Wire the reflection composer: mirror the latest body onto a ref so a folded
 * quote can be spliced at the caret without threading the autosave's draft ref
 * out, and hand the sources/insert flow the body writer + flush.
 */
function useReflectionComposer(ctx: SaveContext, autosave: AutosaveApi) {
  const reflectionBodyRef = useRef(autosave.body);
  reflectionBodyRef.current = autosave.body;
  return useReflectionMode({
    reflectionLevel: ctx.reflectionLevel,
    reflectionScopeKey: ctx.reflectionScopeKey,
    bodyRef: reflectionBodyRef,
    onChangeBody: autosave.onChangeBody,
    flush: autosave.flush,
  });
}

/** The finished-entry edit gate wired from the autosave's status + finish write. */
function useEntryEditGate(
  autosave: AutosaveApi,
  navigation: ScreenNavigation,
  onConfirmEdit: () => void,
) {
  return useEditGate({
    status: autosave.status,
    setStatus: autosave.setStatus,
    finish: autosave.finish,
    body: autosave.body,
    navigation,
    onConfirmEdit,
  });
}

function useJournalEntryController(
  routeEntryId: number | null,
  autosaveDelayMs: number,
  navigation: ScreenNavigation,
  ctx: SaveContext,
  initialTitle: string,
) {
  const { refreshRef, handleSaved, onConfirmEdit } = useRefreshAfterEdit();
  const onCreateConflict = useCreateConflictHandler(ctx, navigation);
  const autosave = useJournalAutosave(
    routeEntryId,
    autosaveDelayMs,
    ctx,
    initialTitle,
    handleSaved,
    onCreateConflict,
  );
  const { isIdle, bump } = useIdle();
  const resonance = useResonance({ routeEntryId, flush: autosave.flush });
  const quote = useQuotePromotion(routeEntryId);
  refreshRef.current = resonance.refresh;
  const reflection = useReflectionComposer(ctx, autosave);
  const modal = useEssayModal(resonance.updateNote);
  const editGate = useEntryEditGate(autosave, navigation, onConfirmEdit);
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
    quote,
    reflection,
    ...gate,
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
      onBodySelectionChange={
        ctl.reflection.active ? ctl.reflection.onBodySelectionChange : undefined
      }
    />
  ) : (
    <ReadColumn
      title={title}
      body={body}
      notes={ctl.resonance.marginalia}
      quote={ctl.quote}
      onOpen={ctl.modal.onOpenNote}
      onEdit={requestEdit}
    />
  );
}

function JournalPage({ ctl, bodyPlaceholder }: { ctl: Controller; bodyPlaceholder: string }) {
  const narrow = useWindowDimensions().width < NARROW_BREAKPOINT;
  const settle = useEntrance();
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
      reflectionLevel: p.reflectionLevel,
      reflectionScopeKey: p.reflectionScopeKey,
    },
    initialTitle,
    bodyPlaceholder: p.promptQuestion ?? DEFAULT_BODY_PLACEHOLDER,
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

/**
 * Reflection compose surface: the rereadable sources panel plus a warm hint when
 * a folded quote could not be marked included. Renders nothing outside reflection
 * mode so the plain and weekly-prompt paths are untouched.
 */
function ReflectionComposer({
  reflection,
}: {
  reflection: Controller['reflection'];
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const openSources = useCallback(() => setOpen(true), []);
  const closeSources = useCallback(() => setOpen(false), []);
  if (!reflection.active) return null;
  return (
    <>
      <TouchableOpacity
        style={styles.quoteActionButton}
        onPress={openSources}
        accessibilityRole="button"
        accessibilityLabel="Open the sources to reread earlier writing and gather quotes"
        testID="reflection-sources-toggle"
      >
        <Text style={styles.controlLink}>Sources</Text>
      </TouchableOpacity>
      {open ? (
        <ReflectionSourcesPanel
          items={reflection.sources}
          onInsertQuote={reflection.onInsertQuote}
          onPromoteSpan={reflection.onPromoteSpan}
          onClose={closeSources}
        />
      ) : null}
      {reflection.inclusionHint ? (
        <Text style={styles.savedHint} testID="quote-inclusion-hint">
          {QUOTE_INCLUSION_HINT}
        </Text>
      ) : null}
    </>
  );
}

interface EntryScreenDrawer {
  drawer: ScreenDrawerState;
  onSelectEntry: (_id: number) => void;
  onNewEntry: () => void;
}

/**
 * The header drawer wired for the entry screen. It latches its entry id at mount,
 * so a row tap and New entry must ``push`` a fresh screen (not ``navigate`` in
 * place, which would keep the current, already-loaded entry).
 */
function useEntryScreenDrawer(navigation: ScreenNavigation): EntryScreenDrawer {
  const drawer = useScreenDrawer('Journal');
  const onSelectEntry = useCallback(
    (entryId: number) => {
      navigation.push('JournalEntry', { entryId });
      drawer.close();
    },
    [navigation, drawer],
  );
  const onNewEntry = useCallback(() => {
    navigation.push('JournalEntry');
    drawer.close();
  }, [navigation, drawer]);
  return { drawer, onSelectEntry, onNewEntry };
}

/** The screen's floating layers: the essay modal, the edit-confirm dialog, and
 *  the header drawer — grouped so the screen component stays under the line cap. */
function EntryOverlays({
  modal,
  editGate,
  entryDrawer,
  currentEntryId,
}: {
  modal: Controller['modal'];
  editGate: Controller['editGate'];
  entryDrawer: EntryScreenDrawer;
  currentEntryId: number | null;
}): React.JSX.Element {
  return (
    <>
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
      <JournalScreenDrawer
        drawer={entryDrawer.drawer}
        currentEntryId={currentEntryId}
        onSelectEntry={entryDrawer.onSelectEntry}
        onNewEntry={entryDrawer.onNewEntry}
      />
    </>
  );
}

function JournalEntryScreen({
  route,
  navigation,
  autosaveDelayMs = AUTOSAVE_DELAY_MS,
}: JournalEntryScreenProps): React.JSX.Element {
  const { ctx, initialTitle, bodyPlaceholder } = readEntrypoint(route.params);
  const currentEntryId = route.params?.entryId ?? null;
  const entryDrawer = useEntryScreenDrawer(navigation);
  const ctl = useJournalEntryController(
    currentEntryId,
    autosaveDelayMs,
    navigation,
    ctx,
    initialTitle,
  );
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
      <ReflectionComposer reflection={ctl.reflection} />
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
      <EntryOverlays
        modal={ctl.modal}
        editGate={ctl.editGate}
        entryDrawer={entryDrawer}
        currentEntryId={currentEntryId}
      />
    </SafeAreaView>
  );
}

export default JournalEntryScreen;
