/**
 * ``JournalEntryScreen`` — the long-form page the user writes in.
 *
 * Warm editorial layout: an optional serif title and a large growing serif body
 * on a paper ground, with a reserved right-hand margin column (a pluggable
 * ``renderMargin`` slot the marginalia UI fills in a later issue). The page
 * autosaves as a draft on idle — there is no send button and no chat UI.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import GetResonanceButton, { shouldShowResonance } from './GetResonanceButton';
import HighlightedBody from './HighlightedBody';
import styles from './JournalEntry.styles';
import MarginNote from './MarginNote';
import ResonanceEssayModal from './ResonanceEssayModal';
import { useResonance } from './useResonance';

import { journal } from '@/api';
import type { JournalMessage, Marginalia } from '@/api';
import { colors } from '@/design/tokens';
import { useIdle } from '@/hooks/useIdle';
import type { RootStackParamList } from '@/navigation/RootStack';

/** Default idle delay before an edit is persisted. */
export const AUTOSAVE_DELAY_MS = 1500;

/** Below this width the margin column stacks under the writing column. */
const NARROW_BREAKPOINT = 600;

type SaveState = 'idle' | 'typing' | 'saving' | 'saved' | 'error';

/** Context handed to the pluggable margin slot (and exposed for the Resonance CTA). */
export interface JournalMarginContext {
  body: string;
  isIdle: boolean;
}

export type JournalEntryScreenProps = NativeStackScreenProps<RootStackParamList, 'JournalEntry'> & {
  /** Pluggable right-margin content (margin notes UI lands in a later issue). */
  renderMargin?: (_ctx: JournalMarginContext) => React.ReactNode;
  /** Overridable for tests; defaults to {@link AUTOSAVE_DELAY_MS}. */
  autosaveDelayMs?: number;
};

function savedHintLabel(state: SaveState): string {
  if (state === 'saving') return 'Saving…';
  if (state === 'saved') return 'Saved';
  if (state === 'error') return "Couldn't save — keep writing, we'll retry";
  return ' ';
}

/** Create on first save, then update; title is optional and saved separately. */
async function writeEntry(
  entryIdRef: React.MutableRefObject<number | null>,
  title: string,
  body: string,
): Promise<void> {
  const trimmedTitle = title.trim() ? title : null;
  if (entryIdRef.current == null) {
    const created = await journal.create({ message: body });
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
  saveState: SaveState;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
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

/** Debounced create-then-update draft saver; tracks the save state. */
function useDebouncedSave(routeEntryId: number | null, delayMs: number) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const entryIdRef = useRef<number | null>(routeEntryId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const run = useCallback(async (title: string, body: string): Promise<void> => {
    if (!body.trim()) return; // never persist an empty draft
    setSaveState('saving');
    try {
      await writeEntry(entryIdRef, title, body);
      setSaveState('saved');
    } catch {
      // Surface a distinct error state so the hint isn't mistaken for "untouched".
      setSaveState('error');
    }
  }, []);

  const save = useCallback(
    (title: string, body: string): void => {
      setSaveState('typing');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void run(title, body), delayMs);
    },
    [run, delayMs],
  );

  // Cancel any pending debounce and persist now; resolves to the entry id so a
  // caller (e.g. resonance) can act on the just-saved entry.
  const flush = useCallback(
    async (title: string, body: string): Promise<number | null> => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (body.trim()) await run(title, body);
      return entryIdRef.current;
    },
    [run],
  );

  return { saveState, save, flush };
}

/** Owns the entry's text + debounced draft autosave (create-then-update). */
function useJournalAutosave(routeEntryId: number | null, delayMs: number): AutosaveApi {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // Refs mirror the latest text so the change handlers can stay referentially
  // stable (each save needs the *other* field's current value).
  const titleRef = useRef('');
  const bodyRef = useRef('');
  const { saveState, save, flush } = useDebouncedSave(routeEntryId, delayMs);

  useEntryLoadEffect(
    routeEntryId,
    useCallback((entry: JournalMessage) => {
      titleRef.current = entry.title ?? '';
      bodyRef.current = entry.message;
      setTitle(titleRef.current);
      setBody(bodyRef.current);
    }, []),
  );

  const onChangeTitle = useCallback(
    (next: string) => {
      titleRef.current = next;
      setTitle(next);
      save(next, bodyRef.current);
    },
    [save],
  );
  const onChangeBody = useCallback(
    (next: string) => {
      bodyRef.current = next;
      setBody(next);
      save(titleRef.current, next);
    },
    [save],
  );

  const flushNow = useCallback(() => flush(titleRef.current, bodyRef.current), [flush]);

  return { title, body, saveState, onChangeTitle, onChangeBody, flush: flushNow };
}

interface WritingColumnProps {
  title: string;
  body: string;
  saveState: SaveState;
  onChangeTitle: (_next: string) => void;
  onChangeBody: (_next: string) => void;
}

/** The scrollable writing column (title + growing body + save hint). */
function WritingColumn({
  title,
  body,
  saveState,
  onChangeTitle,
  onChangeBody,
}: WritingColumnProps) {
  return (
    <ScrollView
      style={styles.writingColumn}
      contentContainerStyle={styles.writingColumnContent}
      keyboardShouldPersistTaps="handled"
    >
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
        placeholder="Begin writing…"
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
    </ScrollView>
  );
}

