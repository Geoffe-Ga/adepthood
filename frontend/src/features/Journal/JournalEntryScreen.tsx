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

import AspectChordControl, { type AspectChordValue } from './AspectChordControl';
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

/** An untagged chord (no primary/secondary Aspect) for a fresh entry. */
const EMPTY_CHORD: AspectChordValue = { primary: null, secondary: null };

/** Fallback reason shown when resonance is gated off for an intimate entry. */
const INTIMATE_RESONANCE_REASON = 'Intimate entries are kept private — resonance is paused.';

/**
 * Shown when an existing entry fails to load. It also promises the entry is
 * untouched — so a failed load must gate autosave off (see ``useDebouncedSave``)
 * or that reassurance becomes a lie.
 */
const LOAD_ERROR_MESSAGE =
  "We couldn't open this entry. Check your connection and try again — your existing writing is safe.";

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

/** Create on first save, then update; title is optional and saved separately. */
async function writeEntry(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<void> {
  const { entryIdRef, respondedRef, classificationRef, chordRef } = refs;
  // Weekly-prompt mode: the respond endpoint persists the entry itself, so we
  // submit exactly once and never pair it with journal.create (no double-create).
  if (ctx.weekNumber != null) {
    if (respondedRef.current) return;
    await prompts.respond(ctx.weekNumber, body);
    respondedRef.current = true;
    return;
  }
  const trimmedTitle = title.trim() ? title : null;
  if (entryIdRef.current == null) {
    // Only attach context keys when present, so a plain entry's payload stays
    // lean rather than carrying explicit nulls. ``classification`` always rides
    // along so the entry's privacy tier is set at birth (defaults to personal).
    const created = await journal.create({
      message: body,
      classification: classificationRef.current,
      primary_aspect: chordRef.current.primary,
      secondary_aspect: chordRef.current.secondary,
      ...(ctx.practiceSessionId != null && { practice_session_id: ctx.practiceSessionId }),
      ...(ctx.userPracticeId != null && { user_practice_id: ctx.userPracticeId }),
    });
    entryIdRef.current = created.id;
    if (trimmedTitle != null) {
      await journal.update(created.id, { title: trimmedTitle, status: 'draft' });
    }
  } else {
    await journal.update(entryIdRef.current, { message: body, title: trimmedTitle });
  }
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
  /** Set when loading an existing entry failed; drives the banner + autosave gate. */
  loadError: string | null;
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
}

/**
 * Owns the latest privacy tier: it rides the first ``journal.create`` via the
 * ref, and on an existing entry a change is PATCHed immediately so a
 * re-classification never waits on (or is lost to) the body-save debounce.
 */
function useClassificationPersist(
  entryIdRef: React.MutableRefObject<number | null>,
): ClassificationPersist {
  const classificationRef = useRef<JournalClassification>(DEFAULT_TIER);
  const changeClassification = useCallback(
    async (tier: JournalClassification): Promise<JournalClassification | null> => {
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
    [entryIdRef],
  );
  return { classificationRef, changeClassification };
}

interface ChordPersist {
  chordRef: React.MutableRefObject<AspectChordValue>;
  /**
   * Record the chord for the next create and PATCH it when the entry exists.
   * Resolves to the chord the UI should revert to when a PATCH fails and no
   * later change has superseded it, else null.
   */
  changeChord: (_next: AspectChordValue) => Promise<AspectChordValue | null>;
}

/**
 * Owns the latest Aspect chord: it rides the first ``journal.create`` via the
 * ref, and on an existing entry a change is PATCHed immediately (both notes,
 * including explicit nulls) so re-tagging never waits on the body-save debounce.
 * A failed PATCH resolves to the prior chord so the control reverts to the
 * truth, mirroring the sibling privacy-tier control's revert-on-failure path.
 */
function useChordPersist(entryIdRef: React.MutableRefObject<number | null>): ChordPersist {
  const chordRef = useRef<AspectChordValue>(EMPTY_CHORD);
  const changeChord = useCallback(
    async (next: AspectChordValue): Promise<AspectChordValue | null> => {
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
    [entryIdRef],
  );
  return { chordRef, changeChord };
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

/** Debounced create-then-update draft saver; tracks the save state. */
function useDebouncedSave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  loadFailed: boolean,
  onSaved?: () => void,
) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const entryIdRef = useRef<number | null>(routeEntryId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A weekly-prompt response is write-once; this guards against the debounce or
  // flush submitting it twice (the backend 409s on a duplicate week).
  const respondedRef = useRef(false);
  const { classificationRef, changeClassification } = useClassificationPersist(entryIdRef);
  const { chordRef, changeChord } = useChordPersist(entryIdRef);
  // Refs so non-memoised inputs don't churn the save callbacks below.
  const onSavedRef = useRef(onSaved);
  const ctxRef = useRef(ctx);
  // A failed load leaves entryIdRef pointing at the real, unloaded entry with a
  // blank body — so any save here would overwrite it. Gate on the latest flag.
  const loadFailedRef = useRef(loadFailed);
  useEffect(() => {
    onSavedRef.current = onSaved;
    ctxRef.current = ctx;
    loadFailedRef.current = loadFailed;
  });
  useTimerCleanup(timerRef);

  const run = useCallback<RunSave>(
    async (title, body) => {
      if (loadFailedRef.current) return; // never overwrite an entry that failed to load
      if (!body.trim()) return; // never persist an empty draft
      setSaveState('saving');
      const refs = { entryIdRef, respondedRef, classificationRef, chordRef };
      try {
        await writeEntry(refs, title, body, ctxRef.current);
        setSaveState('saved');
        onSavedRef.current?.();
      } catch {
        // Surface a distinct error state so the hint isn't mistaken for "untouched".
        setSaveState('error');
      }
    },
    [classificationRef, chordRef],
  );

  const setTyping = useCallback(() => setSaveState('typing'), []);
  const { save, flush } = useSaveTimer(run, timerRef, entryIdRef, delayMs, setTyping);

  // A failed classification/chord PATCH surfaces the same error hint as a body save.
  const persistClassification = useErrorSurfacingPersist(changeClassification, setSaveState);
  const persistChord = useErrorSurfacingPersist(changeChord, setSaveState);

  return {
    saveState,
    save,
    flush,
    changeClassification: persistClassification,
    changeChord: persistChord,
  };
}

type StrRef = React.MutableRefObject<string>;

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
}

/** The entry's editable state (title/body/status/tier) + one-time load-on-open. */
function useEntryState(routeEntryId: number | null, initialTitle: string): EntryState {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<EntryStatus>('draft');
  const [classification, setClassification] = useState<JournalClassification>(DEFAULT_TIER);
  const [chord, setChord] = useState<AspectChordValue>(EMPTY_CHORD);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const { saveState, save, flush, changeClassification, changeChord } = useDebouncedSave(
    routeEntryId,
    delayMs,
    ctx,
    entry.loadError != null,
    onSaved,
  );

  const { onChangeTitle, onChangeBody } = useFieldHandlers(
    titleRef,
    bodyRef,
    save,
    entry.setTitle,
    entry.setBody,
  );
  const flushNow = useCallback(
    () => flush(titleRef.current, bodyRef.current),
    [flush, titleRef, bodyRef],
  );
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
    loadError: entry.loadError,
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
  bodyPlaceholder?: string;
}

/** Quiet control to mark a draft finished. */
function FinishControl({ onFinish }: { onFinish: () => void }) {
  return (
    <Button
      variant="tertiary"
      onPress={onFinish}
      accessibilityLabel="Mark this entry finished"
      testID="journal-finish-button"
      label="Finish"
    />
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
  bodyPlaceholder = 'Begin writing…',
}: WritingColumnProps) {
  return (
    <ScrollView
      style={styles.writingColumn}
      contentContainerStyle={styles.writingColumnContent}
      keyboardShouldPersistTaps="handled"
    >
      <PrivacyTierControl value={classification} onChange={onChangeClassification} />
      <AspectChordControl value={chord} onChange={onChangeChord} />
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
      <Text style={styles.savedHint} testID="journal-save-hint">
        {savedHintLabel(saveState)}
      </Text>
      {onFinish ? <FinishControl onFinish={onFinish} /> : null}
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
  flush: () => Promise<number | null>;
  body: string;
  navigation: ScreenNavigation;
  onConfirmEdit: () => void;
}

/** The deliberate edit gate for finished entries + the draft "Finish" action. */
function useEditGate({ status, setStatus, flush, body, navigation, onConfirmEdit }: EditGateArgs) {
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  const markFinished = useCallback(async () => {
    const id = await flush();
    if (id == null) return;
    await journal.update(id, { status: 'finished' });
    setStatus('finished');
    setEditing(false);
  }, [flush, setStatus]);

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
    flush: autosave.flush,
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
  };
}

type Controller = ReturnType<typeof useJournalEntryController>;

/** The body column: the editable writing surface, or the read-mode highlighted view. */
function PageBodyColumn({ ctl, bodyPlaceholder }: { ctl: Controller; bodyPlaceholder: string }) {
  const { title, body, saveState, classification, chord } = ctl.autosave;
  const { editMode, canFinish, markFinished, requestEdit } = ctl.editGate;
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
      onFinish={canFinish ? markFinished : undefined}
      bodyPlaceholder={bodyPlaceholder}
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
    p.prefillTitle ?? (p.weekNumber != null ? `Week ${p.weekNumber} Reflection` : '');
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
