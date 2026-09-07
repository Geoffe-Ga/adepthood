/**
 * Platform-appropriate instruction copy for the quote-selection surface.
 *
 * The surface guides one gesture, but the gesture differs by platform: a phone
 * selects text with a long press and a drag of the handles, a desktop browser
 * with a mouse drag, a double-click, or Shift and the arrow keys. Telling a
 * mouse-and-keyboard reader to "touch and hold" describes a gesture their
 * pointer cannot make (#2652), so the wording is resolved from the running
 * platform here, beside the surface, following ``readingSurfaceStyles.ts``.
 *
 * Resolved from ``Platform.OS`` rather than ``Platform.select`` to match the
 * repo's convention (the hand-rolled react-native test mocks expose only
 * ``Platform.OS``).
 */
import type { Platform } from 'react-native';

type SelectionSurfacePlatform = typeof Platform.OS;

/** The two lines the surface speaks: the standing instruction and the empty-tap hint. */
export interface SelectionSurfaceCopy {
  instruction: string;
  emptyHint: string;
}

const NATIVE_COPY: SelectionSurfaceCopy = {
  instruction: 'Touch and hold a passage, then drag to choose it.',
  emptyHint: 'Choose a passage first — touch and hold the text.',
};

const WEB_COPY: SelectionSurfaceCopy = {
  instruction:
    'Select a passage — drag across it with the mouse, double-click a word, ' +
    'or hold Shift and use the arrow keys.',
  emptyHint: 'Choose a passage first — select some of the text above.',
};

/** The instruction and empty hint for ``platform``; web speaks to a pointer and keyboard. */
export const buildSelectionSurfaceCopy = (
  platform: SelectionSurfacePlatform,
): SelectionSurfaceCopy => (platform === 'web' ? WEB_COPY : NATIVE_COPY);
