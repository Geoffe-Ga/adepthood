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

import CareSupportNote from './CareSupportNote';
import CompletionSuggestionNote from './CompletionSuggestionNote';
import ContractionReflectionNote from './ContractionReflectionNote';
import EditConfirmDialog from './EditConfirmDialog';
import GetResonanceButton, { shouldShowResonance } from './GetResonanceButton';
import HighlightedBody from './HighlightedBody';
import styles from './JournalEntry.styles';
import MarginNote from './MarginNote';
import { useSettleIn } from './motion';
import PrivacyTierControl, { type PrivacyTier } from './PrivacyTierControl';
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

/** Backend default privacy tier for a fresh entry. */
const DEFAULT_CLASSIFICATION: JournalClassification = 'personal';

/** Fallback reason shown when resonance is gated off for an intimate entry. */
const INTIMATE_RESONANCE_REASON = 'Intimate entries are kept private — resonance is paused.';

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
}

/** Create on first save, then update; title is optional and saved separately. */
async function writeEntry(
  refs: WriteEntryRefs,
  title: string,
  body: string,
  ctx: SaveContext,
): Promise<void> {
  const { entryIdRef, respondedRef, classificationRef } = refs;
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
  classification: PrivacyTier;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  /** Set the privacy tier: updates the control and persists (create/PATCH). */
  onChangeClassification: (_tier: PrivacyTier) => void;
  /** Persist the latest text immediately and resolve to the entry id (or null). */
  flush: () => Promise<number | null>;
}

/** Load an existing entry once (by route id) and hand it to ``apply``. */
function useEntryLoadEffect(
  routeEntryId: number | null,
  apply: (_entry: JournalMessage) => void,
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
        // Load failures surface via a toast in the host screen (later issue).
      });
    return () => {
      active = false;
    };
  }, [routeEntryId, apply]);
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
  /** Record the tier for the next create and PATCH it when the entry exists. */
  changeClassification: (_tier: JournalClassification) => void;
}

/**
 * Owns the latest privacy tier: it rides the first ``journal.create`` via the
 * ref, and on an existing entry a change is PATCHed immediately so a
 * re-classification never waits on (or is lost to) the body-save debounce.
 */
function useClassificationPersist(
  entryIdRef: React.MutableRefObject<number | null>,
): ClassificationPersist {
  const classificationRef = useRef<JournalClassification>(DEFAULT_CLASSIFICATION);
  const changeClassification = useCallback(
    (tier: JournalClassification): void => {
      classificationRef.current = tier;
      if (entryIdRef.current != null) {
        void journal.update(entryIdRef.current, { classification: tier });
      }
    },
    [entryIdRef],
  );
  return { classificationRef, changeClassification };
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

/** Debounced create-then-update draft saver; tracks the save state. */
function useDebouncedSave(
  routeEntryId: number | null,
  delayMs: number,
  ctx: SaveContext,
  onSaved?: () => void,
) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const entryIdRef = useRef<number | null>(routeEntryId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A weekly-prompt response is write-once; this guards against the debounce or
  // flush submitting it twice (the backend 409s on a duplicate week).
  const respondedRef = useRef(false);
  const { classificationRef, changeClassification } = useClassificationPersist(entryIdRef);
  // Refs so non-memoised inputs don't churn the save callbacks below.
  const onSavedRef = useRef(onSaved);
  const ctxRef = useRef(ctx);
  useEffect(() => {
    onSavedRef.current = onSaved;
    ctxRef.current = ctx;
  });
  useTimerCleanup(timerRef);

  const run = useCallback<RunSave>(
    async (title, body) => {
      if (!body.trim()) return; // never persist an empty draft
      setSaveState('saving');
      const refs = { entryIdRef, respondedRef, classificationRef };
      try {
        await writeEntry(refs, title, body, ctxRef.current);
        setSaveState('saved');
        onSavedRef.current?.();
      } catch {
        // Surface a distinct error state so the hint isn't mistaken for "untouched".
        setSaveState('error');
      }
    },
    [classificationRef],
  );

  const setTyping = useCallback(() => setSaveState('typing'), []);
  const { save, flush } = useSaveTimer(run, timerRef, entryIdRef, delayMs, setTyping);

  return { saveState, save, flush, changeClassification };
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
  classification: PrivacyTier;
  setClassification: (_tier: PrivacyTier) => void;
  setTitle: (_v: string) => void;
  setBody: (_v: string) => void;
  titleRef: StrRef;
  bodyRef: StrRef;
}

/** The entry's editable state (title/body/status/tier) + one-time load-on-open. */
function useEntryState(routeEntryId: number | null, initialTitle: string): EntryState {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<EntryStatus>('draft');
  const [classification, setClassification] = useState<PrivacyTier>(DEFAULT_CLASSIFICATION);
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
      setClassification(entry.classification ?? DEFAULT_CLASSIFICATION);
    }, []),
  );

  return {
    title,
    body,
    status,
    setStatus,
    classification,
    setClassification,
    setTitle,
    setBody,
    titleRef,
    bodyRef,
  };
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
  const { titleRef, bodyRef, setClassification } = entry;
  const { saveState, save, flush, changeClassification } = useDebouncedSave(
    routeEntryId,
    delayMs,
    ctx,
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
  // Reflect the choice in the control, then persist it (create-time ref or PATCH).
  const onChangeClassification = useCallback(
    (tier: PrivacyTier) => {
      setClassification(tier);
      changeClassification(tier);
    },
    [changeClassification, setClassification],
  );

  return {
    title: entry.title,
    body: entry.body,
    status: entry.status,
    setStatus: entry.setStatus,
    saveState,
    classification: entry.classification,
    onChangeTitle,
    onChangeBody,
    onChangeClassification,
    flush: flushNow,
  };
}

interface WritingColumnProps {
  title: string;
  body: string;
  saveState: SaveState;
  classification: PrivacyTier;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
  onChangeClassification: (_tier: PrivacyTier) => void;
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
  onChangeTitle,
  onChangeBody,
  onChangeClassification,
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
  classification: PrivacyTier;
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
  const { title, body, saveState, classification } = ctl.autosave;
  const { editMode, canFinish, markFinished, requestEdit } = ctl.editGate;
  return editMode ? (
    <WritingColumn
      title={title}
      body={body}
      saveState={saveState}
      classification={classification}
      onChangeTitle={ctl.handleTitle}
      onChangeBody={ctl.handleBody}
      onChangeClassification={ctl.autosave.onChangeClassification}
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
