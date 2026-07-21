/**
 * The collect-stage view of the multi-page capture session: an ordered, horizontal
 * strip of page thumbnails the writer can drag to reorder and tap to remove, over
 * affordances to add more pages or proceed to transcription.
 *
 * Reordering is drag-to-commit (long-press a card, drop it), mirroring the Habits
 * reorder idiom. The proceed affordance reads every collected page: it enables for
 * any non-empty session and hands the whole ordered set to the transcription run.
 */
import React from 'react';
import { Image, Platform, Pressable, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import type { RenderItemParams } from 'react-native-draggable-flatlist';

import { capReachedCopy } from './captureSession';
import type { CapturePage } from './captureSession';
import styles from './JournalPhotograph.styles';

import { Button } from '@/components/Button';

const ADD_PAGES_LABEL = 'Add pages';
const TAKE_PHOTO_LABEL = 'Take photo';
const REMOVE_GLYPH = '×';

/** The proceed button's label: one page reads as itself, several are counted. */
function transcribeLabel(count: number): string {
  return count === 1 ? 'Transcribe this page' : `Transcribe ${count} pages`;
}

interface CapturePageCardProps {
  page: CapturePage;
  pageNumber: number;
  drag: () => void;
  isActive: boolean;
  onRemove: (_id: string) => void;
}

/** One draggable page card: thumbnail, 1-based order badge, and a remove tap. */
function CapturePageCard({
  page,
  pageNumber,
  drag,
  isActive,
  onRemove,
}: CapturePageCardProps): React.JSX.Element {
  return (
    <TouchableOpacity
      onLongPress={drag}
      disabled={isActive}
      style={[styles.pageCard, isActive && styles.pageCardActive]}
    >
      <Image
        source={{ uri: page.uri }}
        style={styles.pageThumbnail}
        accessibilityIgnoresInvertColors
      />
      <View style={styles.pageBadge}>
        <Text style={styles.pageBadgeText}>{pageNumber}</Text>
      </View>
      <Pressable
        testID={`capture-page-remove-${pageNumber}`}
        accessibilityRole="button"
        accessibilityLabel={`Remove page ${pageNumber}`}
        onPress={() => onRemove(page.id)}
        style={styles.pageRemove}
      >
        <Text style={styles.pageRemoveGlyph}>{REMOVE_GLYPH}</Text>
      </Pressable>
    </TouchableOpacity>
  );
}

/** Add-pages affordance, plus the cap notice shown once the session is full. */
function AddPagesControl({
  canAdd,
  onAdd,
}: {
  canAdd: boolean;
  onAdd: () => void;
}): React.JSX.Element {
  return (
    <>
      <Button
        testID="capture-add-pages"
        variant="secondary"
        label={ADD_PAGES_LABEL}
        accessibilityLabel={ADD_PAGES_LABEL}
        disabled={!canAdd}
        onPress={onAdd}
      />
      {canAdd ? null : (
        <Text testID="capture-cap-notice" style={styles.notice}>
          {capReachedCopy}
        </Text>
      )}
    </>
  );
}

/** Camera affordance beside Add pages — native only: the web build has no
 *  in-app camera, so the control never renders there. */
function TakePhotoControl({
  canAdd,
  onCapture,
}: {
  canAdd: boolean;
  onCapture: () => void;
}): React.JSX.Element | null {
  if (Platform.OS === 'web') {
    return null;
  }
  return (
    <Button
      testID="capture-take-photo"
      variant="secondary"
      label={TAKE_PHOTO_LABEL}
      accessibilityLabel={TAKE_PHOTO_LABEL}
      disabled={!canAdd}
      onPress={onCapture}
    />
  );
}

/** Proceed affordance: enabled for any non-empty session, reading every page. */
function TranscribeControl({
  count,
  onTranscribe,
}: {
  count: number;
  onTranscribe: () => void;
}): React.JSX.Element {
  const label = transcribeLabel(count);
  return (
    <Button
      testID="capture-transcribe"
      label={label}
      accessibilityLabel={label}
      disabled={count < 1}
      onPress={onTranscribe}
    />
  );
}

export interface CapturePagesStripProps {
  pages: CapturePage[];
  canAdd: boolean;
  onAdd: () => void;
  onCapture: () => void;
  onRemove: (_id: string) => void;
  onReorder: (_pages: CapturePage[]) => void;
  onTranscribe: () => void;
  /** Hide the add/capture/proceed controls, leaving only the thumbnail strip —
   *  used by phases that offer their own forward affordances. */
  actionsHidden?: boolean;
}

/** Render the ordered page strip plus its add, capture, and proceed affordances
 *  (or the strip alone when `actionsHidden` is set). */
export function CapturePagesStrip({
  pages,
  canAdd,
  onAdd,
  onCapture,
  onRemove,
  onReorder,
  onTranscribe,
  actionsHidden = false,
}: CapturePagesStripProps): React.JSX.Element {
  return (
    <View style={styles.collect}>
      <DraggableFlatList
        testID="capture-pages-list"
        horizontal
        data={pages}
        keyExtractor={(page) => page.id}
        renderItem={({ item, drag, isActive, getIndex }: RenderItemParams<CapturePage>) => (
          <CapturePageCard
            page={item}
            pageNumber={(getIndex() ?? 0) + 1}
            drag={drag}
            isActive={isActive}
            onRemove={onRemove}
          />
        )}
        onDragEnd={({ data }) => onReorder(data)}
        contentContainerStyle={styles.stripContent}
      />
      {actionsHidden ? null : (
        <>
          <AddPagesControl canAdd={canAdd} onAdd={onAdd} />
          <TakePhotoControl canAdd={canAdd} onCapture={onCapture} />
          <TranscribeControl count={pages.length} onTranscribe={onTranscribe} />
        </>
      )}
    </View>
  );
}

export default CapturePagesStrip;