/** Quiet placeholder margin content until the notes UI lands (#617). */
function ResonanceMargin({ count, error }: { count: number; error: string | null }) {
  return (
    <>
      {count > 0 ? (
        <Text style={styles.marginCount} testID="journal-margin-count">
          {count === 1 ? '1 note in the margin' : `${count} notes in the margin`}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.marginError} testID="journal-resonance-error">
          {error}
        </Text>
      ) : null}
    </>
  );
}

/** Read-mode body: the title + the highlighted passage tree (shown once notes exist). */
function ReadColumn({
  title,
  body,
  notes,
  onOpen,
}: {
  title: string;
  body: string;
  notes: Marginalia[];
  onOpen: (_note: Marginalia) => void;
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
    </ScrollView>
  );
}

/** The stack of margin notes, ordered by anchor position. */
function MarginNoteList({
  notes,
  onOpen,
}: {
  notes: Marginalia[];
  onOpen: (_note: Marginalia) => void;
}) {
  const ordered = [...notes].sort((a, b) => a.anchor_start - b.anchor_start);
  return (
    <>
      {ordered.map((note) => (
        <View key={note.id} style={styles.marginNoteSlot}>
          <MarginNote note={note} onOpen={onOpen} />
        </View>
      ))}
    </>
  );
}

/** Compose the autosave + idle + resonance hooks into the screen's view-model. */
function useJournalEntryController(routeEntryId: number | null, autosaveDelayMs: number) {
  const autosave = useJournalAutosave(routeEntryId, autosaveDelayMs);
  const { isIdle, bump } = useIdle();
  const resonance = useResonance({ routeEntryId, flush: autosave.flush });
  const { onChangeTitle, onChangeBody } = autosave;
  const { updateNote } = resonance;
  const [openNote, setOpenNote] = useState<Marginalia | null>(null);
  const onOpenNote = useCallback((note: Marginalia) => setOpenNote(note), []);
  const onCloseNote = useCallback(() => setOpenNote(null), []);
  // Cache the freshly-loaded essay back onto the note (instant re-open) and keep
  // the open modal showing the updated note.
  const onEssayLoaded = useCallback(
    (updated: Marginalia) => {
      updateNote(updated);
      setOpenNote(updated);
    },
    [updateNote],
  );

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
  const hasContent = autosave.body.trim().length > 0;
  const visible = shouldShowResonance({ isIdle, hasContent, isLoading: resonance.loading });

  return {
    autosave,
    resonance,
    isIdle,
    visible,
    handleTitle,
    handleBody,
    onOpenNote,
    openNote,
    onCloseNote,
    onEssayLoaded,
  };
}

type Controller = ReturnType<typeof useJournalEntryController>;

/** The two-column page: the body (edit or read) + the margin. */
function JournalPage({
  ctl,
  renderMargin,
}: {
  ctl: Controller;
  renderMargin?: JournalEntryScreenProps['renderMargin'];
}) {
  const narrow = useWindowDimensions().width < NARROW_BREAKPOINT;
  const { title, body, saveState } = ctl.autosave;
  const notes = ctl.resonance.marginalia;
  const hasNotes = notes.length > 0;

  let marginContent: React.ReactNode;
  if (renderMargin) marginContent = renderMargin({ body, isIdle: ctl.isIdle });
  else if (hasNotes) marginContent = <MarginNoteList notes={notes} onOpen={ctl.onOpenNote} />;
  else marginContent = <ResonanceMargin count={0} error={ctl.resonance.error} />;

  return (
    <View style={[styles.page, narrow && styles.pageNarrow]}>
      {hasNotes ? (
        <ReadColumn title={title} body={body} notes={notes} onOpen={ctl.onOpenNote} />
      ) : (
        <WritingColumn
          title={title}
          body={body}
          saveState={saveState}
          onChangeTitle={ctl.handleTitle}
          onChangeBody={ctl.handleBody}
        />
      )}
      <View
        style={[styles.marginColumn, narrow && styles.marginColumnNarrow]}
        testID="journal-margin-column"
      >
        {marginContent}
      </View>
    </View>
  );
}

function JournalEntryScreen({
  route,
  renderMargin,
  autosaveDelayMs = AUTOSAVE_DELAY_MS,
}: JournalEntryScreenProps): React.JSX.Element {
  const ctl = useJournalEntryController(route.params?.entryId ?? null, autosaveDelayMs);
  return (
    <SafeAreaView style={styles.safeArea}>
      <JournalPage ctl={ctl} renderMargin={renderMargin} />
      <GetResonanceButton
        visible={ctl.visible}
        loading={ctl.resonance.loading}
        onPress={ctl.resonance.requestResonance}
      />
      <ResonanceEssayModal
        note={ctl.openNote}
        onClose={ctl.onCloseNote}
        onEssayLoaded={ctl.onEssayLoaded}
      />
    </SafeAreaView>
  );
}

export default JournalEntryScreen;
