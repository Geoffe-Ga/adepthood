/**
 * Photograph handwritten journal pages, transcribe them, and save them as a
 * finished entry. The flow auto-launches the photo picker on mount into an
 * ordered, multi-page capture session: the writer collects pages from the
 * library (multi-select) or photographs them one at a time with the camera,
 * reorders the thumbnail strip, and trims it before proceeding. Transcription is
 * single-page in this iteration — the proceed affordance enables only for exactly
 * one page — after which the writer gets an editable preview before it becomes a
 * real entry.
 *
 * Every step is warm and declinable (NORTH-STAR): a refused permission, a cancelled
 * pick, an unreadable photo, or a spent transcription wallet each lead to a plain,
 * shame-free offramp — most often "type this entry instead" — never a dead end.
 *
 * PRIVACY: the base64 page images live in the capture session's reducer state
 * only. They are never placed in navigation params or logged, and are released
 * when the session is cleared (on save, on the typed-entry offramp) and on unmount.
 * The transient device files behind them — the picker/camera cache copies and the
 * downscaled prepare outputs — are deleted in lockstep: when a page is removed,
 * once it is transcribed, when the session is released, and on unmount.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, TextInput, View } from 'react-native';

import { releaseAllPageFiles, releasePageFiles, releaseUris } from './capture/cleanupPageFiles';
import { MAX_TRANSCRIBE_IMAGE_BYTES, preparePageForTranscription } from './capture/prepareImage';
import type { PreparedPage } from './capture/prepareImage';
import { CapturePagesStrip } from './CapturePagesStrip';
import { MAX_PAGES_PER_SESSION, canAddPages, captureSessionReducer } from './captureSession';
import type { CapturePage, CaptureSessionAction } from './captureSession';
import styles from './JournalPhotograph.styles';
import { captureJournalPhoto, pickJournalPhotos } from './pickJournalPhoto';
import type { CaptureResult, MultiPickResult, PickedAsset } from './pickJournalPhoto';
import { saveFinishedEntry } from './saveFinishedEntry';

import { TranscriptionError, journal } from '@/api';
import type { TranscriptionErrorKind } from '@/api';
import { formatApiError } from '@/api/errorMessages';
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
const TRANSCRIBING_COPY = 'Reading your page…';
const PICK_FAILED_COPY =
  "We couldn't read that photo. Pick another one and we'll try again — no rush.";
const PICK_ANOTHER_LABEL = 'Pick another photo';
const CAMERA_DENIED_COPY =
  'Adepthood needs the camera to photograph a page. You can turn that on in Settings, add a photo from your library instead, or come back anytime.';
const ADD_FROM_LIBRARY_LABEL = 'Add from your library';
const TAKE_ANOTHER_COPY = "That page is in. Take another whenever you're ready.";
const TAKE_ANOTHER_LABEL = 'Take another';
const DONE_CAPTURING_LABEL = 'Done';
const RETRY_LABEL = 'Try again';
const TYPED_ENTRY_LABEL = 'Type this entry instead';
const SAVE_LABEL = 'Save this page';
const RETRY_SAVE_LABEL = 'Try saving again';
const PREVIEW_HEADING = 'Your page';
const PREVIEW_INPUT_A11Y = 'Edit the transcribed text of your page';
const ENTRY_DATE_LABEL = 'Entry date';

/** Friendly terminal copy when the configured model cannot read images at all. */
const MODEL_LACKS_VISION_COPY =
  "Reading photos isn't available with the configured AI model. You can still write this page by hand.";

/** Per-kind copy for a recoverable transcription failure (wallet copy is sourced
 *  from the shared 402 message instead, so it stays a single source of truth). */
const TRANSCRIBE_ERROR_COPY: Readonly<Record<TranscriptionErrorKind, string>> = {
  provider_error: 'The transcription helper had trouble just now. Give it a moment and try again.',
  network: "We couldn't reach the transcription helper. Check your connection and try again.",
  timeout: "That took longer than expected. Try again whenever you're ready.",
  rate_limited: 'The transcription helper is catching its breath. Try again in a moment.',
  invalid_image: "We couldn't quite read that page. Try another photo with clearer handwriting.",
  image_too_large: 'That photo is a little large to read. Try another, or a lower-resolution shot.',
  wallet_exhausted: '',
  model_lacks_vision: MODEL_LACKS_VISION_COPY,
  unknown: "Something didn't work while reading your page. Try again, or type this entry instead.",
};

