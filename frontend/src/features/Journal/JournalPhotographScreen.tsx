/**
 * Photograph handwritten journal pages, transcribe them, and save them as one
 * finished entry. The flow auto-launches the photo picker on mount into an ordered,
 * multi-page capture session: the writer collects pages (multi-select), reorders the
 * thumbnail strip, and trims it before proceeding. Proceeding runs a real multi-page
 * transcription — several pages read at once under a small concurrency bound, each
 * landing in its own editable block — which merge, in session order, into one entry
 * the writer can edit before it is saved.
 *
 * Every step is warm and declinable (NORTH-STAR): a refused permission, a cancelled
 * pick, or an unreadable page each lead to a plain, shame-free offramp — a fresh
 * photo, a hand-typed entry, or simply removing the page — never a dead end.
 *
 * WALLET INTEGRITY: transcription is a real-money charge. The run makes a double
 * charge of a completed page structurally impossible (see {@link useTranscriptionRun});
 * the save write reuses a created id across retries so a failed finish never
 * duplicates the entry.
 *
 * PRIVACY: the base64 page images live in the capture session's reducer state only.
 * They are never placed in navigation params or logged, and are released when the
 * session is cleared (on save, on the typed-entry offramp) and on unmount.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';

import { CapturePagesStrip } from './CapturePagesStrip';
import { MAX_PAGES_PER_SESSION, canAddPages, captureSessionReducer } from './captureSession';
import type { CapturePage } from './captureSession';
import styles from './JournalPhotograph.styles';
import { pickJournalPhotos } from './pickJournalPhoto';
import type { MultiPickResult, PickedAsset } from './pickJournalPhoto';
import { saveFinishedEntry } from './saveFinishedEntry';
import { TranscriptionPreview } from './TranscriptionPreview';
import { useTranscriptionRun } from './useTranscriptionRun';
import type { TranscriptionRunModel } from './useTranscriptionRun';

import { Button } from '@/components/Button';
import DatePicker, { toISODate } from '@/components/DatePicker';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { accent } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

// --- Copy (warm, declinable — NORTH-STAR) ---------------------------------

const PERMISSION_DENIED_COPY =
  'Adepthood needs permission to open your photos so it can read a page. You can turn that on in Settings, or come back anytime.';
const OPEN_SETTINGS_LABEL = 'Open Settings';
const CANCEL_LABEL = 'Not now';
const PREPARING_COPY = 'Opening your photos…';
const PICK_FAILED_COPY =
  "We couldn't read that photo. Pick another one and we'll try again — no rush.";
const PICK_ANOTHER_LABEL = 'Pick another photo';
const SAVE_LABEL = 'Save this entry';
const RETRY_SAVE_LABEL = 'Try saving again';
const ENTRY_DATE_LABEL = 'Entry date';
const TYPED_ENTRY_LABEL = 'Type this entry instead';

type PhotographNavigation = NativeStackScreenProps<
  RootStackParamList,
  'JournalPhotograph'
>['navigation'];

/** The screen's mutually-exclusive phases: collect pages, then review the run. */
type Phase =
  | { step: 'preparing' }
  | { step: 'denied' }
  | { step: 'pickFailed' }
  | { step: 'collect' }
  | { step: 'review' };

interface CaptureModel {
  phase: Phase;
  pages: CapturePage[];
  canAdd: boolean;
  entryDate: string;
  saving: boolean;
  saveFailed: boolean;
  onChangeEntryDate: (_date: string) => void;
  runPick: () => void;
  removePage: (_id: string) => void;
  reorderPages: (_pages: CapturePage[]) => void;
  transcribe: () => void;
  save: () => void;
  openSettings: () => void;
  cancel: () => void;
  goTypedEntry: () => void;
  run: TranscriptionRunModel;
}

/** The chosen backdate, or undefined when it is today (the backend then stamps now). */
function entryDateForCreate(entryDate: string): string | undefined {
  return entryDate === toISODate(new Date()) ? undefined : entryDate;
}

/** Give freshly-picked assets stable session ids (a monotonic counter), building
 *  the {@link CapturePage} list appended to the session. */
function toCapturePages(
  assets: readonly PickedAsset[],
  counterRef: React.MutableRefObject<number>,
): CapturePage[] {
  return assets.map((asset) => {
    counterRef.current += 1;
    return {
      id: `page-${counterRef.current}`,
      uri: asset.uri,
      imageBase64: asset.imageBase64,
      mediaType: asset.mediaType,
      status: 'ready',
    };
  });
}

