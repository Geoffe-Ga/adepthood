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

import styles from './JournalEntry.styles';

import { journal } from '@/api';
import type { JournalMessage } from '@/api';
import { colors } from '@/design/tokens';
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

  return { saveState, save };
}

/** Owns the entry's text + debounced draft autosave (create-then-update). */
function useJournalAutosave(routeEntryId: number | null, delayMs: number): AutosaveApi {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // Refs mirror the latest text so the change handlers can stay referentially
  // stable (each save needs the *other* field's current value).
  const titleRef = useRef('');
  const bodyRef = useRef('');
  const { saveState, save } = useDebouncedSave(routeEntryId, delayMs);

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

  return { title, body, saveState, onChangeTitle, onChangeBody };
}

/** The scrollable writing column (title + growing body + save hint). */
function WritingColumn({ title, body, saveState, onChangeTitle, onChangeBody }: AutosaveApi) {
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

function JournalEntryScreen({
  route,
  renderMargin,
  autosaveDelayMs = AUTOSAVE_DELAY_MS,
}: JournalEntryScreenProps): React.JSX.Element {
  const autosave = useJournalAutosave(route.params?.entryId ?? null, autosaveDelayMs);
  const narrow = useWindowDimensions().width < NARROW_BREAKPOINT;
  const isIdle = autosave.saveState !== 'typing' && autosave.saveState !== 'saving';

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.page, narrow && styles.pageNarrow]}>
        <WritingColumn {...autosave} />
        <View
          style={[styles.marginColumn, narrow && styles.marginColumnNarrow]}
          testID="journal-margin-column"
        >
          {renderMargin?.({ body: autosave.body, isIdle })}
        </View>
      </View>
    </SafeAreaView>
  );
}

export default JournalEntryScreen;
