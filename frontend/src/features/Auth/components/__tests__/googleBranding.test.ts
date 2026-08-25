/* eslint-env jest */
/* global describe, it, expect */
import {
  GOOGLE_BUTTON_LABEL,
  GOOGLE_BUTTON_STROKE_WIDTH,
  GOOGLE_BUTTON_THEMES,
  GOOGLE_BUTTON_TYPE,
  GOOGLE_LOGO_COLORS,
  googleButtonPaddingFor,
} from '../googleBranding';

import { surface, surfaceDark } from '@/design/tokens';

/**
 * Google publishes these values as mandatory for any app using Sign in with
 * Google, so this file is a transcription check, not a design opinion: every
 * expectation below is the literal figure from
 * https://developers.google.com/identity/branding-guidelines. A change here is
 * only ever correct when Google changed the guideline.
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

/** WCAG 1.4.3 for normal text, and 1.4.11 for a control's own boundary. */
const AA_NORMAL = 4.5;
const AA_NON_TEXT = 3;

describe('googleBranding — the two approved themes we use', () => {
  it('transcribes the light theme exactly', () => {
    expect(GOOGLE_BUTTON_THEMES.light).toEqual({
      fill: '#FFFFFF',
      stroke: '#747775',
      text: '#1F1F1F',
    });
  });

  it('transcribes the dark theme exactly', () => {
    expect(GOOGLE_BUTTON_THEMES.dark).toEqual({
      fill: '#131314',
      stroke: '#8E918F',
      text: '#E3E3E3',
    });
  });

  // "1px inside" — a hairline would be a substitution, and Google permits none.
  it('strokes at the mandated 1px', () => {
    expect(GOOGLE_BUTTON_STROKE_WIDTH).toBe(1);
  });
});

describe('googleBranding — padding', () => {
  it('uses 16/12/16 on iOS', () => {
    expect(googleButtonPaddingFor('ios')).toEqual({
      beforeLogo: 16,
      afterLogo: 12,
      afterText: 16,
    });
  });

  it.each(['android', 'web'])('uses 12/10/12 on %s', (os) => {
    expect(googleButtonPaddingFor(os)).toEqual({ beforeLogo: 12, afterLogo: 10, afterText: 12 });
  });
});

describe('googleBranding — type', () => {
  it('sets the mandated 14/20 metrics', () => {
    expect(GOOGLE_BUTTON_TYPE.fontSize).toBe(14);
    expect(GOOGLE_BUTTON_TYPE.lineHeight).toBe(20);
  });

  it('uses one of the three permitted phrases', () => {
    expect(['Sign in with Google', 'Sign up with Google', 'Continue with Google']).toContain(
      GOOGLE_BUTTON_LABEL,
    );
  });
});

describe('googleBranding — the "G" is the standard colour mark', () => {
  // Monochrome versions of the "G" are explicitly prohibited, so the mark must
  // carry all four Google brand colours and nothing greyscale.
  it('carries all four Google brand colours', () => {
    expect([...GOOGLE_LOGO_COLORS].sort()).toEqual(['#34A853', '#4285F4', '#EA4335', '#FBBC05']);
  });

  // Four *distinct* colours, not merely "more than one": collapsing any pair
  // is already a recolour of the mark, which Google prohibits as surely as a
  // fully greyscale one.
  it('keeps all four colours distinct', () => {
    expect(new Set(GOOGLE_LOGO_COLORS).size).toBe(GOOGLE_LOGO_COLORS.length);
  });
});

describe('googleBranding — contrast on both themes', () => {
  it.each(['light', 'dark'] as const)('%s label text clears AA on its own fill', (mode) => {
    const theme = GOOGLE_BUTTON_THEMES[mode];
    expect(contrast(theme.text, theme.fill)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  // The dark fill (#131314) is darker than the app's dark canvas, so what has
  // to carry the button's edge is Google's stroke, not the fill.
  it('the dark stroke clears the non-text floor on the app dark canvas', () => {
    expect(contrast(GOOGLE_BUTTON_THEMES.dark.stroke, surfaceDark.canvas)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  it('the light stroke clears the non-text floor on the app light canvas', () => {
    expect(contrast(GOOGLE_BUTTON_THEMES.light.stroke, surface.canvas)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });
});
