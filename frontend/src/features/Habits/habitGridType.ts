/**
 * The Habits grid's text sizes, set on the app type ramp (#2961).
 *
 * The grid used to size its text as `spacing(n, scale)`: the `useResponsive`
 * layout scale, which is a breakpoint factor times a 0.85 short-height factor.
 * That is a spacing scale, not a type scale, so the tile name, streak, emoji,
 * tooltip, locked tile and pager landed at sizes the ramp never offers
 * (10.8/12.6/14.4/21.6px on a phone). The legacy `typography()` scale was
 * never the source — it had no consumers before this change or after it.
 *
 * Every role here takes its size from one `type(width)` face, so text follows
 * the viewport's width alone; layout (padding, margins, tile height) keeps the
 * layout scale. Only the size is taken from the ramp — family, weight and
 * line height stay as the grid styles them.
 */
import { type as typeRamp, uiType } from '../../design/tokens';

/** A face of the `type(width)` ramp. */
type TypeFace = keyof ReturnType<typeof typeRamp>;

/** Every text-bearing role on the Habits grid. */
export type HabitGridRole =
  | 'name'
  | 'streak'
  | 'lockGlyph'
  | 'lockedName'
  | 'lockedSubtitle'
  | 'tooltip'
  | 'iconInline'
  | 'iconStacked'
  | 'paginationLabel'
  | 'paginationControl';

/**
 * Text a reader taps as a control. It is held to `INTERACTIVE_TEXT_MIN` and so
 * takes the button face, never a ramp face that can fall below the floor.
 *
 * The tiles' visible text (name, streak, locked subtitle) is content inside a
 * pressable whose control label is its own `accessibilityLabel`, so it may sit
 * on the caption face; the pager's Prev/Next are the grid's only tapped labels.
 */
export const HABIT_GRID_INTERACTIVE_ROLES = ['paginationControl'] as const;

type InteractiveRole = (typeof HABIT_GRID_INTERACTIVE_ROLES)[number];
type ContentRole = Exclude<HabitGridRole, InteractiveRole>;

/** The ramp face each content role is set in. */
export const HABIT_GRID_FACES: Readonly<Record<ContentRole, TypeFace>> = {
  name: 'label',
  streak: 'caption',
  lockGlyph: 'label',
  lockedName: 'label',
  lockedSubtitle: 'caption',
  tooltip: 'caption',
  iconInline: 'heading',
  iconStacked: 'display',
  paginationLabel: 'label',
};

/** Font size (dp) for every Habits grid role at one viewport width. */
export type HabitGridType = Readonly<Record<HabitGridRole, number>>;

/** Resolve every Habits grid role's font size for a viewport `width`. */
export const habitGridType = (width: number): HabitGridType => {
  const ramp = typeRamp(width);
  const size = (role: ContentRole): number => ramp[HABIT_GRID_FACES[role]].fontSize;
  return {
    name: size('name'),
    streak: size('streak'),
    lockGlyph: size('lockGlyph'),
    lockedName: size('lockedName'),
    lockedSubtitle: size('lockedSubtitle'),
    tooltip: size('tooltip'),
    iconInline: size('iconInline'),
    iconStacked: size('iconStacked'),
    paginationLabel: size('paginationLabel'),
    paginationControl: uiType.button.fontSize,
  };
};
