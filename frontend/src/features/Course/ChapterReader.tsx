import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Markdown from 'react-native-markdown-display';

import { course as courseApi, type ContentBody } from '../../api';
import { BottomFade } from '../../components/layout/BottomFade';
import { colors, rhythm, surface } from '../../design/tokens';
import ConfirmDialog from '../Habits/components/ConfirmDialog';
import QuoteSelectionSurface, { type CodePointSpan } from '../Journal/QuoteSelectionSurface';

import styles, { markdownStyles } from './Course.styles';
import RetryButton from './RetryButton';
import { stripLeadingTitleHeading } from './stripLeadingTitleHeading';

/** A passage folded out of the reader into the journal, with its scroll anchor. */
export interface WriteNotePassage {
  text: string;
  sourceTitle: string;
  scrollOffset: number;
}

const SCROLL_EVENT_THROTTLE = 16;
/**
 * How near the essay's end counts as being at it, in px. Matched to the veil's
 * height so the chapter controls arrive exactly as the fade starts its work.
 */
const READER_CONTROLS_REVEAL_THRESHOLD = rhythm.bottomFadeHeight;
const PASSAGE_SELECT_TEST_ID = 'passage-select';
const WRITE_NOTE_AFFORDANCE_LABEL = 'Write a note on a passage';
const WRITE_NOTE_CONFIRM_LABEL = 'Write a note';
const WRITE_NOTE_DIALOG_TITLE = 'Write a note on this passage?';
const WRITE_NOTE_DIALOG_MESSAGE = 'You can pick up right where you left off.';
const WRITE_NOTE_DIALOG_CANCEL = 'Keep reading';

/**
 * Small-caps eyebrow shown above the sheet title, keyed by content type.
 * Only the types listed here map to a label; others (e.g. seeded ``essay`` /
 * ``video`` / ``prompt`` chapters) resolve to ``undefined`` and render no
 * eyebrow, which the sheet header handles gracefully.
 */
const READER_EYEBROWS: Record<string, string> = {
  chapter: 'Chapter',
  resource: 'Resource',
  introduction: 'Introduction',
};

/**
 * Source descriptor for the reader.  ``kind`` decides which backend
 * endpoint we hit; everything else is plumbing.  Keeping this a tagged
 * union (rather than two separate components) lets us share the loading,
 * error, and empty states between chapter and site-resource reads.
 */
export type ChapterReaderSource =
  | { kind: 'content'; id: number }
  | { kind: 'resource'; slug: string }
  | { kind: 'intro'; stageNumber: number };

interface ChapterReaderProps {
  source: ChapterReaderSource;
  /** Title shown in the header until the live ``title`` from the manifest arrives. */
  fallbackTitle: string;
  /** Optional chapter controls, rendered as an overlay pinned to the reader's
   *  bottom edge — the content viewer passes its mark-read / reflect actions;
   *  omitted for untracked site resources. Called with whether the essay's end
   *  is in view, so the controls can stay out of the reader's way until there
   *  is nothing left to read. Being an overlay rather than a layout sibling is
   *  what keeps revealing them from moving the fade or reflowing the prose. */
  renderFooter?: (_atEssayEnd: boolean) => React.ReactNode;
  onBack: () => void;
  /** When provided, offers a calm "write a note on a passage" affordance. */
  onWriteNote?: (_passage: WriteNotePassage) => void;
  /** Restores the reading ScrollView to this offset on a warm return. */
  initialScrollOffset?: number;
}

/**
 * Only absolute web links leave the app (via the renderer's default
 * ``Linking.openURL``).  Relative paths in vendored Markdown point inside
 * the content repo — nothing the OS can open — so taps on them are
 * swallowed rather than thrown at the system as broken URLs.
 */
function isExternalWebUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

/**
 * Markdown render rules: drop images whose source is not an absolute web
 * URL.  Vendored chapters may reference repo-relative assets
 * (``assets/diagram.png``); until the media-serving decision in the
 * content epic lands, those cannot resolve on-device, and rendering a
 * broken image placeholder is worse than rendering nothing.  This also
 * doubles as the defensive rendering limit the issue asks for — no
 * arbitrary URI schemes reach the native image loader.
 */
