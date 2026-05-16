import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { course as courseApi, type ContentBody } from '../../api';
import { colors } from '../../design/tokens';

import styles from './Course.styles';

/**
 * Source descriptor for the reader.  ``kind`` decides which backend
 * endpoint we hit; everything else is plumbing.  Keeping this a tagged
 * union (rather than two separate components) lets us share the loading,
 * error, and HTML-wrapping logic between chapter and site-resource reads.
 */
export type ChapterReaderSource =
  | { kind: 'content'; id: number }
  | { kind: 'resource'; slug: string };

interface ChapterReaderProps {
  source: ChapterReaderSource;
  /** Title shown in the header until the live ``title`` from the CMS arrives. */
  fallbackTitle: string;
  /** Render no footer — used for site resources, which aren't tracked. */
  footer?: React.ReactNode;
  onBack: () => void;
}

/**
 * Wrap the backend's article HTML in a complete document with mobile-
 * sane typography.  Keeping this client-side means we don't pay for a
 * second backend round-trip just to render the same chrome on every
 * chapter.
 */
function buildDocument(bodyHtml: string): string {
  const styleBlock = `
    :root { color-scheme: light dark; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 17px;
      line-height: 1.55;
      color: #1a1910;
      background: #fffaf0;
      padding: 18px 18px 56px;
    }
    h1, h2, h3 { line-height: 1.25; }
    h1 { font-size: 1.6rem; margin-top: 0.4em; }
    h2 { font-size: 1.3rem; }
    h3 { font-size: 1.1rem; }
    p { margin: 0.9em 0; }
    img, video, iframe { max-width: 100%; height: auto; border-radius: 8px; }
    blockquote {
      margin: 1em 0;
      padding: 0 1em;
      border-left: 3px solid #b8a373;
      color: #413d2f;
      font-style: italic;
    }
    a { color: #6f4e1f; }
    pre, code {
      background: #f0e6d2;
      border-radius: 6px;
      padding: 0.1em 0.4em;
      font-size: 0.92em;
    }
    pre { padding: 12px; overflow-x: auto; }
    @media (prefers-color-scheme: dark) {
      body { color: #f0e6d2; background: #1a1910; }
      pre, code { background: #2a2a2a; color: #f0e6d2; }
      blockquote { color: #c4c2b8; border-left-color: #8a7a52; }
      a { color: #d4b878; }
    }
  `;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
  <style>${styleBlock}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

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
  <View style={styles.webviewError} testID="reader-error">
    <Text style={styles.webviewErrorTitle}>This page couldn’t load right now</Text>
    <Text style={styles.webviewErrorSubtitle}>{message}</Text>
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

const CMS_AUTH_DETAIL = 'cms_auth_failed';
const CMS_UNAVAILABLE_DETAIL = 'cms_unavailable';

/**
 * URL scheme prefixes that we let the WebView load in-frame.  The WebView's
 * ``source={{ html }}`` boots at ``about:blank``; ``data:`` is used by some
 * RN platforms while wiring the document.  Everything else (links inside
 * a chapter, embedded forms, etc.) is handed off to the system browser via
 * ``Linking.openURL`` so the user is never silently navigated away inside
 * the in-app reader.  This is the mitigation for the broad
 * ``originWhitelist={['*']}`` we still pass — required for the inline HTML
 * to render at all on web/iOS, but dangerous on its own without this guard.
 */
const _IN_FRAME_URL_PREFIXES = ['about:', 'data:', 'file:'] as const;

function shouldLoadInWebView(request: ShouldStartLoadRequest): boolean {
  const { url } = request;
  if (_IN_FRAME_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  // Hand the navigation to the OS — the system browser can authenticate
  // the user against Squarespace separately if the link points back to
  // the site, and external links open as the user expects.
  void Linking.openURL(url).catch((err) => {
    console.warn('Failed to open URL from chapter:', err);
  });
  return false;
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'detail' in err) {
    const detail = (err as { detail: unknown }).detail;
    if (detail === CMS_AUTH_DETAIL) {
      return 'The course site password is not set on the server. Reach out so we can fix it.';
    }
    if (detail === CMS_UNAVAILABLE_DETAIL) {
      return 'The course site is temporarily unreachable. Please try again in a moment.';
    }
  }
  return 'Something went wrong reaching the course site. Please try again.';
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
    const promise =
      source.kind === 'content'
        ? courseApi.contentBody(source.id)
        : courseApi.siteResourceBody(source.slug);

    promise
      .then((result) => {
        if (!isMountedRef.current) return;
        setBody(result);
      })
      .catch((err: unknown) => {
        if (!isMountedRef.current) return;
        setError(describeError(err));
      })
      .finally(() => {
        if (!isMountedRef.current) return;
        setLoading(false);
      });
  }, [source, refreshKey]);

  const retry = useCallback(() => setRefreshKey((n) => n + 1), []);
  return { body, loading, error, retry };
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
      {!loading && error === null && body !== null && (
        <WebView
          testID="reader-webview"
          source={{ html: buildDocument(body.body_html) }}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={shouldLoadInWebView}
          style={styles.webview}
          accessibilityLabel={headerTitle}
        />
      )}
      {footer}
    </View>
  );
};

export default ChapterReader;
