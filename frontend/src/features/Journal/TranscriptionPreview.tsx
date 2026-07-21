/**
 * The review surface for a multi-page transcription run: one block per session
 * page, in order, each showing its own live state — a quiet skeleton while it
 * reads, an editable field once its text lands, or a warm, per-page recovery card
 * if it fails. The blocks merge into one entry upstream; here each page stands on
 * its own so a single bad photo never blocks the others.
 *
 * PRIVACY: a block renders status, text, and a failure's copy only — never the
 * page image — so no base64 reaches the tree, a testID, or the accessibility layer.
 */
import React from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';

import type { CapturePage } from './captureSession';
import styles from './JournalPhotograph.styles';
import { TERMINAL_ERROR_KINDS } from './transcriptionRun';
import type { TranscriptionBlock } from './transcriptionRun';

import { TranscriptionError } from '@/api';
import type { TranscriptionErrorKind } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { Button } from '@/components/Button';
import { accent } from '@/design/tokens';

// --- Copy (warm, declinable — NORTH-STAR) ---------------------------------

const READING_COPY = 'Reading this page…';
const RETRY_LABEL = 'Try again';
const RETAKE_LABEL = 'Retake this page';
const REMOVE_LABEL = 'Remove this page';
const REDO_LABEL = 'Read this page again';
const REDO_CONFIRM_LABEL = 'Read again and replace my edits';
const BLOCK_INPUT_A11Y = 'Edit the transcribed text of this page';

/** The 402 status a spent wallet reports, so its copy stays the shared 402 source. */
const WALLET_EXHAUSTED_STATUS = 402;

/** Friendly terminal copy when the configured model cannot read images at all. */
const MODEL_LACKS_VISION_COPY =
  "Reading photos isn't available with the configured AI model. You can still write this page by hand.";

/** Per-kind copy for a recoverable page failure. `wallet_exhausted` is sourced from
 *  the shared 402 message instead, so that copy stays a single source of truth. */
const TRANSCRIBE_ERROR_COPY: Readonly<Record<TranscriptionErrorKind, string>> = {
  provider_error: 'The transcription helper had trouble just now. Give it a moment and try again.',
  network: "We couldn't reach the transcription helper. Check your connection and try again.",
  timeout: "That took longer than expected. Try again whenever you're ready.",
  rate_limited: 'The transcription helper is catching its breath. Try again in a moment.',
  invalid_image: "We couldn't quite read that page. Retake it with clearer handwriting.",
  image_too_large:
    'That photo is a little large to read. Retake it, or use a lower-resolution shot.',
  wallet_exhausted: '',
  model_lacks_vision: MODEL_LACKS_VISION_COPY,
  unknown: "Something didn't work while reading this page. Try again, or remove it.",
};

/** Kinds where the photo itself is the problem — a fresh shot is the way forward. */
const RETAKE_KINDS: ReadonlySet<TranscriptionErrorKind> = new Set<TranscriptionErrorKind>([
  'invalid_image',
  'image_too_large',
]);

/** The user-facing copy for a failed page, sourcing wallet copy from the 402 message. */
function blockErrorMessage(kind: TranscriptionErrorKind): string {
  if (kind === 'wallet_exhausted') {
    return formatApiError(new TranscriptionError('wallet_exhausted', WALLET_EXHAUSTED_STATUS));
  }
  return TRANSCRIBE_ERROR_COPY[kind];
}

/** The quiet placeholder shown while a page waits its turn or reads. */
function SkeletonBlock({ position }: { position: number }): React.JSX.Element {
  return (
    <View
      testID={`photograph-block-${position}-skeleton`}
      style={styles.blockSkeleton}
      accessibilityRole="progressbar"
    >
      <ActivityIndicator size="small" color={accent.primary} />
      <Text style={styles.message}>{READING_COPY}</Text>
    </View>
  );
}

interface DoneBlockProps {
  position: number;
  block: TranscriptionBlock;
  confirming: boolean;
  onEdit: (_id: string, _text: string) => void;
  onRetry: (_block: TranscriptionBlock) => void;
  onConfirmRedo: (_id: string) => void;
}

/** A landed page: its editable text, plus an explicit re-read (guarded by an inline
 *  confirm once the writer has hand-edited it, so a redo never silently loses work). */
