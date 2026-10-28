/** Web-only navigation within the journal's single scroll surface. */
import { SPACING } from '@/design/tokens';

interface Target {
  getBoundingClientRect: () => { top: number };
}
export interface MarginNavigationRoot {
  querySelector: (_selector: string) => Target | null;
}
export interface MarginNavigationScroller {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => { top: number };
  scroll: (_options: { top: number; behavior: 'auto' | 'smooth' }) => void;
  addEventListener: (_type: string, _listener: () => void, _options: { once: true }) => void;
  removeEventListener: (_type: string, _listener: () => void) => void;
}
export function isNavigationRoot(node: unknown): node is MarginNavigationRoot {
  return node != null && typeof node === 'object' && 'querySelector' in node;
}
export function isNavigationScroller(node: unknown): node is MarginNavigationScroller {
  return (
    node != null &&
    typeof node === 'object' &&
    'scroll' in node &&
    'getBoundingClientRect' in node &&
    'addEventListener' in node &&
    'removeEventListener' in node &&
    'scrollTop' in node
  );
}
/** Only a deliberate action scrolls. Cancel a late continuation on a new selection. */
export function revealMarginTarget(
  root: MarginNavigationRoot,
  scroll: MarginNavigationScroller,
  targetId: string,
  reducedMotion: boolean,
  onReached: () => void,
): (() => void) | null {
  const target = root.querySelector(`[data-testid="${targetId}"]`);
  if (target == null) return null;
  const targetTop =
    scroll.scrollTop +
    target.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top -
    SPACING.xl;
  if (!Number.isFinite(targetTop)) return null;
  const top = Math.max(0, Math.min(targetTop, scroll.scrollHeight - scroll.clientHeight));
  let active = true;
  const cancel = (): void => {
    active = false;
    scroll.removeEventListener('scrollend', reached);
  };
  const reached = (): void => {
    if (!active) return;
    cancel();
    // An interrupted smooth scroll also emits scrollend; it did not reach the chosen note.
    if (Math.abs(scroll.scrollTop - top) <= 1) onReached();
  };
  const immediate = reducedMotion || Math.abs(top - scroll.scrollTop) < 1;
  if (!immediate) scroll.addEventListener('scrollend', reached, { once: true });
  // RN Web replaces scrollTo with its {x,y,animated} API; scroll remains the DOM method.
  scroll.scroll({ top, behavior: immediate ? 'auto' : 'smooth' });
  if (immediate) reached();
  return cancel;
}