interface PickDeps {
  navigation: PhotographNavigation;
  dispatch: React.Dispatch<Parameters<typeof captureSessionReducer>[1]>;
  pagesRef: React.MutableRefObject<CapturePage[]>;
  counterRef: React.MutableRefObject<number>;
  setPhase: (_phase: Phase) => void;
}

/** Route an initial (empty-session) pick that yielded no pages to its offramp:
 *  a refused permission, a shame-free back-out, or an unreadable pick. */
function applyInitialPickFailure(
  result: Exclude<MultiPickResult, { kind: 'picked' }>,
  navigation: PhotographNavigation,
  setPhase: (_phase: Phase) => void,
): void {
  if (result.kind === 'denied') {
    setPhase({ step: 'denied' });
    return;
  }
  if (result.kind === 'cancelled') {
    navigation.goBack();
    return;
  }
  setPhase({ step: 'pickFailed' });
}

/** Launch the picker for the session's remaining capacity and fold the result in.
 *  The first pick opens the session; later picks are additive — a cancel or a
 *  failed pick with pages already collected simply keeps the session intact. */
function usePickPages({
  navigation,
  dispatch,
  pagesRef,
  counterRef,
  setPhase,
}: PickDeps): () => Promise<void> {
  return useCallback(async () => {
    const hadPages = pagesRef.current.length > 0;
    if (!hadPages) setPhase({ step: 'preparing' });
    const result = await pickJournalPhotos(MAX_PAGES_PER_SESSION - pagesRef.current.length);
    if (result.kind === 'picked') {
      dispatch({ type: 'append', pages: toCapturePages(result.assets, counterRef) });
    } else if (!hadPages) {
      applyInitialPickFailure(result, navigation, setPhase);
      return;
    }
    setPhase({ step: 'collect' });
  }, [navigation, dispatch, pagesRef, counterRef, setPhase]);
}

interface RetakeDeps {
  dispatch: React.Dispatch<Parameters<typeof captureSessionReducer>[1]>;
  pagesRef: React.MutableRefObject<CapturePage[]>;
  counterRef: React.MutableRefObject<number>;
}

/** Re-pick one page and substitute it in place of the failed page with matching id,
 *  keeping its position. A declined retake leaves the page as-is. */
async function retakePageInPlace(
  id: string,
  { dispatch, pagesRef, counterRef }: RetakeDeps,
): Promise<void> {
  const result = await pickJournalPhotos(1);
  if (result.kind !== 'picked') return;
  const [page] = toCapturePages(result.assets, counterRef);
  if (!page) return;
  const next = pagesRef.current.map((existing) => (existing.id === id ? page : existing));
  dispatch({ type: 'reorder', pages: next });
}

/** Re-pick a single page and substitute it in place of a failed one, keeping its
 *  position. The fresh page carries a new id and new bytes; the run reconciles the
 *  swap and reads the new page (never the old one) via the session's page list. */
function useRetakePage({ dispatch, pagesRef, counterRef }: RetakeDeps): (_id: string) => void {
  return useCallback(
    (id: string) => void retakePageInPlace(id, { dispatch, pagesRef, counterRef }),
    [dispatch, pagesRef, counterRef],
  );
}

/** Persist the merged transcript. Reuses ``createdIdRef`` across save retries so a
 *  retry after a failed finish PATCH updates the created entry rather than duplicating it. */
function useSaveEntry(
  navigation: PhotographNavigation,
  mergedText: string,
  entryDate: string,
  releaseSession: () => void,
  createdIdRef: React.MutableRefObject<number | null>,
): { save: () => Promise<void>; saving: boolean; saveFailed: boolean } {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveFailed(false);
    try {
      const id = await saveFinishedEntry(
        mergedText,
        createdIdRef.current,
        (created) => {
          createdIdRef.current = created;
        },
        entryDateForCreate(entryDate),
      );
      releaseSession(); // Release every page image the moment the entry is saved.
      navigation.replace('JournalEntry', { entryId: id, justSaved: true });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [mergedText, entryDate, navigation, releaseSession, createdIdRef]);

  return { save, saving, saveFailed };
}

/** The proceed gesture: arm the run and enter review, but only with a page to read.
 *  `started` stays true thereafter so a mid-run trim back to one page never re-arms. */
function useTranscribeGate(
  pagesRef: React.MutableRefObject<CapturePage[]>,
  setPhase: (_phase: Phase) => void,
): { started: boolean; transcribe: () => void } {
  const [started, setStarted] = useState(false);
  const transcribe = useCallback(() => {
    if (pagesRef.current.length < 1) return;
    setStarted(true);
    setPhase({ step: 'review' });
  }, [pagesRef, setPhase]);
  return { started, transcribe };
}

