/**
 * Photograph handwritten journal pages, transcribe them, and save them as one
 * finished entry. The flow auto-launches the photo picker on mount into an ordered,
 * multi-page capture session: the writer collects pages from the library
 * (multi-select) or photographs them one at a time with the camera — a take-another
 * loop keeps the session growing — then reorders the thumbnail strip and trims it
 * before proceeding. Proceeding runs a real multi-page transcription — several pages
 * read at once under a small concurrency bound, each landing in its own editable
 * block — which merge, in session order, into one entry the writer can edit before
 * it is saved.
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
import { captureJournalPhoto, pickJournalPhotos } from './pickJournalPhoto';
import type { CaptureResult, MultiPickResult, PickedAsset } from './pickJournalPhoto';
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
const CAMERA_DENIED_COPY =
  'Adepthood needs the camera to photograph a page. You can turn that on in Settings, add a photo from your library instead, or come back anytime.';
const ADD_FROM_LIBRARY_LABEL = 'Add from your library';
const TAKE_ANOTHER_COPY = "That page is in. Take another whenever you're ready.";
const TAKE_ANOTHER_LABEL = 'Take another';
const DONE_CAPTURING_LABEL = 'Done';
const SAVE_LABEL = 'Save this entry';
const RETRY_SAVE_LABEL = 'Try saving again';
const ENTRY_DATE_LABEL = 'Entry date';
const TYPED_ENTRY_LABEL = 'Type this entry instead';

type PhotographNavigation = NativeStackScreenProps<
  RootStackParamList,
  'JournalPhotograph'
>['navigation'];

/** The screen's mutually-exclusive phases: collect pages (from the library or the
 *  camera's take-another loop), then review the multi-page run. */
type Phase =
  | { step: 'preparing' }
  | { step: 'denied' }
  | { step: 'cameraDenied' }
  | { step: 'pickFailed' }
  | { step: 'collect' }
  | { step: 'takeAnother' }
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
  takePhoto: () => void;
  finishCapturing: () => void;
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

/** What a camera capture needs: the session reducer, the id counter, and the phase. */
interface CaptureDeps {
  dispatch: React.Dispatch<Parameters<typeof captureSessionReducer>[1]>;
  counterRef: React.MutableRefObject<number>;
  setPhase: (_phase: Phase) => void;
}

/** Fold one camera outcome into the session: a captured page appends and invites
 *  another; a refusal gets its recovery view; a back-out returns to collect with
 *  the session untouched; an unusable capture reuses the pick-failed offramp. */
function applyCaptureResult(result: CaptureResult, deps: CaptureDeps): void {
  const { dispatch, counterRef, setPhase } = deps;
  if (result.kind === 'captured') {
    dispatch({ type: 'append', pages: toCapturePages([result.asset], counterRef) });
    setPhase({ step: 'takeAnother' });
    return;
  }
  if (result.kind === 'denied') {
    setPhase({ step: 'cameraDenied' });
    return;
  }
  if (result.kind === 'cancelled') {
    setPhase({ step: 'collect' });
    return;
  }
  // An unusable capture reuses the pick-failed offramp; its "Pick another photo"
  // retry deliberately switches modality to the library picker, not the camera.
  setPhase({ step: 'pickFailed' });
}

