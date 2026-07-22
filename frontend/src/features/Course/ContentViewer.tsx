import { ChevronLeft, ChevronRight, DoorOpen } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Text, TouchableOpacity, View } from 'react-native';

import { course as courseApi, type ContentItem } from '../../api';
import { NAV_ICON_SIZE, NAV_ICON_STROKE } from '../../components/drawer/navIcon';
import { accent, colors, ink } from '../../design/tokens';

import type { ChapterNav } from './chapterNav';
import ChapterReader, { type WriteNotePassage } from './ChapterReader';
import styles from './Course.styles';

// Read-toast choreography: fade in, hold, fade out. Hold plus exit fade must
// finish comfortably inside the reader tests' 5s settle window.
const READ_TOAST_PAUSE_MS = 1800;
const READ_TOAST_FADE_MS = 250;
const READ_TOAST_SLIDE_DISTANCE = 12;

const toastFade = (
  opacity: Animated.Value,
  translateY: Animated.Value,
  toOpacity: number,
  toTranslateY: number,
): Animated.CompositeAnimation =>
  Animated.parallel([
    Animated.timing(opacity, {
      toValue: toOpacity,
      duration: READ_TOAST_FADE_MS,
      useNativeDriver: true,
    }),
    Animated.timing(translateY, {
      toValue: toTranslateY,
      duration: READ_TOAST_FADE_MS,
      useNativeDriver: true,
    }),
  ]);

// After the on-screen pause, fades the toast out and reports when it finished
// cleanly (an interrupted fade must not hide state it no longer owns).
const scheduleToastDismiss = (
  opacity: Animated.Value,
  translateY: Animated.Value,
  onHidden: () => void,
): ReturnType<typeof setTimeout> =>
  setTimeout(() => {
    toastFade(opacity, translateY, 0, READ_TOAST_SLIDE_DISTANCE).start(({ finished }) => {
      if (finished) onHidden();
    });
  }, READ_TOAST_PAUSE_MS);

interface ReadToast {
  visible: boolean;
  opacity: Animated.Value;
  translateY: Animated.Value;
  trigger: () => void;
}

/**
 * Owns the transient "✓ Read" confirmation shown after a successful mark-read:
 * ``trigger()`` fades the toast in, holds it for a named pause, then fades it
 * out. An ``itemId``-keyed effect dismisses a stale toast (and its pending
 * timer) when chapter Next/Back swaps the item while the reader stays mounted.
 */
function useReadToast(itemId: number): ReadToast {
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(READ_TOAST_SLIDE_DISTANCE)).current;
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const hide = useCallback(() => setVisible(false), []);

  const trigger = useCallback(() => {
    clearTimeout(dismissTimerRef.current);
    opacity.setValue(0);
    translateY.setValue(READ_TOAST_SLIDE_DISTANCE);
    setVisible(true);
    toastFade(opacity, translateY, 1, 0).start(({ finished }) => {
      if (finished) dismissTimerRef.current = scheduleToastDismiss(opacity, translateY, hide);
    });
  }, [opacity, translateY, hide]);

  // Chapter navigation swaps ``item`` in place: hide any toast celebrating the
  // outgoing chapter. The cleanup (which also covers unmount) drops the pending
  // dismiss timer and stops the fades so an interrupted fade-in cannot schedule
  // a stale dismiss via its finished callback.
  useEffect(() => {
    setVisible(false);
    return () => {
      clearTimeout(dismissTimerRef.current);
      opacity.stopAnimation();
      translateY.stopAnimation();
    };
  }, [itemId, opacity, translateY]);

  return { visible, opacity, translateY, trigger };
}

interface MarkReadToastProps {
  opacity: Animated.Value;
  translateY: Animated.Value;
}

/** Transient confirmation card floated above the footer's single nav row. */
const MarkReadToast = ({ opacity, translateY }: MarkReadToastProps): React.JSX.Element => (
  <Animated.View
    testID="read-toast"
    accessibilityLiveRegion="polite"
    accessibilityRole="alert"
    accessibilityLabel="Marked as read"
    style={[styles.readToast, { opacity, transform: [{ translateY }] }]}
  >
    <Text style={styles.readToastText}>✓ Read</Text>
  </Animated.View>
);

const ChapterPrevButton = ({ nav }: { nav: ChapterNav }): React.JSX.Element => (
  <TouchableOpacity
    testID="chapter-nav-back"
    onPress={nav.onPrev}
    disabled={!nav.canPrev}
    accessibilityRole="button"
    accessibilityLabel="Previous chapter"
    accessibilityState={{ disabled: !nav.canPrev }}
    style={[styles.footerIconButton, !nav.canPrev && styles.chapterNavBackDisabled]}
  >
    <ChevronLeft size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} color={ink.soft} />
  </TouchableOpacity>
);

const ChapterNextButton = ({ nav }: { nav: ChapterNav }): React.JSX.Element => {
  const NextGlyph = nav.nextIsDone ? DoorOpen : ChevronRight;
  return (
    <TouchableOpacity
      testID="chapter-nav-next"
      onPress={nav.onNext}
      accessibilityRole="button"
      accessibilityLabel={nav.nextIsDone ? 'Done' : 'Next chapter'}
      style={styles.footerIconButton}
    >
      <NextGlyph size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} color={accent.primary} />
    </TouchableOpacity>
  );
};

interface FooterCenterProps {
  isRead: boolean;
  marking: boolean;
  onMarkRead: () => void;
  onReflect?: () => void;
}

// Center slot: mark-read while unread, reflect once read (when offered),
// otherwise the quiet "✓ Read" done state.
const FooterCenter = ({
  isRead,
  marking,
  onMarkRead,
  onReflect,
}: FooterCenterProps): React.JSX.Element => {
  if (isRead && onReflect) {
    return (
      <TouchableOpacity
        testID="reflect-button"
        onPress={onReflect}
        style={styles.reflectButton}
        accessibilityRole="button"
        accessibilityLabel="Reflect in Journal"
      >
        <Text style={styles.buttonLabelOnAccent}>Reflect in Journal</Text>
      </TouchableOpacity>
    );
  }
  return (
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
  );
};

interface ViewerFooterProps {
  isRead: boolean;
  marking: boolean;
  onMarkRead: () => void;
  onReflect?: () => void;
  nav: ChapterNav;
  toast: ReadToast;
}

const ViewerFooter = ({
  isRead,
  marking,
  onMarkRead,
  onReflect,
  nav,
  toast,
}: ViewerFooterProps): React.JSX.Element => (
  <View style={styles.viewerFooter}>
    {toast.visible && <MarkReadToast opacity={toast.opacity} translateY={toast.translateY} />}
    <View style={styles.viewerFooterRow}>
      <ChapterPrevButton nav={nav} />
      <FooterCenter
        isRead={isRead}
        marking={marking}
        onMarkRead={onMarkRead}
        onReflect={onReflect}
      />
      <ChapterNextButton nav={nav} />
    </View>
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
  onMarkedRead: () => void,
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
      if (currentItemIdRef.current === requestedId) {
        setIsRead(true);
        onMarkedRead();
      }
    } catch (err) {
      console.error('Failed to mark content as read:', err);
    } finally {
      if (isMountedRef.current && currentItemIdRef.current === requestedId) setMarking(false);
    }
  }, [isRead, marking, item.id, onMarkRead, onMarkedRead]);

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
  const toast = useReadToast(item.id);
  const { marking, isRead, handleMarkRead } = useMarkReadHandler(item, onMarkRead, toast.trigger);

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
          toast={toast}
        />
      }
    />
  );
};

export default ContentViewer;
