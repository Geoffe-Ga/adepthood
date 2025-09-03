// Pixel dimensions governing the fixed-size web emoji picker.
// Keeping these centralized avoids magic numbers sprinkled through the component.
export const PANEL_WIDTH = 420;
export const PANEL_PADDING = 8;
export const GRID_CELL = 48;
export const GRID_GAP = 8;
export const GLYPH_SIZE = 32;
export const VISIBLE_ROWS = 4;

// Derived constants
export const NUM_COLUMNS = Math.floor(
  (PANEL_WIDTH - PANEL_PADDING * 2 + GRID_GAP) / (GRID_CELL + GRID_GAP),
);
export const GRID_HEIGHT =
  VISIBLE_ROWS * GRID_CELL + (VISIBLE_ROWS - 1) * GRID_GAP;
export const HEADER_HEIGHT = 56;
export const CATEGORY_HEIGHT = 56;
export const PANEL_HEIGHT = HEADER_HEIGHT + CATEGORY_HEIGHT + GRID_HEIGHT;