/** Kinds a fresh transcription attempt might clear — offer a single retry tap. */
const RETRY_KINDS: ReadonlySet<TranscriptionErrorKind> = new Set<TranscriptionErrorKind>([
  'provider_error',
  'network',
  'timeout',
  'rate_limited',
  'unknown',
]);
/** Kinds where the photo itself is the problem — offer a different photo. */
const PICK_ANOTHER_KINDS: ReadonlySet<TranscriptionErrorKind> = new Set<TranscriptionErrorKind>([
  'invalid_image',
  'image_too_large',
]);
/** Kinds with no photo path forward — offer the typed-entry offramp. */
const TYPED_ENTRY_KINDS: ReadonlySet<TranscriptionErrorKind> = new Set<TranscriptionErrorKind>([
  'unknown',
  'wallet_exhausted',
  'model_lacks_vision',
]);

/** The screen's mutually-exclusive phases. */
type Phase =
  | { step: 'preparing' }
  | { step: 'denied' }
  | { step: 'cameraDenied' }
  | { step: 'pickFailed' }
  | { step: 'collect' }
  | { step: 'takeAnother' }
  | { step: 'transcribing' }
  | { step: 'preview' }
  | { step: 'error'; error: TranscriptionError };

/** The shared unreadable-photo offramp phase: only a different photo helps, so
 *  a failed pick, an unusable capture, and an unpreparable image all land here. */
const PICK_FAILED_PHASE: Phase = { step: 'pickFailed' };

/** The recovery affordances a given transcription error offers. */
interface Recovery {
  message: string;
  showRetry: boolean;
  showPickAnother: boolean;
  showTypedEntry: boolean;
}

/** Derive a failure's message + which offramps to show, from its stable kind. */
function recoveryFor(error: TranscriptionError): Recovery {
  const { kind } = error;
  const message = kind === 'wallet_exhausted' ? formatApiError(error) : TRANSCRIBE_ERROR_COPY[kind];
  return {
    message,
    showRetry: RETRY_KINDS.has(kind),
    showPickAnother: PICK_ANOTHER_KINDS.has(kind),
    showTypedEntry: TYPED_ENTRY_KINDS.has(kind),
  };
}

/** Coerce any thrown value into a {@link TranscriptionError} (the API already
 *  throws these; this guards the unforeseen so `.kind` is always readable). */
function asTranscriptionError(err: unknown): TranscriptionError {
  return err instanceof TranscriptionError ? err : new TranscriptionError('unknown', null, err);
}

type PhotographNavigation = NativeStackScreenProps<
  RootStackParamList,
  'JournalPhotograph'
>['navigation'];

interface CaptureModel {
  phase: Phase;
  pages: CapturePage[];
  canAdd: boolean;
  previewText: string;
  entryDate: string;
  saving: boolean;
  saveFailed: boolean;
  onChangeText: (_text: string) => void;
  onChangeEntryDate: (_date: string) => void;
  runPick: () => void;
  takePhoto: () => void;
  finishCapturing: () => void;
  removePage: (_id: string) => void;
  reorderPages: (_pages: CapturePage[]) => void;
  transcribe: () => void;
  retryTranscribe: () => void;
  save: () => void;
  openSettings: () => void;
  cancel: () => void;
  goTypedEntry: () => void;
}

/** The chosen backdate, or undefined when it is today (the backend then stamps now). */
function entryDateForCreate(entryDate: string): string | undefined {
  return entryDate === toISODate(new Date()) ? undefined : entryDate;
}

/** Fire-and-forget a best-effort file cleanup: transient-file deletion must
 *  never block or fail the writing flow, so rejections are deliberately dropped
 *  (the cleanup module already warns with metadata only). */
function fireAndForgetCleanup(cleanup: Promise<void>): void {
  cleanup.catch(() => undefined);
}

/** A picked asset paired with its downscaled transcription payload. */
interface PreparedAsset {
  sourceUri: string;
  prepared: PreparedPage;
}

/** Prepare a whole batch, requiring every asset to succeed. If any asset fails
 *  to prepare, none of the batch is stored — so reclaim every transient file it
 *  created (the source copies plus any downscaled outputs that did land) before
 *  rethrowing, leaving nothing stranded and untracked by the cleanup paths. */
