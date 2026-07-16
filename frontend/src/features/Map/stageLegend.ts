// frontend/features/Map/stageLegend.ts

/**
 * Accessibility-label helpers for the Map surfaces. A grid node reads as its
 * persona, descriptor, and a wheel-of-wholeness balance suffix; a header-drawer
 * row reads as its category and Aspect plus current/locked markers. Pure
 * functions — no React.
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

/** Drawer-row a11y label: "Category, Aspect" plus current/locked markers. */
export const drawerStageLabel = (
  category: string,
  aspect: string,
  opts: { locked: boolean; current: boolean },
): string => {
  const base = aspect ? `${category}, ${aspect}` : category;
  const suffix = (opts.current ? ', current' : '') + (opts.locked ? ', locked' : '');
  return base + suffix;
};
