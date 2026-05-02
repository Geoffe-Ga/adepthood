import { Platform } from 'react-native';

// ``maximum-scale=1`` is the only directive that suppresses iOS Safari's
// auto-zoom on inputs whose font-size is < 16px. Trade-off: it also blocks
// user pinch-zoom on Android Chrome/Firefox (WCAG 1.4.4) — accepted because
// product asked for native-app focus behaviour, no reflow on focus.
export const LOCKED_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';

interface ViewportTargetDocument {
  querySelector: (
    selector: string,
  ) => { setAttribute: (name: string, value: string) => void } | null;
  createElement: (tag: string) => { setAttribute: (name: string, value: string) => void };
  head: { appendChild: (el: unknown) => unknown };
}

export function applyWebViewportLock(doc?: ViewportTargetDocument): void {
  if (Platform.OS !== 'web') return;
  const target =
    doc ??
    (typeof document === 'undefined' ? undefined : (document as unknown as ViewportTargetDocument));
  if (!target) return;

  let viewport = target.querySelector('meta[name="viewport"]');
  if (!viewport) {
    viewport = target.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    target.head.appendChild(viewport);
  }
  viewport.setAttribute('content', LOCKED_VIEWPORT_CONTENT);
}