async function prepareBatch(assets: readonly PickedAsset[]): Promise<PreparedAsset[]> {
  const settled = await Promise.allSettled(
    assets.map(async (asset) => ({
      sourceUri: asset.uri,
      prepared: await preparePageForTranscription(asset.uri),
    })),
  );
  const fulfilled = settled.filter(
    (result): result is PromiseFulfilledResult<PreparedAsset> => result.status === 'fulfilled',
  );
  if (fulfilled.length !== settled.length) {
    const outputs = fulfilled.map((result) => result.value.prepared.uri);
    await releaseUris([...assets.map((asset) => asset.uri), ...outputs]);
    throw new Error('Journal capture: a picked page could not be prepared');
  }
  return fulfilled.map((result) => result.value);
}

/** Prepare every freshly-picked asset for transcription and give each a stable
 *  session id (a monotonic counter), building the {@link CapturePage} list
 *  appended to the session. Preparation runs before storage so the session never
 *  holds a full-resolution payload; one unpreparable asset rejects the batch (see
 *  {@link prepareBatch}), which the callers route to the unreadable-photo offramp. */
async function toCapturePages(
  assets: readonly PickedAsset[],
  counterRef: React.MutableRefObject<number>,
): Promise<CapturePage[]> {
  const preparedAssets = await prepareBatch(assets);
  return preparedAssets.map(({ sourceUri, prepared }) => {
    counterRef.current += 1;
    return {
      id: `page-${counterRef.current}`,
      sourceUri,
      uri: prepared.uri,
      imageBase64: prepared.base64,
      byteLength: prepared.byteLength,
      mediaType: prepared.mediaType,
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
  setPhase(PICK_FAILED_PHASE);
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
    if (result.kind !== 'picked') {
      if (hadPages) {
        setPhase({ step: 'collect' });
      } else {
        applyInitialPickFailure(result, navigation, setPhase);
      }
      return;
    }
    // Trim to the session's remaining room BEFORE preparing, so the manipulator
    // never writes a cache file for a page the reducer would clamp away and leave
    // untracked by cleanup.
    const room = MAX_PAGES_PER_SESSION - pagesRef.current.length;
    const inRoom = result.assets.slice(0, room);
    try {
      dispatch({ type: 'append', pages: await toCapturePages(inRoom, counterRef) });
      setPhase({ step: 'collect' });
    } catch {
      // A photo the prepare step could not read reuses the pick-failed offramp.
      setPhase(PICK_FAILED_PHASE);
    }
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
async function applyCaptureResult(result: CaptureResult, deps: CaptureDeps): Promise<void> {
  const { dispatch, counterRef, setPhase } = deps;
  if (result.kind === 'captured') {
    try {
      dispatch({ type: 'append', pages: await toCapturePages([result.asset], counterRef) });
      setPhase({ step: 'takeAnother' });
    } catch {
      // A capture the prepare step could not read reuses the pick-failed offramp.
      setPhase(PICK_FAILED_PHASE);
    }
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
  setPhase(PICK_FAILED_PHASE);
}

/** Launch the camera for one page and fold the outcome into the session. */
function useCameraCapture(deps: CaptureDeps): () => Promise<void> {
  const { dispatch, counterRef, setPhase } = deps;
  return useCallback(async () => {
    await applyCaptureResult(await captureJournalPhoto(), { dispatch, counterRef, setPhase });
  }, [dispatch, counterRef, setPhase]);
}

/** Transcribe the session's single page into an editable preview. This is the
 *  seam a later epic widens to multi-page reading; here it handles exactly one
 *  page and no-ops otherwise (the proceed button is disabled for any other count). */
function useBeginTranscription(
  pagesRef: React.MutableRefObject<CapturePage[]>,
  setPhase: (_phase: Phase) => void,
  setPreviewText: (_text: string) => void,
): () => Promise<void> {
  return useCallback(async () => {
    const [page] = pagesRef.current;
    if (pagesRef.current.length !== 1 || !page) return;
    if (page.byteLength >= MAX_TRANSCRIBE_IMAGE_BYTES) {
      // Too large even after downscaling: surface the same recovery the server
      // would, without spending the round-trip (or the wallet) to hear it.
      setPhase({ step: 'error', error: new TranscriptionError('image_too_large', null) });
      return;
    }
    setPhase({ step: 'transcribing' });
    try {
      const { text } = await journal.transcribePage({
        imageBase64: page.imageBase64,
        mediaType: page.mediaType,
      });
      // The page is read; its transient device files have served their purpose.
      fireAndForgetCleanup(releasePageFiles(page));
      setPreviewText(text);
      setPhase({ step: 'preview' });
    } catch (err: unknown) {
      setPhase({ step: 'error', error: asTranscriptionError(err) });
    }
  }, [pagesRef, setPhase, setPreviewText]);
}

/** Persist the edited transcript. Reuses ``createdIdRef`` across save retries so a
 *  retry after a failed finish PATCH updates the created page rather than duplicating it. */
function useSaveEntry(
  navigation: PhotographNavigation,
  previewText: string,
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
        previewText,
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
  }, [previewText, entryDate, navigation, releaseSession, createdIdRef]);

  return { save, saving, saveFailed };
}

/** The navigation offramps that also release the in-memory session: opening
 *  device settings, backing out, and stepping off to a plain typed entry. */
function useNavigationOfframps(
  navigation: PhotographNavigation,
  releaseSession: () => void,
): { openSettings: () => void; cancel: () => void; goTypedEntry: () => void } {
  const openSettings = useCallback(() => void Linking.openSettings(), []);
  const cancel = useCallback(() => navigation.goBack(), [navigation]);
  const goTypedEntry = useCallback(() => {
    releaseSession(); // Release the session when stepping off to a typed entry.
    navigation.navigate('JournalEntry');
  }, [navigation, releaseSession]);
  return { openSettings, cancel, goTypedEntry };
}

/** Keeps the transient device files in lockstep with the in-memory session:
 *  release-everything-and-clear (save, typed-entry offramp), an unmount sweep
 *  for whatever the writer walked away from, and per-page removal. */
function useSessionCleanup(
  pagesRef: React.MutableRefObject<CapturePage[]>,
  dispatch: React.Dispatch<CaptureSessionAction>,
): { releaseSession: () => void; removePage: (_id: string) => void } {
  const releaseSessionFiles = useCallback(() => {
    fireAndForgetCleanup(releaseAllPageFiles(pagesRef.current));
  }, [pagesRef]);

  // The unmount sweep: a session cleared on save leaves an empty list here, so
  // the sweep only ever deletes files still owned by lingering pages. React
  // releases the in-memory base64 with the reducer state itself.
  useEffect(() => releaseSessionFiles, [releaseSessionFiles]);

  const releaseSession = useCallback(() => {
    releaseSessionFiles(); // Device files first, then the in-memory clear.
    dispatch({ type: 'clear' });
  }, [releaseSessionFiles, dispatch]);

  const removePage = useCallback(
    (id: string) => {
      const removed = pagesRef.current.find((page) => page.id === id);
      if (removed) {
        fireAndForgetCleanup(releasePageFiles(removed)); // Files first, then the drop.
      }
      dispatch({ type: 'remove', id });
    },
    [pagesRef, dispatch],
  );

  return { releaseSession, removePage };
}

/**
 * The capture state machine: collect pages → transcribe → editable preview → save.
 * Pages live in a reducer (never in nav params) with a ref mirror so async picks
 * read the current session; the created-entry id lives in a ref so a save retry
 * after a failed finish PATCH reuses it rather than creating a duplicate page.
 */
function usePhotographCapture(navigation: PhotographNavigation): CaptureModel {
  const [phase, setPhase] = useState<Phase>({ step: 'preparing' });
  const [pages, dispatch] = useReducer(captureSessionReducer, []);
  const [previewText, setPreviewText] = useState('');
  const [entryDate, setEntryDate] = useState(() => toISODate(new Date()));
  const createdIdRef = useRef<number | null>(null);
  const counterRef = useRef(0);
  const pagesRef = useRef<CapturePage[]>(pages);
  pagesRef.current = pages;

  const { releaseSession, removePage } = useSessionCleanup(pagesRef, dispatch);
  const runPick = usePickPages({ navigation, dispatch, pagesRef, counterRef, setPhase });
  const runCapture = useCameraCapture({ dispatch, counterRef, setPhase });
  const beginTranscription = useBeginTranscription(pagesRef, setPhase, setPreviewText);
  const { save, saving, saveFailed } = useSaveEntry(
    navigation,
    previewText,
    entryDate,
    releaseSession,
    createdIdRef,
  );

  const { openSettings, cancel, goTypedEntry } = useNavigationOfframps(navigation, releaseSession);

  useEffect(() => {
    void runPick();
  }, [runPick]);

  return {
    phase,
    pages,
    canAdd: canAddPages(pages),
    previewText,
    entryDate,
    saving,
    saveFailed,
    onChangeText: setPreviewText,
    onChangeEntryDate: setEntryDate,
    runPick: () => void runPick(),
    takePhoto: () => void runCapture(),
    finishCapturing: () => setPhase({ step: 'collect' }),
    removePage,
    reorderPages: (next) => dispatch({ type: 'reorder', pages: next }),
    transcribe: () => void beginTranscription(),
    retryTranscribe: () => void beginTranscription(),
    save: () => void save(),
    openSettings,
    cancel,
    goTypedEntry,
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

/** A transcription failure with its per-kind recovery offramps. */
function TranscribeErrorView({
  recovery,
  onRetry,
  onPickAnother,
  onTypedEntry,
}: {
  recovery: Recovery;
  onRetry: () => void;
  onPickAnother: () => void;
  onTypedEntry: () => void;
}): React.JSX.Element {
  return (
    <View testID="photograph-error" style={styles.container}>
      <Text style={styles.message}>{recovery.message}</Text>
      <View style={styles.actions}>
        {recovery.showRetry ? (
          <Button
            testID="photograph-retry"
            label={RETRY_LABEL}
            accessibilityLabel={RETRY_LABEL}
            onPress={onRetry}
          />
        ) : null}
        {recovery.showPickAnother ? (
          <Button
            testID="photograph-pick-another"
            label={PICK_ANOTHER_LABEL}
            accessibilityLabel={PICK_ANOTHER_LABEL}
            onPress={onPickAnother}
          />
        ) : null}
        {recovery.showTypedEntry ? (
          <Button
            testID="photograph-typed-entry"
            variant="tertiary"
            label={TYPED_ENTRY_LABEL}
            accessibilityLabel={TYPED_ENTRY_LABEL}
            onPress={onTypedEntry}
          />
        ) : null}
      </View>
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

/** Save, plus a Retry-save button surfaced only after a save has failed. */
function PreviewActions({
  onSave,
  saving,
  saveFailed,
}: {
  onSave: () => void;
  saving: boolean;
  saveFailed: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      <Button
        testID="photograph-save"
        label={SAVE_LABEL}
        accessibilityLabel={SAVE_LABEL}
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

/** The editable transcription preview + Save (and a retry when a save fails). */
function PreviewView({
  value,
  onChangeText,
  entryDate,
  onChangeEntryDate,
  onSave,
  saving,
  saveFailed,
}: {
  value: string;
  onChangeText: (_text: string) => void;
  entryDate: string;
  onChangeEntryDate: (_date: string) => void;
  onSave: () => void;
  saving: boolean;
  saveFailed: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>{PREVIEW_HEADING}</Text>
      <TextInput
        testID="photograph-preview-input"
        style={styles.previewInput}
        value={value}
        onChangeText={onChangeText}
        multiline
        accessibilityLabel={PREVIEW_INPUT_A11Y}
      />
      <EntryDateRow entryDate={entryDate} onChangeEntryDate={onChangeEntryDate} />
      <PreviewActions onSave={onSave} saving={saving} saveFailed={saveFailed} />
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
  const { phase } = model;
  switch (phase.step) {
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
    case 'transcribing':
      return <WorkingBlock testID="photograph-transcribing" caption={TRANSCRIBING_COPY} />;
    case 'preview':
      return (
        <PreviewView
          value={model.previewText}
          onChangeText={model.onChangeText}
          entryDate={model.entryDate}
          onChangeEntryDate={model.onChangeEntryDate}
          onSave={model.save}
          saving={model.saving}
          saveFailed={model.saveFailed}
        />
      );
    case 'error':
      return (
        <TranscribeErrorView
          recovery={recoveryFor(phase.error)}
          onRetry={model.retryTranscribe}
          onPickAnother={model.runPick}
          onTypedEntry={model.goTypedEntry}
        />
      );
    default:
      return <WorkingBlock testID="photograph-preparing" caption={PREPARING_COPY} />;
  }
}

/** The photograph-capture route: pick a page, transcribe it, then save it. */
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
