// frontend/features/Map/stageLegend.ts

/**
 * Accessibility-label helpers shared by the Map grid and its header drawer. A
 * stage node reads as its persona, descriptor, and a wheel-of-wholeness balance
 * suffix, so both surfaces announce the same label. Pure functions — no React.
 */

import type { StageDisplay } from './mapLayout';
import { FULLNESS_ALIVE_THRESHOLD } from './wheelBalance';

/** Fallback fullness for a stage with no wheel reading; it announces as thin. */
export const THIN_FULLNESS = 0;

/** Accessibility suffix appended to a node's label from its wheel fullness. */
export const balanceLabelSuffix = (fullness: number): string =>
  fullness >= FULLNESS_ALIVE_THRESHOLD ? 'reads full' : 'reads thin';

/** Full a11y label for a stage node: persona/descriptor plus the balance read. */
export const stageNodeLabel = (display: StageDisplay, fullness: number): string =>
  `${display.persona} - ${display.descriptor} - ${balanceLabelSuffix(fullness)}`;
