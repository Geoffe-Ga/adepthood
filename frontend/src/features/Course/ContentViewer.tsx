import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import { course as courseApi, type ContentItem } from '../../api';
import { colors } from '../../design/tokens';

import type { ChapterNav } from './chapterNav';
import ChapterReader from './ChapterReader';
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
}

function useMarkReadHandler(
  item: ContentItem,
  onMarkRead: () => void,
): { marking: boolean; isRead: boolean; handleMarkRead: () => Promise<void> } {
  const [marking, setMarking] = useState(false);
  const [isRead, setIsRead] = useState(item.is_read);
  // BUG-FE-COURSE-005: a fast back-tap while ``markRead`` is in flight
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
    setMarking(true);
    try {
      await courseApi.markRead(item.id);
      if (!isMountedRef.current) return;
      setIsRead(true);
      onMarkRead();
    } catch (err) {
      console.error('Failed to mark content as read:', err);
    } finally {
      if (isMountedRef.current) setMarking(false);
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
}: ContentViewerProps): React.JSX.Element => {
  const { marking, isRead, handleMarkRead } = useMarkReadHandler(item, onMarkRead);

  return (
    <ChapterReader
      source={{ kind: 'content', id: item.id }}
      fallbackTitle={item.title}
      onBack={onBack}
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
