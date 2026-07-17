import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import { course as courseApi, type ContentItem } from '../../api';
import { colors } from '../../design/tokens';

import type { ChapterNav } from './chapterNav';
import ChapterReader, { type WriteNotePassage } from './ChapterReader';
import styles from './Course.styles';

const ChapterNavRow = ({ nav }: { nav: ChapterNav }): React.JSX.Element => (
  <View style={styles.chapterNavRow}>
    <TouchableOpacity
      testID="chapter-nav-back"
      onPress={nav.onPrev}
      disabled={!nav.canPrev}
      accessibilityRole="button"
      accessibilityLabel="Previous chapter"
      accessibilityState={{ disabled: !nav.canPrev }}
      style={[
        styles.chapterNavButton,
        styles.chapterNavBack,
        !nav.canPrev && styles.chapterNavBackDisabled,
      ]}
    >
      <Text style={styles.chapterNavBackLabel}>{'← Back'}</Text>
    </TouchableOpacity>
    <TouchableOpacity
      testID="chapter-nav-next"
      onPress={nav.onNext}
      accessibilityRole="button"
      accessibilityLabel={nav.nextIsDone ? 'Done' : 'Next chapter'}
      style={[styles.chapterNavButton, styles.chapterNavNext]}
    >
      <Text style={styles.chapterNavNextLabel}>{nav.nextIsDone ? 'Done' : 'Next →'}</Text>
    </TouchableOpacity>
  </View>
);

interface ViewerFooterProps {
  isRead: boolean;
  marking: boolean;
  onMarkRead: () => void;
  onReflect?: () => void;
  nav: ChapterNav;
}

const ViewerFooter = ({
  isRead,
  marking,
  onMarkRead,
  onReflect,
  nav,
}: ViewerFooterProps): React.JSX.Element => (
  <View style={styles.viewerFooter}>
    <TouchableOpacity
      testID="mark-read-button"
      onPress={onMarkRead}
      disabled={isRead || marking}
      style={[styles.markReadButton, isRead && styles.markReadButtonDone]}
      accessibilityRole="button"
      accessibilityLabel={isRead ? 'Already read' : 'Mark as Read'}
    >
      {marking ? (
        <ActivityIndicator testID="mark-read-loading" size="small" color={colors.text.light} />
      ) : (
        <Text style={[styles.buttonLabelOnAccent, isRead && styles.markReadTextDone]}>
          {isRead ? '✓ Read' : 'Mark as Read'}
        </Text>
      )}
    </TouchableOpacity>
    {isRead && onReflect && (
      <TouchableOpacity
        testID="reflect-button"
        onPress={onReflect}
        style={styles.reflectButton}
        accessibilityRole="button"
        accessibilityLabel="Reflect in Journal"
      >
        <Text style={styles.buttonLabelOnAccent}>Reflect in Journal</Text>
      </TouchableOpacity>
    )}
    <ChapterNavRow nav={nav} />
  </View>
);

interface ContentViewerProps {
  item: ContentItem;
  onBack: () => void;
  onMarkRead: () => void;
  onReflect?: () => void;
  nav: ChapterNav;
  onWriteNote?: (_passage: WriteNotePassage) => void;
  initialScrollOffset?: number;
}

function useMarkReadHandler(
  item: ContentItem,
  onMarkRead: () => void,
): { marking: boolean; isRead: boolean; handleMarkRead: () => Promise<void> } {
  const [marking, setMarking] = useState(false);
  const [isRead, setIsRead] = useState(item.is_read);
  // Tracks the chapter currently on screen so an in-flight ``markRead`` request
  // can tell whether the reader still shows the chapter it was fired for.
  const currentItemIdRef = useRef(item.id);
  // Chapter Next/Back navigation swaps ``item`` while ``ContentViewer`` stays
  // mounted (the reader body re-fetches via its source-keyed effect rather than
  // remounting), so the ``useState`` initializer above never re-runs for the
  // incoming chapter. Resync the local read flag on every item-id change so the
  // Mark-as-Read UI reflects the chapter now on screen instead of the previous
  // one's stale state, and clear ``marking`` so the incoming chapter is
  // immediately markable rather than inheriting the outgoing request's spinner.
  useEffect(() => {
    currentItemIdRef.current = item.id;
    setIsRead(item.is_read);
    setMarking(false);
  }, [item.id, item.is_read]);
  // A fast back-tap while ``markRead`` is in flight
  // used to land ``setMarking(false)`` on an unmounted component, firing
  // the React "state update on an unmounted" warning and (in stricter
  // future versions) tearing down updates of subsequent screens.  The
  // mounted-ref guard skips the setState calls without changing the
  // happy-path behaviour.
  const isMountedRef = useRef(true);
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  const handleMarkRead = useCallback(async () => {
    if (isRead || marking) return;
    // The chapter this request belongs to. Fast Next/Back navigation can swap
    // the on-screen chapter before the request resolves; comparing against the
    // live ``currentItemIdRef`` prevents a late success from labelling whatever
    // chapter happens to be showing (a different one) as read.
    const requestedId = item.id;
    setMarking(true);
    try {
      await courseApi.markRead(requestedId);
      if (!isMountedRef.current) return;
      // Refresh the underlying list regardless: the request did persist for
      // ``requestedId`` server-side, so its ``is_read`` should update even if the
      // reader has since navigated elsewhere.
      onMarkRead();
      if (currentItemIdRef.current === requestedId) setIsRead(true);
    } catch (err) {
      console.error('Failed to mark content as read:', err);
    } finally {
      if (isMountedRef.current && currentItemIdRef.current === requestedId) setMarking(false);
    }
  }, [isRead, marking, item.id, onMarkRead]);

  return { marking, isRead, handleMarkRead };
}

const ContentViewer = ({
  item,
  onBack,
  onMarkRead,
  onReflect,
  nav,
  onWriteNote,
  initialScrollOffset,
}: ContentViewerProps): React.JSX.Element => {
  const { marking, isRead, handleMarkRead } = useMarkReadHandler(item, onMarkRead);

  return (
    <ChapterReader
      source={{ kind: 'content', id: item.id }}
      fallbackTitle={item.title}
      onBack={onBack}
      onWriteNote={onWriteNote}
      initialScrollOffset={initialScrollOffset}
      footer={
        <ViewerFooter
          isRead={isRead}
          marking={marking}
          onMarkRead={handleMarkRead}
          onReflect={onReflect}
          nav={nav}
        />
      }
    />
  );
};

export default ContentViewer;
