/**
 * Web-only bridge for the quote-selection surface. react-native-web 0.21.2
 * wires TextInput.onSelectionChange to React's onSelect
 * (``react-native-web/dist/exports/TextInput/index.js``), and Chromium fires
 * that ``select`` event when a mouse drag or a double-click completes and on
 * every Shift+Arrow keystroke that extends the span (verified in a real
 * browser for #2652). iOS Safari never
 * synthesizes it for native long-press selection-handle drags inside a
 * textarea, so on web we also subscribe to the document 'selectionchange'
 * event and read the host textarea's selection directly. Accepted trade-off:
 * a document-wide event may re-emit the textarea's persisted span, but
 * emitSpan is idempotent.
 */
import { useEffect, type RefObject } from 'react';
import { Platform, type TextInput } from 'react-native';

/** The DOM host node a react-native-web TextInput exposes on web. */
interface SelectableTextNode {
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

/**
 * Subscribe to document 'selectionchange' on web and emit the host textarea's
 * raw UTF-16 selection. No-op off web and when the DOM is unavailable; the
 * caller's emitSpan owns the UTF-16 to code-point conversion.
 */
export function useWebSelectionListener(
  nodeRef: RefObject<TextInput | null>,
  emitSpan: (startUtf16: number, endUtf16: number) => void,
): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (Platform.OS !== 'web') return undefined;

    const read = (): void => {
      const node = nodeRef.current as unknown as SelectableTextNode | null;
      if (node === null) return;
      const start = node.selectionStart;
      const end = node.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number') {
        emitSpan(start, end);
      }
    };

    // Capture the document rather than re-resolving the global in the cleanup.
    // The guard above only covers mount: a cleanup that reaches for `document`
    // runs at teardown, by which point the DOM may be gone, and the bare global
    // then throws a ReferenceError instead of quietly no-opping. React 19 runs
    // effect cleanups where 18 did not, which is what surfaced this -- the hole
    // was always here.
    const doc = document;
    doc.addEventListener('selectionchange', read);
    return () => doc.removeEventListener('selectionchange', read);
  }, [emitSpan, nodeRef]);
}

/** The DOM textarea method a react-native-web TextInput host node carries. */
interface RangeSelectableNode {
  setSelectionRange?: (start: number, end: number) => void;
}

/**
 * Put the field's own selection on ``span`` (UTF-16) once, as it mounts, so a
 * passage chosen before the surface opened (a Course deep link, #3659, or the
 * sources panel remounting mid-selection) is drawn selected rather than only
 * echoed in the preview -- and, on the web, so the document's next
 * 'selectionchange' reads that passage back instead of collapsing it to the
 * caret. Imperative and one-shot: a ``selection`` prop would make the field
 * controlled and snap every later drag back to this span.
 */
export function useInitialFieldSelection(
  nodeRef: RefObject<TextInput | null>,
  span: { start: number; end: number } | null,
): void {
  useEffect(() => {
    const node = nodeRef.current;
    if (node === null || span === null || span.end <= span.start) return;
    if (Platform.OS === 'web') {
      (node as unknown as RangeSelectableNode).setSelectionRange?.(span.start, span.end);
    } else if (typeof node.setSelection === 'function') {
      node.setSelection(span.start, span.end);
    }
  }, [nodeRef, span]);
}
