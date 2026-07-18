/**
 * Photograph a handwritten journal page, transcribe it, and save it as a finished
 * entry. The flow auto-launches the photo picker on mount, sends the picked image
 * to the transcription endpoint, then offers the writer an editable preview of the
 * text before it becomes a real entry.
 *
 * Every step is warm and declinable (NORTH-STAR): a refused permission, a cancelled
 * pick, an unreadable photo, or a spent transcription wallet each lead to a plain,
 * shame-free offramp — most often "type this entry instead" — never a dead end.
 *
 * PRIVACY: the base64 page image lives in component state only. It is never placed
 * in navigation params or logged, and is released on save and on unmount.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, TextInput, View } from 'react-native';

import styles from './JournalPhotograph.styles';
import { pickJournalPhoto } from './pickJournalPhoto';
import { saveFinishedEntry } from './saveFinishedEntry';

import { TranscriptionError, journal } from '@/api';
import type { MediaType, TranscriptionErrorKind } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
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
const RETRY_LABEL = 'Try again';
const TYPED_ENTRY_LABEL = 'Type this entry instead';
const SAVE_LABEL = 'Save this page';
const RETRY_SAVE_LABEL = 'Try saving again';
const PREVIEW_HEADING = 'Your page';
const PREVIEW_INPUT_A11Y = 'Edit the transcribed text of your page';

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

/** The picked page held in memory for transcription (never in nav params). */
interface PickedImage {
  imageBase64: string;
  mediaType: MediaType;
}

/** The screen's mutually-exclusive phases. */
type Phase =
  | { step: 'preparing' }
  | { step: 'denied' }
  | { step: 'pickFailed' }
  | { step: 'transcribing' }
  | { step: 'preview' }
  | { step: 'error'; error: TranscriptionError };

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
  previewText: string;
  saving: boolean;
  saveFailed: boolean;
  onChangeText: (_text: string) => void;
  runPick: () => void;
  retryTranscribe: () => void;
  save: () => void;
  openSettings: () => void;
  cancel: () => void;
  goTypedEntry: () => void;
}

/** Pick a page image and transcribe it into an editable preview, stashing the
 *  picked image in ``imageRef`` so it never rides in nav params. */
function usePickAndTranscribe(
  navigation: PhotographNavigation,
  setPhase: (_phase: Phase) => void,
  setPreviewText: (_text: string) => void,
  imageRef: React.MutableRefObject<PickedImage | null>,
): { runPick: () => Promise<void>; transcribe: () => Promise<void> } {
  const transcribe = useCallback(async () => {
    const image = imageRef.current;
    if (image == null) return;
    setPhase({ step: 'transcribing' });
    try {
      const { text } = await journal.transcribePage(image);
      setPreviewText(text);
      setPhase({ step: 'preview' });
    } catch (err: unknown) {
      setPhase({ step: 'error', error: asTranscriptionError(err) });
    }
  }, [imageRef, setPhase, setPreviewText]);

  const runPick = useCallback(async () => {
    setPhase({ step: 'preparing' });
    const result = await pickJournalPhoto();
    if (result.kind === 'denied') {
      setPhase({ step: 'denied' });
      return;
    }
    if (result.kind === 'cancelled') {
      navigation.goBack();
      return;
    }
    if (result.kind === 'failed') {
      setPhase({ step: 'pickFailed' });
      return;
    }
    imageRef.current = { imageBase64: result.imageBase64, mediaType: result.mediaType };
    await transcribe();
  }, [navigation, transcribe, imageRef, setPhase]);

  return { runPick, transcribe };
}

/** Persist the edited transcript. Reuses ``createdIdRef`` across save retries so a
 *  retry after a failed finish PATCH updates the created page rather than duplicating it. */
function useSaveEntry(
  navigation: PhotographNavigation,
  previewText: string,
  imageRef: React.MutableRefObject<PickedImage | null>,
  createdIdRef: React.MutableRefObject<number | null>,
): { save: () => Promise<void>; saving: boolean; saveFailed: boolean } {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveFailed(false);
    try {
      const id = await saveFinishedEntry(previewText, createdIdRef.current, (created) => {
        createdIdRef.current = created;
      });
      imageRef.current = null; // Release the page image the moment it is saved.
      navigation.replace('JournalEntry', { entryId: id, justSaved: true });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [previewText, navigation, imageRef, createdIdRef]);

  return { save, saving, saveFailed };
}

/**
 * The capture state machine: pick → transcribe → editable preview → save. Holds
 * the picked image and the created-entry id in refs so neither survives in nav
 * params, and so a save retry after a failed finish PATCH reuses the created id
 * rather than creating a duplicate page.
 */
function usePhotographCapture(navigation: PhotographNavigation): CaptureModel {
  const [phase, setPhase] = useState<Phase>({ step: 'preparing' });
  const [previewText, setPreviewText] = useState('');
  const imageRef = useRef<PickedImage | null>(null);
  const createdIdRef = useRef<number | null>(null);

  const { runPick, transcribe } = usePickAndTranscribe(
    navigation,
    setPhase,
    setPreviewText,
    imageRef,
  );
  const { save, saving, saveFailed } = useSaveEntry(
    navigation,
    previewText,
    imageRef,
    createdIdRef,
  );

  const openSettings = useCallback(() => void Linking.openSettings(), []);
  const cancel = useCallback(() => navigation.goBack(), [navigation]);
  const goTypedEntry = useCallback(() => {
    imageRef.current = null; // Release the page image when stepping off to a typed entry.
    navigation.navigate('JournalEntry');
  }, [navigation, imageRef]);

  useEffect(() => {
    void runPick();
    // The device-local cache file the picker copies is cleaned up by a later epic
    // issue; here we only release our in-memory hold on unmount.
    return () => {
      imageRef.current = null;
    };
  }, [runPick]);

  return {
    phase,
    previewText,
    saving,
    saveFailed,
    onChangeText: setPreviewText,
    runPick: () => void runPick(),
    retryTranscribe: () => void transcribe(),
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

/** The editable transcription preview + Save (and a retry when a save fails). */
function PreviewView({
  value,
  onChangeText,
  onSave,
  saving,
  saveFailed,
}: {
  value: string;
  onChangeText: (_text: string) => void;
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
    </View>
  );
}

/** Route the current phase to its view. */
function CaptureBody({ model }: { model: CaptureModel }): React.JSX.Element {
  const { phase } = model;
  switch (phase.step) {
    case 'denied':
      return <PermissionDeniedView onOpenSettings={model.openSettings} onCancel={model.cancel} />;
    case 'pickFailed':
      return <PickFailedView onPickAnother={model.runPick} />;
    case 'transcribing':
      return <WorkingBlock testID="photograph-transcribing" caption={TRANSCRIBING_COPY} />;
    case 'preview':
      return (
        <PreviewView
          value={model.previewText}
          onChangeText={model.onChangeText}
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