function DoneBlock({
  position,
  block,
  confirming,
  onEdit,
  onRetry,
  onConfirmRedo,
}: DoneBlockProps): React.JSX.Element {
  return (
    <View style={styles.blockBody}>
      <TextInput
        testID={`photograph-block-${position}-input`}
        style={styles.blockInput}
        value={block.text}
        onChangeText={(text) => onEdit(block.id, text)}
        multiline
        accessibilityLabel={BLOCK_INPUT_A11Y}
      />
      <View style={styles.blockActions}>
        <Button
          testID={`photograph-block-${position}-retry`}
          variant="tertiary"
          label={REDO_LABEL}
          accessibilityLabel={REDO_LABEL}
          onPress={() => onRetry(block)}
        />
        {confirming ? (
          <Button
            testID={`photograph-block-${position}-retry-confirm`}
            variant="secondary"
            label={REDO_CONFIRM_LABEL}
            accessibilityLabel={REDO_CONFIRM_LABEL}
            onPress={() => onConfirmRedo(block.id)}
          />
        ) : null}
      </View>
    </View>
  );
}

interface FailedBlockProps {
  position: number;
  block: TranscriptionBlock;
  onRetry: (_block: TranscriptionBlock) => void;
  onRetake: (_id: string) => void;
  onRemove: (_id: string) => void;
}

/** The kind-specific first move on a failed page: a fresh photo when the image is
 *  the problem, a fresh read for a transient hiccup, or nothing at all when the
 *  failure is terminal — a re-read cannot help, so only Remove moves it forward. */
function PrimaryRecovery({
  position,
  block,
  onRetry,
  onRetake,
}: {
  position: number;
  block: TranscriptionBlock;
  onRetry: (_block: TranscriptionBlock) => void;
  onRetake: (_id: string) => void;
}): React.JSX.Element | null {
  const kind = block.error ?? 'unknown';
  if (TERMINAL_ERROR_KINDS.has(kind)) return null;
  if (RETAKE_KINDS.has(kind)) {
    return (
      <Button
        testID={`photograph-block-${position}-retake`}
        label={RETAKE_LABEL}
        accessibilityLabel={RETAKE_LABEL}
        onPress={() => onRetake(block.id)}
      />
    );
  }
  return (
    <Button
      testID={`photograph-block-${position}-retry`}
      label={RETRY_LABEL}
      accessibilityLabel={RETRY_LABEL}
      onPress={() => onRetry(block)}
    />
  );
}

/** A failed page's recovery card: its warm copy, a kind-specific first move (and none
 *  for a terminal failure, whose copy points to typing by hand), and always Remove. */
function FailedBlock({
  position,
  block,
  onRetry,
  onRetake,
  onRemove,
}: FailedBlockProps): React.JSX.Element {
  return (
    <View style={styles.blockError}>
      <Text testID={`photograph-block-${position}-error`} style={styles.blockErrorText}>
        {blockErrorMessage(block.error ?? 'unknown')}
      </Text>
      <View style={styles.blockActions}>
        <PrimaryRecovery position={position} block={block} onRetry={onRetry} onRetake={onRetake} />
        <Button
          testID={`photograph-block-${position}-remove`}
          variant="tertiary"
          label={REMOVE_LABEL}
          accessibilityLabel={REMOVE_LABEL}
          onPress={() => onRemove(block.id)}
        />
      </View>
    </View>
  );
}

export interface TranscriptionPreviewProps {
  pages: readonly CapturePage[];
  blocks: Record<string, TranscriptionBlock>;
  onEdit: (_id: string, _text: string) => void;
  onRetry: (_block: TranscriptionBlock) => void;
  onConfirmRedo: (_id: string) => void;
  onRetake: (_id: string) => void;
  onRemove: (_id: string) => void;
  isConfirmingRedo: (_id: string) => boolean;
}

/** Pick the right per-status body for one page's block. */
function BlockContent({
  position,
  block,
  props,
}: {
  position: number;
  block: TranscriptionBlock;
  props: TranscriptionPreviewProps;
}): React.JSX.Element {
  if (block.status === 'done') {
    return (
      <DoneBlock
        position={position}
        block={block}
        confirming={props.isConfirmingRedo(block.id)}
        onEdit={props.onEdit}
        onRetry={props.onRetry}
        onConfirmRedo={props.onConfirmRedo}
      />
    );
  }
  if (block.status === 'failed') {
    return (
      <FailedBlock
        position={position}
        block={block}
        onRetry={props.onRetry}
        onRetake={props.onRetake}
        onRemove={props.onRemove}
      />
    );
  }
  return <SkeletonBlock position={position} />;
}

/** Render one block per session page, in order, each in its own container. */
export function TranscriptionPreview(props: TranscriptionPreviewProps): React.JSX.Element {
  return (
    <View style={styles.blocks}>
      {props.pages.map((page, index) => {
        const block = props.blocks[page.id];
        if (!block) return null;
        const position = index + 1;
        return (
          <View key={page.id} testID={`photograph-block-${position}`} style={styles.block}>
            <BlockContent position={position} block={block} props={props} />
          </View>
        );
      })}
    </View>
  );
}

export default TranscriptionPreview;