/** The navigation offramps: open device settings, back out entirely, or step off to
 *  a plain hand-typed entry (which releases the in-memory session on the way out). */
function useNavigationOfframps(
  navigation: PhotographNavigation,
  releaseSession: () => void,
): {
  openSettings: () => void;
  cancel: () => void;
  goTypedEntry: () => void;
} {
  const openSettings = useCallback(() => void Linking.openSettings(), []);
  const cancel = useCallback(() => navigation.goBack(), [navigation]);
  const goTypedEntry = useCallback(() => {
    releaseSession(); // Release every page image when stepping off to a typed entry.
    navigation.navigate('JournalEntry');
  }, [navigation, releaseSession]);
  return { openSettings, cancel, goTypedEntry };
}

/**
 * The capture state machine: collect pages → run the multi-page transcription →
 * review + save. Pages live in a reducer (never in nav params) with a ref mirror so
 * async picks and the run read the current session; the created-entry id lives in a
 * ref so a save retry after a failed finish PATCH reuses it rather than duplicating.
 */
function usePhotographCapture(navigation: PhotographNavigation): CaptureModel {
  const [phase, setPhase] = useState<Phase>({ step: 'preparing' });
  const [pages, dispatch] = useReducer(captureSessionReducer, []);
  const [entryDate, setEntryDate] = useState(() => toISODate(new Date()));
  const createdIdRef = useRef<number | null>(null);
  const counterRef = useRef(0);
  const pagesRef = useRef<CapturePage[]>(pages);
  pagesRef.current = pages;

  const releaseSession = useCallback(() => dispatch({ type: 'clear' }), []);
  const runPick = usePickPages({ navigation, dispatch, pagesRef, counterRef, setPhase });
  const removePage = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const reorderPages = useCallback(
    (next: CapturePage[]) => dispatch({ type: 'reorder', pages: next }),
    [],
  );
  const retakePage = useRetakePage({ dispatch, pagesRef, counterRef });
  const { started, transcribe } = useTranscribeGate(pagesRef, setPhase);

  const run = useTranscriptionRun({ pages, started, onRetake: retakePage, onRemove: removePage });

  const { save, saving, saveFailed } = useSaveEntry(
    navigation,
    run.mergedText,
    entryDate,
    releaseSession,
    createdIdRef,
  );

  const { openSettings, cancel, goTypedEntry } = useNavigationOfframps(navigation, releaseSession);

  useEffect(() => {
    void runPick();
    // The device-local cache files the picker copies are cleaned up by a later
    // epic; the in-memory session is released by React when this screen unmounts.
  }, [runPick]);

  return {
    phase,
    pages,
    canAdd: canAddPages(pages),
    entryDate,
    saving,
    saveFailed,
    onChangeEntryDate: setEntryDate,
    runPick: () => void runPick(),
    removePage,
    reorderPages,
    transcribe,
    save: () => void save(),
    openSettings,
    cancel,
    goTypedEntry,
    run,
  };
}

// --- Views ----------------------------------------------------------------

/** A quiet, centred "we're working" block with a spinner and a caption. */
function WorkingBlock({ testID, caption }: { testID: string; caption: string }): React.JSX.Element {
  return (
    <View testID={testID} style={styles.fillingBlock} accessibilityRole="progressbar">
      <ActivityIndicator size="small" color={accent.primary} />
      <Text style={styles.message}>{caption}</Text>
    </View>
  );
}

/** Permission-refused view: open Settings, or step away without pressure. */
function PermissionDeniedView({
  onOpenSettings,
  onCancel,
}: {
  onOpenSettings: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <View testID="photograph-permission-denied" style={styles.container}>
      <Text style={styles.message}>{PERMISSION_DENIED_COPY}</Text>
      <View style={styles.actions}>
        <Button
          testID="photograph-open-settings"
          label={OPEN_SETTINGS_LABEL}
          accessibilityLabel={OPEN_SETTINGS_LABEL}
          onPress={onOpenSettings}
        />
        <Button
          testID="photograph-cancel"
          variant="tertiary"
          label={CANCEL_LABEL}
          accessibilityLabel={CANCEL_LABEL}
          onPress={onCancel}
        />
      </View>
    </View>
  );
}

/** The pick itself failed (no usable image): only a different photo helps. */
function PickFailedView({ onPickAnother }: { onPickAnother: () => void }): React.JSX.Element {
  return (
    <View testID="photograph-error" style={styles.container}>
      <Text style={styles.message}>{PICK_FAILED_COPY}</Text>
      <Button
        testID="photograph-pick-another"
        label={PICK_ANOTHER_LABEL}
        accessibilityLabel={PICK_ANOTHER_LABEL}
        onPress={onPickAnother}
      />
    </View>
  );
}

