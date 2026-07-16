/**
 * Web-only bridge for the quote-selection surface. react-native-web 0.19.13
 * wires TextInput.onSelectionChange to React's onSelect, which iOS Safari never
 * synthesizes for native long-press selection-handle drags inside a textarea.
 * On web we subscribe to the document 'selectionchange' event and read the host
 * textarea's selection directly. Accepted trade-off: a document-wide event may
 * re-emit the textarea's persisted span, but emitSpan is idempotent.
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
  nodeRef: RefObject<TextInput>,
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

    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [emitSpan, nodeRef]);
}