/** Launch the camera for one page and fold the outcome into the session. */
function useCameraCapture(deps: CaptureDeps): () => Promise<void> {
  const { dispatch, counterRef, setPhase } = deps;
  return useCallback(async () => {
    applyCaptureResult(await captureJournalPhoto(), { dispatch, counterRef, setPhase });
  }, [dispatch, counterRef, setPhase]);
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
 *  `started` stays true through a mid-run trim back to one page so a partial removal
 *  never re-arms — but `disarm` returns it to the pre-transcribe state when the whole
 *  session is emptied, so a return to collect re-syncs cleanly and re-entry starts fresh. */
function useTranscribeGate(
  pagesRef: React.MutableRefObject<CapturePage[]>,
  setPhase: (_phase: Phase) => void,
): { started: boolean; transcribe: () => void; disarm: () => void } {
  const [started, setStarted] = useState(false);
  const transcribe = useCallback(() => {
    if (pagesRef.current.length < 1) return;
    setStarted(true);
    setPhase({ step: 'review' });
  }, [pagesRef, setPhase]);
  const disarm = useCallback(() => setStarted(false), []);
  return { started, transcribe, disarm };
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
  const cancel = useCallback(() => {
    releaseSession(); // Release every page image when backing out of the flow.
    navigation.goBack();
  }, [navigation, releaseSession]);
  const goTypedEntry = useCallback(() => {
    releaseSession(); // Release every page image when stepping off to a typed entry.
    navigation.navigate('JournalEntry');
  }, [navigation, releaseSession]);
  return { openSettings, cancel, goTypedEntry };
}

/**
 * Never a dead end (NORTH-STAR): if the writer removes every page mid-review, fall
 * back to the disarmed collect stage rather than leaving them at a permanently
 * disabled Save — they can add pages again or leave cleanly from there.
 */
function useEmptyReviewGuard(
  phaseStep: Phase['step'],
  pageCount: number,
  disarm: () => void,
  setPhase: (_phase: Phase) => void,
): void {
  useEffect(() => {
    if (phaseStep === 'review' && pageCount === 0) {
      disarm();
      setPhase({ step: 'collect' });
    }
  }, [phaseStep, pageCount, disarm, setPhase]);
}

/** The two in-place session edits that both the collect strip and the run trigger:
 *  removing a page by id and committing a drag reorder. */
function useSessionEdits(dispatch: React.Dispatch<Parameters<typeof captureSessionReducer>[1]>): {
  removePage: (_id: string) => void;
  reorderPages: (_pages: CapturePage[]) => void;
} {
  const removePage = useCallback((id: string) => dispatch({ type: 'remove', id }), [dispatch]);
  const reorderPages = useCallback(
    (next: CapturePage[]) => dispatch({ type: 'reorder', pages: next }),
    [dispatch],
  );
  return { removePage, reorderPages };
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
  const runCapture = useCameraCapture({ dispatch, counterRef, setPhase });
  const { removePage, reorderPages } = useSessionEdits(dispatch);
  const retakePage = useRetakePage({ dispatch, pagesRef, counterRef });
  const { started, transcribe, disarm } = useTranscribeGate(pagesRef, setPhase);
  useEmptyReviewGuard(phase.step, pages.length, disarm, setPhase);

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
    // Camera captures follow the same transient-memory rules, and their device
    // cache cleanup is likewise a later epic's scope.
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
    takePhoto: () => void runCapture(),
    finishCapturing: () => setPhase({ step: 'collect' }),
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

/** Camera permission refused: open Settings, fall back to the library, or simply
 *  return to the session already in hand — never a dead end. */
function CameraDeniedView({
  onOpenSettings,
  onAddFromLibrary,
  onNotNow,
}: {
  onOpenSettings: () => void;
  onAddFromLibrary: () => void;
  onNotNow: () => void;
}): React.JSX.Element {
  return (
    <View testID="camera-denied" style={styles.container}>
      <Text style={styles.message}>{CAMERA_DENIED_COPY}</Text>
      <View style={styles.actions}>
        <Button
          testID="camera-open-settings"
          label={OPEN_SETTINGS_LABEL}
          accessibilityLabel={OPEN_SETTINGS_LABEL}
          onPress={onOpenSettings}
        />
        <Button
          testID="camera-add-from-library"
          variant="secondary"
          label={ADD_FROM_LIBRARY_LABEL}
          accessibilityLabel={ADD_FROM_LIBRARY_LABEL}
          onPress={onAddFromLibrary}
        />
        <Button
          testID="camera-not-now"
          variant="tertiary"
          label={CANCEL_LABEL}
          accessibilityLabel={CANCEL_LABEL}
          onPress={onNotNow}
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
        onCapture={model.takePhoto}
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

/** After a capture lands: a quiet invitation to keep going (while the session has
 *  room) or settle back into arranging the collected pages. */
function TakeAnotherPrompt({
  canAdd,
  onTakeAnother,
  onDone,
}: {
  canAdd: boolean;
  onTakeAnother: () => void;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      <Text style={styles.notice}>{TAKE_ANOTHER_COPY}</Text>
      {canAdd ? (
        <Button
          testID="capture-take-another"
          variant="secondary"
          label={TAKE_ANOTHER_LABEL}
          accessibilityLabel={TAKE_ANOTHER_LABEL}
          onPress={onTakeAnother}
        />
      ) : null}
      <Button
        testID="capture-done"
        label={DONE_CAPTURING_LABEL}
        accessibilityLabel={DONE_CAPTURING_LABEL}
        onPress={onDone}
      />
    </View>
  );
}

/** The pause right after a capture: the collected thumbnails (collect actions
 *  hidden, so the only forward affordances are take-another and Done), with the
 *  take-another loop beneath them. Done settles back into the full collect stage. */
function TakeAnotherView({ model }: { model: CaptureModel }): React.JSX.Element {
  return (
    <View style={styles.container}>
      <CapturePagesStrip
        pages={model.pages}
        canAdd={model.canAdd}
        onAdd={model.runPick}
        onCapture={model.takePhoto}
        onRemove={model.removePage}
        onReorder={model.reorderPages}
        onTranscribe={model.transcribe}
        actionsHidden
      />
      <TakeAnotherPrompt
        canAdd={model.canAdd}
        onTakeAnother={model.takePhoto}
        onDone={model.finishCapturing}
      />
    </View>
  );
}

/** Route the current phase to its view. */
function CaptureBody({ model }: { model: CaptureModel }): React.JSX.Element {
  switch (model.phase.step) {
    case 'denied':
      return <PermissionDeniedView onOpenSettings={model.openSettings} onCancel={model.cancel} />;
    case 'cameraDenied':
      return (
        <CameraDeniedView
          onOpenSettings={model.openSettings}
          onAddFromLibrary={model.runPick}
          onNotNow={model.finishCapturing}
        />
      );
    case 'pickFailed':
      return <PickFailedView onPickAnother={model.runPick} />;
    case 'collect':
      return <CollectView model={model} />;
    case 'takeAnother':
      return <TakeAnotherView model={model} />;
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