/** The date affordance: a quiet label over the shared picker, defaulting to today. */
function EntryDateRow({
  entryDate,
  onChangeEntryDate,
}: {
  entryDate: string;
  onChangeEntryDate: (_date: string) => void;
}): React.JSX.Element {
  return (
    <View testID="capture-entry-date" style={styles.entryDateRow}>
      <Text style={styles.entryDateLabel}>{ENTRY_DATE_LABEL}</Text>
      <DatePicker value={entryDate} maxDate={toISODate(new Date())} onChange={onChangeEntryDate} />
    </View>
  );
}

/** Save, gated on the whole run settling, plus a Retry-save surfaced after a failure. */
function ReviewActions({
  onSave,
  saving,
  saveFailed,
  canSave,
}: {
  onSave: () => void;
  saving: boolean;
  saveFailed: boolean;
  canSave: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      <Button
        testID="photograph-save"
        label={SAVE_LABEL}
        accessibilityLabel={SAVE_LABEL}
        disabled={!canSave}
        busy={saving}
        onPress={onSave}
      />
      {saveFailed ? (
        <Button
          testID="photograph-retry-save"
          variant="secondary"
          label={RETRY_SAVE_LABEL}
          accessibilityLabel={RETRY_SAVE_LABEL}
          busy={saving}
          onPress={onSave}
        />
      ) : null}
    </View>
  );
}

/** The collect stage: the ordered page strip over a quiet, declinable date row. */
function CollectView({ model }: { model: CaptureModel }): React.JSX.Element {
  return (
    <View style={styles.container}>
      <CapturePagesStrip
        pages={model.pages}
        canAdd={model.canAdd}
        onAdd={model.runPick}
        onRemove={model.removePage}
        onReorder={model.reorderPages}
        onTranscribe={model.transcribe}
      />
      <EntryDateRow entryDate={model.entryDate} onChangeEntryDate={model.onChangeEntryDate} />
    </View>
  );
}

/** The review stage: one editable block per page, the run's progress, the date row,
 *  and Save (which waits for every page to settle). A terminal, config-level failure
 *  (the model cannot read images at all) surfaces a hand-typed offramp, since no
 *  amount of retrying can move it forward. */
function ReviewView({ model }: { model: CaptureModel }): React.JSX.Element {
  const { run } = model;
  return (
    <View style={styles.container}>
      <TranscriptionPreview
        pages={model.pages}
        blocks={run.blocks}
        onEdit={run.editBlock}
        onRetry={run.retryBlock}
        onConfirmRedo={run.confirmRedo}
        onRetake={run.retakeBlock}
        onRemove={run.removeBlock}
        isConfirmingRedo={run.isConfirmingRedo}
      />
      <Text testID="photograph-run-progress" style={styles.progress}>
        {run.progress}
      </Text>
      <EntryDateRow entryDate={model.entryDate} onChangeEntryDate={model.onChangeEntryDate} />
      <ReviewActions
        onSave={model.save}
        saving={model.saving}
        saveFailed={model.saveFailed}
        canSave={run.isComplete}
      />
      {run.hasTerminalError ? (
        <Button
          testID="photograph-typed-entry"
          variant="tertiary"
          label={TYPED_ENTRY_LABEL}
          accessibilityLabel={TYPED_ENTRY_LABEL}
          onPress={model.goTypedEntry}
        />
      ) : null}
    </View>
  );
}

/** Route the current phase to its view. */
function CaptureBody({ model }: { model: CaptureModel }): React.JSX.Element {
  switch (model.phase.step) {
    case 'denied':
      return <PermissionDeniedView onOpenSettings={model.openSettings} onCancel={model.cancel} />;
    case 'pickFailed':
      return <PickFailedView onPickAnother={model.runPick} />;
    case 'collect':
      return <CollectView model={model} />;
    case 'review':
      return <ReviewView model={model} />;
    default:
      return <WorkingBlock testID="photograph-preparing" caption={PREPARING_COPY} />;
  }
}

/** The photograph-capture route: pick pages, transcribe them, then save the merge. */
export default function JournalPhotographScreen({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'JournalPhotograph'>): React.JSX.Element {
  const model = usePhotographCapture(navigation);
  return (
    <ScreenScaffold testID="journal-photograph">
      <CaptureBody model={model} />
    </ScreenScaffold>
  );
}
