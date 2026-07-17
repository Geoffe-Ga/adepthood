import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
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
  /** Optional footer rendered below the body — the content viewer passes its
   *  mark-read / reflect actions; omitted for untracked site resources. */
  footer?: React.ReactNode;
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

interface ReadingSheetProps {
  markdown: string;
  eyebrow: string | undefined;
  title: string;
  canWriteNote: boolean;
  initialScrollOffset: number | undefined;
  onScroll: (_event: NativeSyntheticEvent<NativeScrollEvent>) => void;
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
  onBeginNote,
}: ReadingSheetProps): React.JSX.Element => (
  <ScrollView
    style={styles.readerScroll}
    contentContainerStyle={{ paddingBottom: rhythm.bottomFadeHeight }}
    testID="reader-markdown"
    onScroll={onScroll}
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
}

/** Renders the loaded body: empty notice, reading sheet, or selection surface. */
const ReaderBody = ({
  body,
  onWriteNote,
  initialScrollOffset,
}: ReaderBodyProps): React.JSX.Element => {
  const markdown = useMemo(
    () => stripLeadingTitleHeading(body.body_markdown, body.title),
    [body.body_markdown, body.title],
  );
  const selection = usePassageSelection(markdown, body.title, onWriteNote);
  const eyebrow = READER_EYEBROWS[body.content_type];

  if (markdown.trim() === '') {
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
          onScroll={selection.onScroll}
          onBeginNote={selection.beginSelection}
        />
      )}
      <BottomFade color={surface.desk} testID="reader-bottom-fade" />
    </View>
  );
};

const ChapterReader = ({
  source,
  fallbackTitle,
  footer,
  onBack,
  onWriteNote,
  initialScrollOffset,
}: ChapterReaderProps): React.JSX.Element => {
  const { body, loading, error, retry } = useContentBody(source);
  const headerTitle = body?.title || fallbackTitle;

  return (
    <View style={styles.viewerContainer} testID="chapter-reader">
      <ReaderHeader title={headerTitle} onBack={onBack} />
      {loading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator testID="reader-loading" size="large" color={colors.text.secondary} />
        </View>
      )}
      {!loading && error !== null && <ErrorView message={error} onRetry={retry} />}
      {!loading && error === null && body !== null && (
        <ReaderBody
          body={body}
          onWriteNote={onWriteNote}
          initialScrollOffset={initialScrollOffset}
        />
      )}
      {footer}
    </View>
  );
};

export default ChapterReader;