const markdownRules = {
  image: (node: { key?: string; attributes?: { src?: string; alt?: string } }): React.ReactNode => {
    const src = node.attributes?.src ?? '';
    if (!isExternalWebUrl(src)) {
      return null;
    }
    // RN's Image with bounded sizing instead of the library's FitImage
    // (which fetches dimensions eagerly and is flaky under jest).
    return (
      <Image
        key={node.key}
        source={{ uri: src }}
        accessibilityLabel={node.attributes?.alt ?? 'Chapter image'}
        style={markdownStyles.contentImage}
        resizeMode="contain"
      />
    );
  },
  // Render a CommonMark soft break as a space (the library default emits '\n'), so hard-wrapped prose reflows.
  softbreak: (node: { key?: string }): React.ReactNode => <Text key={node.key}> </Text>,
};

interface HeaderProps {
  title: string;
  onBack: () => void;
}

const ReaderHeader = ({ title, onBack }: HeaderProps): React.JSX.Element => (
  <View style={styles.viewerHeader}>
    <TouchableOpacity
      onPress={onBack}
      style={styles.viewerBackButton}
      testID="reader-back-button"
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Text style={styles.viewerBackText}>{'← Back'}</Text>
    </TouchableOpacity>
    <Text style={styles.viewerTitle} numberOfLines={1}>
      {title}
    </Text>
  </View>
);

interface SheetHeaderProps {
  eyebrow: string | undefined;
  title: string;
}

const ReaderSheetHeader = ({ eyebrow, title }: SheetHeaderProps): React.JSX.Element => (
  <>
    {eyebrow !== undefined && (
      <Text testID="reader-sheet-eyebrow" style={styles.readerEyebrow}>
        {eyebrow}
      </Text>
    )}
    <Text testID="reader-sheet-title" style={styles.readerTitle}>
      {title}
    </Text>
  </>
);

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
}

const ErrorView = ({ message, onRetry }: ErrorViewProps): React.JSX.Element => (
  <View style={styles.readerError} testID="reader-error">
    <Text style={styles.readerErrorTitle}>This page couldn’t load right now</Text>
    <Text style={styles.readerErrorSubtitle}>{message}</Text>
    <RetryButton onRetry={onRetry} testID="reader-retry-button" />
  </View>
);

const EmptyView = (): React.JSX.Element => (
  <View style={styles.readerError} testID="reader-empty">
    <Text style={styles.readerErrorTitle}>Nothing here yet</Text>
    <Text style={styles.readerErrorSubtitle}>
      This chapter hasn’t been written yet. Check back soon.
    </Text>
  </View>
);

const READER_ERROR_MESSAGE = 'This chapter couldn’t load right now. Please try again.';

function fetchBody(source: ChapterReaderSource): Promise<ContentBody> {
  switch (source.kind) {
    case 'content':
      return courseApi.contentBody(source.id);
    case 'resource':
      return courseApi.siteResourceBody(source.slug);
    case 'intro':
      return courseApi.stageIntroBody(source.stageNumber);
  }
}

/**
 * Stable primitive identity for a source.  Callers construct ``source`` as a
 * fresh inline literal on every render, so keying the fetch effect on the
 * object by reference re-runs it — and flashes the body back to a spinner — on
 * every parent re-render (e.g. mark-as-read).  Reducing the source to its
 * discriminants lets the effect fire only when the chapter actually changes,
 * and does so inside the hook so no caller can reintroduce the defect.
 */
function sourceKey(source: ChapterReaderSource): string {
  switch (source.kind) {
    case 'content':
      return `content:${source.id}`;
    case 'resource':
      return `resource:${source.slug}`;
    case 'intro':
      return `intro:${source.stageNumber}`;
  }
}

function useContentBody(source: ChapterReaderSource): {
  body: ContentBody | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const [body, setBody] = useState<ContentBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const isMountedRef = useRef(true);
  // Hold the latest ``source`` so the fetch effect can read it without taking
  // the (referentially unstable) object as a dependency — see ``sourceKey``.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const fetchKey = sourceKey(source);

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    isMountedRef.current = true;
    setLoading(true);
    setError(null);
    // The API call omits the explicit token — ``api/index.ts``'s
    // ``request()`` helper falls back to the global ``tokenGetter``
    // (set by ``AuthContext`` at sign-in), so the bearer header is
    // attached automatically.  Same pattern as ``stagesApi.listAll()``
    // and the other "no explicit token" callers in the codebase.
    const promise = fetchBody(sourceRef.current);

    promise
      .then((result) => {
        if (!isMountedRef.current) return;
        setBody(result);
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        setError(READER_ERROR_MESSAGE);
      })
      .finally(() => {
        if (!isMountedRef.current) return;
        setLoading(false);
      });
  }, [fetchKey, refreshKey]);

  const retry = useCallback(() => setRefreshKey((n) => n + 1), []);
  return { body, loading, error, retry };
}

