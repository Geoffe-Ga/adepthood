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

/**
 * What the surface says: the standing instruction. (The empty-tap hint went
 * with the footer confirm it answered for; the pill only appears once a
 * passage is chosen, so there is no empty tap left to answer.)
 */
export interface SelectionSurfaceCopy {
  instruction: string;
}

const NATIVE_COPY: SelectionSurfaceCopy = {
  instruction: 'Touch and hold a passage, then drag to choose it.',
};

const WEB_COPY: SelectionSurfaceCopy = {
  instruction:
    'Select a passage — drag across it with the mouse, double-click a word, ' +
    'or hold Shift and use the arrow keys.',
};

/** The instruction for ``platform``; web speaks to a pointer and keyboard. */
export const buildSelectionSurfaceCopy = (
  platform: SelectionSurfacePlatform,
): SelectionSurfaceCopy => (platform === 'web' ? WEB_COPY : NATIVE_COPY);
