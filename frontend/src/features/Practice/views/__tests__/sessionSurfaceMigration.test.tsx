/**
 * Verifies the default (no-provider) light-palette contract of the in-session
 * mode views.
 *
 * Each mode view reads its ground / cue / text colours from the
 * `SessionSurface` context. Without a provider, the views must fall back to
 * their original light palette (backward-compatible — the default
 * `LIGHT_SURFACE`), never a showcase token.
 */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { fakeControls, fakeState } from './fixtures';

import { colors, onShowcase } from '@/design/tokens';
import MeditationTimerView from '@/features/Practice/views/MeditationTimerView';
import RepCounterView from '@/features/Practice/views/RepCounterView';

const flatColor = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { color?: string }).color;

const flatBackground = (style: unknown): string | undefined =>
  (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

describe('mode-view default light-palette contract', () => {
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
});