interface PassageSelection {
  selecting: boolean;
  dialogVisible: boolean;
  onScroll: (_event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  beginSelection: () => void;
  cancelSelection: () => void;
  handleSelectionChange: (_span: CodePointSpan) => void;
  openDialog: () => Promise<void>;
  closeDialog: () => void;
  confirmNote: () => void;
}

/**
 * Own the write-note gesture: track the latest scroll offset, snapshot it at the
 * moment the affordance is pressed, hold the emitted code-point span, and slice
 * the passage by code points when the reader confirms.
 */
function usePassageSelection(
  markdown: string,
  sourceTitle: string,
  onWriteNote?: (_passage: WriteNotePassage) => void,
): PassageSelection {
  const [selecting, setSelecting] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [span, setSpan] = useState<CodePointSpan | null>(null);
  const [capturedOffset, setCapturedOffset] = useState(0);
  const scrollOffsetRef = useRef(0);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const beginSelection = useCallback(() => {
    setCapturedOffset(scrollOffsetRef.current);
    setSelecting(true);
  }, []);

  const cancelSelection = useCallback(() => setSelecting(false), []);
  const handleSelectionChange = useCallback((next: CodePointSpan) => setSpan(next), []);
  const openDialog = useCallback(async () => setDialogVisible(true), []);
  const closeDialog = useCallback(() => setDialogVisible(false), []);

  const confirmNote = useCallback(() => {
    if (onWriteNote && span) {
      const text = Array.from(markdown).slice(span.start, span.end).join('');
      onWriteNote({ text, sourceTitle, scrollOffset: capturedOffset });
    }
    setDialogVisible(false);
    setSelecting(false);
  }, [onWriteNote, span, markdown, sourceTitle, capturedOffset]);

  return {
    selecting,
    dialogVisible,
    onScroll,
    beginSelection,
    cancelSelection,
    handleSelectionChange,
    openDialog,
    closeDialog,
    confirmNote,
  };
}

interface EssayEndHandlers {
  onScroll: (_event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout: (_event: LayoutChangeEvent) => void;
  onContentSizeChange: (_width: number, _height: number) => void;
}

/**
 * Report whether the end of the essay is in view.
 *
 * The three numbers that answer that question arrive on three different
 * callbacks — the viewport height on layout, the essay's height on
 * content-size change, the scroll position on scroll — so each is held in a ref
 * and the verdict is recomputed from all three whenever any one of them lands.
 * Until both measurements are real the verdict is withheld: a zero-height
 * reading would compute as "already at the end" and flash the controls on a
 * long essay before its first layout.
 *
 * The verdict is one distance-from-end comparison, which cannot oscillate on a
 * single scroll event: the controls it gates are a pure overlay, so revealing
 * them changes neither the essay's height nor the viewport, and no input to the
 * comparison depends on its output. Hysteresis would only be needed if showing
 * the controls could reflow the content that decides whether to show them.
 *
 * ``hasNoEssay`` short-circuits all of that: an unwritten chapter has no end to
 * scroll to, so its controls are due immediately.
 */
function useEssayEndSignal(
  onEndReachedChange: (_reached: boolean) => void,
  hasNoEssay: boolean,
): EssayEndHandlers {
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);

  useEffect(() => {
    if (hasNoEssay) onEndReachedChange(true);
  }, [hasNoEssay, onEndReachedChange]);

  const report = useCallback(() => {
    const viewport = viewportHeightRef.current;
    const content = contentHeightRef.current;
    if (viewport <= 0 || content <= 0) return;
    const distanceToEnd = content - (scrollOffsetRef.current + viewport);
    onEndReachedChange(distanceToEnd <= READER_CONTROLS_REVEAL_THRESHOLD);
  }, [onEndReachedChange]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
      report();
    },
    [report],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      report();
    },
    [report],
  );

  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      report();
    },
    [report],
  );

  return { onScroll, onLayout, onContentSizeChange };
}

