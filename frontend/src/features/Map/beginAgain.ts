/** Warm "begin again" copy + cycle label for the end-of-arc affordance. */

/** End-of-arc invitation: a declinable offer to walk again or rest here, whole — no ladder/streak/FOMO vocabulary. */
export const BEGIN_AGAIN_COPY = {
  heading: 'Begin again — or rest here, whole.',
  body: "You've walked the full arc. You can carry what you've gathered into another pass, deepening each time — or set the practice down and simply be whole. Both are complete.",
  action: 'Begin again',
} as const;

/** Subtle "Cycle N" caption naming which pass through the arc the user is on. */
export function cycleLabel(n: number): string {
  return `Cycle ${n}`;
}
