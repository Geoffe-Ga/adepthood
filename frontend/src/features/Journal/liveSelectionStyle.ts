/**
 * The body field's selection highlight while the live mirror is on (web).
 *
 * The mirror draws the styled text BEHIND a textarea whose glyph fill is
 * transparent. A browser's default selection highlight is opaque, so it would
 * paint over the mirror's glyphs and make selected text vanish. This rule
 * gives the field's ``::selection`` a see-through tint of the caret token
 * instead, and keeps the selected glyph fill transparent, so the selected
 * words stay readable through the highlight.
 *
 * ``::selection`` cannot be expressed as a React Native style, so the rule is
 * one ``<style>`` element added to the document once, keyed by an id.
 */
import { writingField } from '@/design/tokens';

/** Opacity of the selection tint over the mirror's glyphs. */
export const LIVE_SELECTION_ALPHA = 0.3;

/** The id of the one ``<style>`` element this installs. */
export const LIVE_SELECTION_STYLE_ID = 'journal-live-selection';

/** The body field, as react-native-web renders its testID. */
const FIELD_SELECTOR = '[data-testid="journal-body-input"]';

interface StyleNode {
  id: string;
  textContent: string | null;
}

interface StyleDocument {
  head?: { appendChild: (node: StyleNode) => unknown };
  getElementById?: (id: string) => unknown;
  createElement?: (tag: string) => StyleNode;
}

/** ``#rrggbb`` as ``r, g, b``. */
function channels(hex: string): string {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(', ');
}

/** The CSS rule for the field's selection. */
export function liveSelectionCss(): string {
  const tint = `rgba(${channels(writingField.caret)}, ${LIVE_SELECTION_ALPHA})`;
  return `${FIELD_SELECTOR}::selection{background-color:${tint};-webkit-text-fill-color:transparent;}`;
}

/** Add the rule to the document once; false where there is no DOM to add it to. */
export function installLiveSelectionStyle(): boolean {
  const doc = (globalThis as { document?: StyleDocument }).document;
  if (doc?.head == null || doc.getElementById == null || doc.createElement == null) return false;
  if (doc.getElementById(LIVE_SELECTION_STYLE_ID) != null) return true;
  const node = doc.createElement('style');
  node.id = LIVE_SELECTION_STYLE_ID;
  node.textContent = liveSelectionCss();
  doc.head.appendChild(node);
  return true;
}