/** Fan one scroll event out to both listeners the reading sheet feeds. */
function useMergedScroll(
  first: (_event: NativeSyntheticEvent<NativeScrollEvent>) => void,
  second: (_event: NativeSyntheticEvent<NativeScrollEvent>) => void,
): (_event: NativeSyntheticEvent<NativeScrollEvent>) => void {
  return useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      first(event);
      second(event);
    },
    [first, second],
  );
}

interface ReadingSheetProps {
  markdown: string;
  eyebrow: string | undefined;
  title: string;
  canWriteNote: boolean;
  initialScrollOffset: number | undefined;
  onScroll: (_event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout: (_event: LayoutChangeEvent) => void;
  onContentSizeChange: (_width: number, _height: number) => void;
  onBeginNote: () => void;
}

/** The reading view: the markdown sheet plus the calm write-note invitation. */
const ReadingSheet = ({
  markdown,
  eyebrow,
  title,
  canWriteNote,
  initialScrollOffset,
  onScroll,
  onLayout,
  onContentSizeChange,
  onBeginNote,
}: ReadingSheetProps): React.JSX.Element => (
  <ScrollView
    style={styles.readerScroll}
    contentContainerStyle={{ paddingBottom: rhythm.bottomFadeHeight }}
    testID="reader-markdown"
    onScroll={onScroll}
    onLayout={onLayout}
    onContentSizeChange={onContentSizeChange}
    scrollEventThrottle={SCROLL_EVENT_THROTTLE}
    contentOffset={initialScrollOffset != null ? { x: 0, y: initialScrollOffset } : undefined}
  >
    <View style={styles.readerSheet}>
      <ReaderSheetHeader eyebrow={eyebrow} title={title} />
      {canWriteNote && (
        <TouchableOpacity
          testID="reader-write-note-affordance"
          onPress={onBeginNote}
          accessibilityRole="button"
          accessibilityLabel={WRITE_NOTE_AFFORDANCE_LABEL}
        >
          <Text style={styles.readerWriteNoteLink}>{WRITE_NOTE_AFFORDANCE_LABEL}</Text>
        </TouchableOpacity>
      )}
      <Markdown style={markdownStyles} rules={markdownRules} onLinkPress={isExternalWebUrl}>
        {markdown}
      </Markdown>
    </View>
  </ScrollView>
);

interface SelectingSheetProps {
  markdown: string;
  eyebrow: string | undefined;
  title: string;
  selection: PassageSelection;
}

/** The selection view: the passage-select surface over the confirm dialog. */
const SelectingSheet = ({
  markdown,
  eyebrow,
  title,
  selection,
}: SelectingSheetProps): React.JSX.Element => (
  <>
    <ScrollView
      style={styles.readerScroll}
      contentContainerStyle={{ paddingBottom: rhythm.bottomFadeHeight }}
    >
      <View style={styles.readerSheet}>
        <ReaderSheetHeader eyebrow={eyebrow} title={title} />
        <QuoteSelectionSurface
          body={markdown}
          testID={PASSAGE_SELECT_TEST_ID}
          confirmLabel={WRITE_NOTE_CONFIRM_LABEL}
          onSelectionChange={selection.handleSelectionChange}
          onCancel={selection.cancelSelection}
          onConfirm={selection.openDialog}
        />
      </View>
    </ScrollView>
    <ConfirmDialog
      visible={selection.dialogVisible}
      testID="write-note-dialog"
      title={WRITE_NOTE_DIALOG_TITLE}
      message={WRITE_NOTE_DIALOG_MESSAGE}
      cancelLabel={WRITE_NOTE_DIALOG_CANCEL}
      cancelTestID="write-note-dialog-cancel"
      confirmLabel={WRITE_NOTE_CONFIRM_LABEL}
      confirmTestID="write-note-dialog-confirm"
      onCancel={selection.closeDialog}
      onConfirm={selection.confirmNote}
    />
  </>
);

interface ReaderBodyProps {
  body: ContentBody;
  onWriteNote?: (_passage: WriteNotePassage) => void;
  initialScrollOffset?: number;
  /** Told whether the essay's end is in view, so the reader can offer its
   *  chapter controls only once there is nothing left to read. */
  onEndReachedChange: (_reached: boolean) => void;
}

/** Renders the loaded body: empty notice, reading sheet, or selection surface. */
const ReaderBody = ({
  body,
  onWriteNote,
  initialScrollOffset,
  onEndReachedChange,
}: ReaderBodyProps): React.JSX.Element => {
  const markdown = useMemo(
    () => stripLeadingTitleHeading(body.body_markdown, body.title),
    [body.body_markdown, body.title],
  );
  const selection = usePassageSelection(markdown, body.title, onWriteNote);
  const eyebrow = READER_EYEBROWS[body.content_type];
  const isEmpty = markdown.trim() === '';
  const essayEnd = useEssayEndSignal(onEndReachedChange, isEmpty);
  const handleScroll = useMergedScroll(selection.onScroll, essayEnd.onScroll);

  if (isEmpty) {
    return <EmptyView />;
  }

  return (
    <View style={styles.readerScrollRegion}>
      {selection.selecting ? (
        <SelectingSheet
          markdown={markdown}
          eyebrow={eyebrow}
          title={body.title}
          selection={selection}
        />
      ) : (
        <ReadingSheet
          markdown={markdown}
          eyebrow={eyebrow}
          title={body.title}
          canWriteNote={onWriteNote != null}
          initialScrollOffset={initialScrollOffset}
          onScroll={handleScroll}
          onLayout={essayEnd.onLayout}
          onContentSizeChange={essayEnd.onContentSizeChange}
          onBeginNote={selection.beginSelection}
        />
      )}
      {/* The veil covers the reading sheet for all but the last inch of the
          scroll, so the sheet's own ground is the only color it can honestly
          resolve to; fading toward the desk behind the sheet printed a band of
          a color that was nowhere under the text. */}
      <BottomFade color={surface.canvas} testID="reader-bottom-fade" />
    </View>
  );
};

interface ChapterControls {
  revealed: boolean;
  onEndReachedChange: (_reached: boolean) => void;
}

/**
 * Whether the chapter controls are due.
 *
 * They are due once the reader has reached the end of the essay — and also on a
 * chapter that failed to load, which has no end to reach and where these
 * controls are the only way out. While a chapter is still loading they stay
 * away, so navigating Next re-arms the reveal rather than letting the incoming
 * essay inherit the outgoing one's "the reader is at the end".
 */
function useChapterControls(
  fetchKey: string,
  loading: boolean,
  error: string | null,
): ChapterControls {
  const [atEssayEnd, setAtEssayEnd] = useState(false);
  useEffect(() => {
    setAtEssayEnd(false);
  }, [fetchKey]);
  const failedToLoad = !loading && error !== null;
  return { revealed: atEssayEnd || failedToLoad, onEndReachedChange: setAtEssayEnd };
}

interface ReaderContentProps {
  body: ContentBody | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  onWriteNote?: (_passage: WriteNotePassage) => void;
  initialScrollOffset?: number;
  onEndReachedChange: (_reached: boolean) => void;
}

/** The reader's one live region: spinner, error, or the loaded body. */
const ReaderContent = ({
  body,
  loading,
  error,
  retry,
  onWriteNote,
  initialScrollOffset,
  onEndReachedChange,
}: ReaderContentProps): React.JSX.Element | null => {
  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator testID="reader-loading" size="large" color={colors.text.secondary} />
      </View>
    );
  }
  if (error !== null) {
    return <ErrorView message={error} onRetry={retry} />;
  }
  if (body === null) {
    return null;
  }
  return (
    <ReaderBody
      body={body}
      onWriteNote={onWriteNote}
      initialScrollOffset={initialScrollOffset}
      onEndReachedChange={onEndReachedChange}
    />
  );
};

const ChapterReader = ({
  source,
  fallbackTitle,
  renderFooter,
  onBack,
  onWriteNote,
  initialScrollOffset,
}: ChapterReaderProps): React.JSX.Element => {
  const { body, loading, error, retry } = useContentBody(source);
  const controls = useChapterControls(sourceKey(source), loading, error);

  return (
    <View style={styles.viewerContainer} testID="chapter-reader">
      <ReaderHeader title={body?.title || fallbackTitle} onBack={onBack} />
      <ReaderContent
        body={body}
        loading={loading}
        error={error}
        retry={retry}
        onWriteNote={onWriteNote}
        initialScrollOffset={initialScrollOffset}
        onEndReachedChange={controls.onEndReachedChange}
      />
      {renderFooter !== undefined && (
        <View pointerEvents="box-none" style={styles.readerFooterOverlay}>
          {renderFooter(controls.revealed)}
        </View>
      )}
    </View>
  );
};

export default ChapterReader;
