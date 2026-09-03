import { Platform } from 'react-native';

import { accent, colors } from '@/design/tokens';

export const WEB_SELECTION_STYLE_ID = 'candle-ink-selection';
export const WEB_SELECTION_CSS = `::selection { background: ${colors.paper.anchorHighlight}; color: ${colors.paper.ink}; } input::selection, textarea::selection { background: ${accent.primary}; color: ${accent.onPrimary}; }`;

interface StyleElement {
  id: string;
  textContent: string | null;
}

interface SelectionDocument {
  getElementById: (_id: string) => StyleElement | null;
  createElement: (_tag: string) => StyleElement;
  head: { appendChild: (_element: StyleElement) => unknown };
}

/** Install the warm selection wash once on web; native uses TextInput's selectionColor. */
export function applyWebSelectionTheme(doc?: SelectionDocument): void {
  if (Platform.OS !== 'web') return;
  const target =
    doc ??
    (typeof document === 'undefined' ? undefined : (document as unknown as SelectionDocument));
  if (target == null || target.getElementById(WEB_SELECTION_STYLE_ID) != null) return;
  const style = target.createElement('style');
  style.id = WEB_SELECTION_STYLE_ID;
  style.textContent = WEB_SELECTION_CSS;
  target.head.appendChild(style);
}
