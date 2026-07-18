/**
 * The collect-stage view of the multi-page capture session: an ordered, horizontal
 * strip of page thumbnails the writer can drag to reorder and tap to remove, over
 * affordances to add more pages or proceed to transcription.
 *
 * Reordering is drag-to-commit (long-press a card, drop it), mirroring the Habits
 * reorder idiom. Transcription is single-page in this iteration: the proceed button
 * enables only for exactly one page; more than one surfaces a warm, declinable
 * notice rather than a hard block.
 */
import React from 'react';
import { Image, Pressable, Text, TouchableOpacity, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import type { RenderItemParams } from 'react-native-draggable-flatlist';

import { capReachedCopy } from './captureSession';
import type { CapturePage } from './captureSession';
import styles from './JournalPhotograph.styles';

import { Button } from '@/components/Button';

const ADD_PAGES_LABEL = 'Add pages';
const REMOVE_GLYPH = '×';

/** Warm, declinable copy shown when a session holds more than one page: reading
 *  several pages at once is coming; for now, trim to one to transcribe it. */
const MULTI_PAGE_NOTICE =
  'Reading several pages together is on its way. For now, keep a single page here to transcribe it — remove the others, or save them in their own entries.';

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

/** Proceed affordance: enabled only for a single page; a warm notice explains the
 *  multi-page case rather than blocking it outright. */
function TranscribeControl({
  count,
  onTranscribe,
}: {
  count: number;
  onTranscribe: () => void;
}): React.JSX.Element {
  const label = transcribeLabel(count);
  return (
    <>
      <Button
        testID="capture-transcribe"
        label={label}
        accessibilityLabel={label}
        disabled={count !== 1}
        onPress={onTranscribe}
      />
      {count > 1 ? (
        <Text testID="capture-multi-page-notice" style={styles.notice}>
          {MULTI_PAGE_NOTICE}
        </Text>
      ) : null}
    </>
  );
}

export interface CapturePagesStripProps {
  pages: CapturePage[];
  canAdd: boolean;
  onAdd: () => void;
  onRemove: (_id: string) => void;
  onReorder: (_pages: CapturePage[]) => void;
  onTranscribe: () => void;
}

/** Render the ordered page strip plus its add-pages and proceed affordances. */
export function CapturePagesStrip({
  pages,
  canAdd,
  onAdd,
  onRemove,
  onReorder,
  onTranscribe,
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
      <AddPagesControl canAdd={canAdd} onAdd={onAdd} />
      <TranscribeControl count={pages.length} onTranscribe={onTranscribe} />
    </View>
  );
}

export default CapturePagesStrip;
