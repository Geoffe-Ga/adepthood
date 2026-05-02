import { Platform } from 'react-native';

/**
 * Viewport directive used to suppress iOS Safari's auto-zoom on input
 * focus. The default Expo HTML template emits ``initial-scale=1,
 * shrink-to-fit=no`` but no ``maximum-scale``, so iOS zooms into any
 * ``<input>`` whose ``font-size`` is below 16px — which Adepthood's
 * responsive typography always is on narrow viewports. Pinning
 * ``maximum-scale=1`` mirrors the focus-without-reflow behaviour of a
 * native app.
 */
export const LOCKED_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';

interface ViewportTargetDocument {
  querySelector: (
    selector: string,
  ) => { setAttribute: (name: string, value: string) => void } | null;
  createElement: (tag: string) => { setAttribute: (name: string, value: string) => void };
  head: { appendChild: (el: unknown) => unknown };
}

function resolveDocument(injected?: ViewportTargetDocument): ViewportTargetDocument | undefined {
  if (injected) return injected;
  if (typeof document === 'undefined') return undefined;
  return document as unknown as ViewportTargetDocument;
}

/**
 * Lock the web viewport so the browser cannot auto-zoom into a focused
 * field. Web-only (no-op on iOS/Android native, where the viewport tag
 * does not apply). The optional ``doc`` argument is for tests; production
 * callers pass nothing and the function reads the real ``document``.
 */
export function applyWebViewportLock(doc?: ViewportTargetDocument): void {
  if (Platform.OS !== 'web') return;
  const target = resolveDocument(doc);
  if (!target) return;

  let viewport = target.querySelector('meta[name="viewport"]');
  if (!viewport) {
    viewport = target.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    target.head.appendChild(viewport);
  }
  viewport.setAttribute('content', LOCKED_VIEWPORT_CONTENT);
}
