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

/** Whether a stage is the one being lived, and whether it is still shut. */
export interface StageState {
  locked: boolean;
  current: boolean;
}

/**
 * The current/locked markers every Map label ends with.
 *
 * One helper for all three surfaces because the grid used to omit these while
 * rendering a padlock: the state was on screen and absent from the label, so a
 * screen reader could not tell a shut stage from an open one. Ordered current
 * before locked, which is the order the drawer already read in.
 */
export const stateLabelSuffix = (state: StageState): string =>
  (state.current ? ', current' : '') + (state.locked ? ', locked' : '');

/** Full a11y label for a stage node: persona/descriptor, the balance read, then state. */
export const stageNodeLabel = (
  display: StageDisplay,
  fullness: number,
  state: StageState,
): string =>
  `${display.persona} - ${display.descriptor} - ${balanceLabelSuffix(fullness)}` +
  stateLabelSuffix(state);

/** Centre-cell a11y label: the stage's own title and subtitle, then state. */
export const stageCenterCellLabel = (title: string, subtitle: string, state: StageState): string =>
  `${title} - ${subtitle}${stateLabelSuffix(state)}`;

/** Drawer-row a11y label: "Category, Aspect" plus current/locked markers. */
export const drawerStageLabel = (category: string, aspect: string, state: StageState): string =>
  (aspect ? `${category}, ${aspect}` : category) + stateLabelSuffix(state);
