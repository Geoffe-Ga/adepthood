/**
 * Verifies the #859 showcase-ground migration of the in-session mode views.
 *
 * Each mode view now reads its ground / cue / text colours from the
 * `SessionSurface` context (the seam #831 left). These tests pin the two
 * contracts that migration must honour:
 *
 *   1. WITH the showcase provider, a representative view renders on the umber
 *      ground with AA-clearing `onShowcase` cues (assert a showcase token, not
 *      the light ground).
 *   2. WITHOUT a provider the view renders its original light palette
 *      (backward-compatible — the default `LIGHT_SURFACE`).
 *
 * Plus an explicit AA contrast assertion on the cue colours used on the umber.
 */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { fakeControls, fakeState } from './fixtures';

import { colors, onShowcase, showcase } from '@/design/tokens';
import MeditationTimerView from '@/features/Practice/views/MeditationTimerView';
import RepCounterView from '@/features/Practice/views/RepCounterView';
import { SHOWCASE_SURFACE, SessionSurfaceProvider } from '@/features/Practice/views/sessionSurface';

const AA_NORMAL = 4.5;

/** WCAG relative luminance of a #rrggbb colour. */
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
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const flatColor = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { color?: string }).color;

const flatBackground = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

describe('mode-view showcase surface migration (#859)', () => {
  describe('with the showcase SessionSurface provider', () => {
    it('renders the meditation timer on the umber ground with onShowcase ink', () => {
      const { getByTestId } = render(
        <SessionSurfaceProvider value={SHOWCASE_SURFACE}>
          <MeditationTimerView state={fakeState({ remainingMs: 0 })} controls={fakeControls()} />
        </SessionSurfaceProvider>,
      );
      expect(flatBackground(getByTestId('meditation-timer-view').props.style)).toBe(
        showcase.canvas,
      );
      expect(flatColor(getByTestId('meditation-time-remaining').props.style)).toBe(
        onShowcase.primary,
      );
    });

    it('renders the rep counter ground + cues from the showcase surface', () => {
      const config = { mode: 'rep_counter', target_reps: 10, unit_label: 'reps' } as const;
      const { getByTestId } = render(
        <SessionSurfaceProvider value={SHOWCASE_SURFACE}>
          <RepCounterView config={config} state={fakeState()} controls={fakeControls()} />
        </SessionSurfaceProvider>,
      );
      expect(flatBackground(getByTestId('rep-counter-view').props.style)).toBe(showcase.canvas);
      expect(flatBackground(getByTestId('rep-counter-tap-zone').props.style)).toBe(showcase.raised);
      expect(flatColor(getByTestId('rep-counter-count').props.style)).toBe(onShowcase.primary);
      expect(flatColor(getByTestId('rep-counter-unit').props.style)).toBe(onShowcase.soft);
    });
  });

  describe('without a provider (default light palette — backward compatible)', () => {
    it('keeps the meditation timer digits on the original light ink', () => {
      const { getByTestId } = render(
        <MeditationTimerView state={fakeState({ remainingMs: 0 })} controls={fakeControls()} />,
      );
      // The default LIGHT_SURFACE maps `text` to the original light primary ink
      // and never to a showcase token.
      expect(flatColor(getByTestId('meditation-time-remaining').props.style)).toBe(
        colors.text.primary,
      );
      expect(flatColor(getByTestId('meditation-time-remaining').props.style)).not.toBe(
        onShowcase.primary,
      );
      expect(flatBackground(getByTestId('meditation-timer-view').props.style)).toBe(
        colors.background.primary,
      );
    });

    it('keeps the rep counter on the original light accessible palette', () => {
      const config = { mode: 'rep_counter', target_reps: 10, unit_label: 'reps' } as const;
      const { getByTestId } = render(
        <RepCounterView config={config} state={fakeState()} controls={fakeControls()} />,
      );
      expect(flatColor(getByTestId('rep-counter-count').props.style)).toBe(colors.text.primary);
      expect(flatColor(getByTestId('rep-counter-unit').props.style)).toBe(
        colors.text.secondaryAccessible,
      );
      expect(flatBackground(getByTestId('rep-counter-tap-zone').props.style)).toBe(
        colors.background.card,
      );
    });
  });

  it('every showcase cue colour the views use clears WCAG AA on the umber', () => {
    for (const cue of [
      SHOWCASE_SURFACE.text,
      SHOWCASE_SURFACE.textSoft,
      SHOWCASE_SURFACE.textMuted,
      SHOWCASE_SURFACE.accent,
    ]) {
      expect(contrast(cue, showcase.canvas)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});
