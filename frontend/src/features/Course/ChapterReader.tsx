import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Markdown from 'react-native-markdown-display';

import { course as courseApi, type ContentBody } from '../../api';
import { colors, SPACING } from '../../design/tokens';

import styles, { markdownStyles } from './Course.styles';

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
  /** Render no footer — used for site resources, which aren't tracked. */
  footer?: React.ReactNode;
  onBack: () => void;
}

/**
 * Only absolute web links leave the app (via the renderer's default
 * ``Linking.openURL``).  Relative paths in vendored Markdown point inside
 * the content repo — nothing the OS can open — so taps on them are
 * swallowed rather than thrown at the system as broken URLs.
 */
function handleLinkPress(url: string): boolean {
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
    if (!handleLinkPress(src)) {
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

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
}

const ErrorView = ({ message, onRetry }: ErrorViewProps): React.JSX.Element => (
  <View style={styles.readerError} testID="reader-error">
    <Text style={styles.readerErrorTitle}>This page couldn’t load right now</Text>
    <Text style={styles.readerErrorSubtitle}>{message}</Text>
    <TouchableOpacity
      onPress={onRetry}
      style={styles.retryButton}
      testID="reader-retry-button"
      accessibilityRole="button"
      accessibilityLabel="Try again"
    >
      <Text style={styles.retryText}>Try Again</Text>
    </TouchableOpacity>
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

function describeError(): string {
  return 'This chapter couldn’t load right now. Please try again.';
}

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
    // attached automatically.  Same pattern as ``stagesApi.list()``
    // and the other "no explicit token" callers in the codebase.
    const promise = fetchBody(source);

    promise
      .then((result) => {
        if (!isMountedRef.current) return;
        setBody(result);
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        setError(describeError());
      })
      .finally(() => {
        if (!isMountedRef.current) return;
        setLoading(false);
      });
  }, [source, refreshKey]);

  const retry = useCallback(() => setRefreshKey((n) => n + 1), []);
  return { body, loading, error, retry };
}

function renderBody(body: ContentBody): React.ReactElement {
  if (body.body_markdown.trim() === '') {
    return <EmptyView />;
  }
  return (
    <ScrollView
      style={styles.readerScroll}
      contentContainerStyle={{ paddingBottom: SPACING.xxl }}
      testID="reader-markdown"
    >
      <Markdown style={markdownStyles} rules={markdownRules} onLinkPress={handleLinkPress}>
        {body.body_markdown}
      </Markdown>
    </ScrollView>
  );
}

const ChapterReader = ({
  source,
  fallbackTitle,
  footer,
  onBack,
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
      {!loading && error === null && body !== null && renderBody(body)}
      {footer}
    </View>
  );
};

export default ChapterReader;
