import { breakpoints } from '@/design/tokens';

/** How the inbox arranges its list and the open report. */
export type TriageLayout = 'split' | 'stacked';

/**
 * Side by side from the large breakpoint up, one above the other below it.
 *
 * Inclusive at the breakpoint, the way the rest of the design system reads
 * ``breakpoints``: a window exactly ``lg`` wide has the room the split needs.
 */
export function triageLayoutFor(width: number): TriageLayout {
  return width >= breakpoints.lg ? 'split' : 'stacked';
}
