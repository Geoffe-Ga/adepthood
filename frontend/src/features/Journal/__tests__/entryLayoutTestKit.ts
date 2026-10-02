/**
 * Shared layout helpers for the ``JournalEntryScreen`` control-home specs
 * (#3002, #3004): the widths every home is pinned at, a window-width spy that
 * outlives an async render, and the exit row's control order.
 */
import { jest } from '@jest/globals';
import { within } from '@testing-library/react-native';

/** A phone held upright: the narrow, stacked layout. */
export const PHONE_WIDTH = 390;

/** A laptop window: the side-by-side layout with the margin beside the page. */
export const DESKTOP_WIDTH = 1024;

/** Every width a control's home is pinned at, as ``it.each`` rows. */
export const ENTRY_WIDTHS = [{ width: PHONE_WIDTH }, { width: DESKTOP_WIDTH }] as const;

/** The window height the width spies report; tall enough that no width test scrolls. */
const SPY_HEIGHT = 800;

/**
 * Report ``width`` from ``useWindowDimensions`` until the returned restore runs.
 *
 * Call the restore only after ``unmount()``: an async render whose effects are
 * still settling would otherwise re-render at the real width and pass a narrow
 * case at the default one.
 */
export function spyWidth(width: number): () => void {
  const rn = require('react-native');
  const spy = jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width, height: SPY_HEIGHT, scale: 1, fontScale: 1 });
  return () => spy.mockRestore();
}

/** The exit row's buttons, in the order a screen reader and the Tab key meet them. */
export function exitRowOrder(exitRow: Parameters<typeof within>[0]): string[] {
  return within(exitRow)
    .getAllByRole('button')
    .map((b) => String(b.props.testID));
}
