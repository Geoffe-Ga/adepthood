/* global describe, it, expect */
import { ink, onShowcase, surface } from '../../../design/tokens';
import styles from '../Map.styles';

/**
 * Begin again reads on the Map's parchment (#2979).
 *
 * The block sits in the Map's scroller with no ground of its own, so its text
 * lands on ``surface.canvas`` and takes the canvas inks. The ``onShowcase``
 * inks are for the warm-dark showcase band; on parchment they measured 1.09:1
 * (heading) and 1.67:1 (body) -- all but invisible.
 *
 * Both lines are held to 4.5:1. The heading is 16px bold, and WCAG's large-text
 * allowance of 3:1 starts at 18.66px bold (24px regular), so it does not apply.
 */

/** WCAG relative luminance of a #rrggbb color. */
const luminance = (hex: string): number => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a 6-digit hex: ${hex}`);
  const channels = [match[1], match[2], match[3]].map((pair) => {
    const c = Number.parseInt(pair!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const AA_NORMAL = 4.5;

const SHOWCASE_INKS: readonly string[] = Object.values(onShowcase);

describe('Begin again on the Map parchment (#2979)', () => {
  it('sits on the Map canvas, with no ground of its own', () => {
    // If the block ever gains a band of its own, the ground below is no longer
    // the canvas and these pins must be revisited rather than pass silently.
    expect('backgroundColor' in styles.beginAgain).toBe(false);
    expect(styles.container.backgroundColor).toBe(surface.canvas);
  });

  it('reads in the canvas inks, not the showcase inks', () => {
    expect(styles.beginAgainHeading.color).toBe(ink.primary);
    expect(styles.beginAgainBody.color).toBe(ink.soft);
    expect(SHOWCASE_INKS).not.toContain(styles.beginAgainHeading.color);
    expect(SHOWCASE_INKS).not.toContain(styles.beginAgainBody.color);
  });

  it('clears WCAG AA 4.5:1 on the parchment for both lines (a 16px bold heading is not large text)', () => {
    expect(contrast(styles.beginAgainHeading.color, surface.canvas)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    expect(contrast(styles.beginAgainBody.color, surface.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
