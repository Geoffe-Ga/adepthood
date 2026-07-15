import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { ModeConfig } from '../../engine/types';
import RitualConfiguratorSheet from '../RitualConfiguratorSheet';

import { ApiError, type UserPractice } from '@/api';
import { accent } from '@/design/tokens';

const updated: UserPractice = {
  id: 17,
  user_id: 1,
  practice_id: 9,
  stage_number: 3,
  start_date: '2026-05-01',
  end_date: null,
  custom_name: 'My Sit',
  mode_config_override: null,
};

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof RitualConfiguratorSheet>> = {},
) {
  const customize = jest.fn(async () => updated);
  const onClose = jest.fn();
  const onSaved = jest.fn();
  const baseConfig: ModeConfig = { mode: 'meditation_timer', duration_minutes: 10 };
  const utils = render(
    <RitualConfiguratorSheet
      visible
      userPracticeId={17}
      initialName="Morning Sit"
      aspect="Body"
      initialConfig={baseConfig}
      customize={customize}
      onClose={onClose}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { ...utils, customize, onClose, onSaved };
}

describe('RitualConfiguratorSheet', () => {
  it('renders the meditation timer form by default', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('meditation-timer-form')).toBeTruthy();
    expect(getByTestId('ritual-configurator-aspect')).toBeTruthy();
  });

  it('renders the tallied_grounding form (editable, not the unknown-mode notice)', () => {
    const config: ModeConfig = {
      mode: 'tallied_grounding',
      rounds: 2,
      categories: [{ key: 'c1', label: 'Red things', target_count: 3 }],
    };
    const { getByTestId, queryByTestId } = renderSheet({ initialConfig: config });
    expect(getByTestId('tallied-grounding-form')).toBeTruthy();
    expect(queryByTestId('ritual-configurator-unknown')).toBeNull();
  });

  it('renders the mindful_anchor form (editable, not the unknown-mode notice)', () => {
    const config: ModeConfig = {
      mode: 'mindful_anchor',
      instruction: 'Stand on grass',
      min_duration_seconds: 60,
      options: [{ key: 'o1', label: 'Bare feet' }],
      require_option_choice: false,
    };
    const { getByTestId, queryByTestId } = renderSheet({ initialConfig: config });
    expect(getByTestId('mindful-anchor-form')).toBeTruthy();
    expect(queryByTestId('ritual-configurator-unknown')).toBeNull();
  });

  it('header makes the per-user-override scope explicit', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('ritual-configurator-title').props.children).toBe('Adjust your practice');
    expect(getByTestId('ritual-configurator-subtitle').props.children).toContain('your copy');
  });

  it('disables save until the form is dirty', () => {
    const { getByTestId } = renderSheet();
    const save = getByTestId('ritual-configurator-save');
    expect(save.props.accessibilityState?.disabled).toBe(true);
  });

  it('builds the customize payload from the edited fields on save', async () => {
    const { getByTestId, customize, onClose, onSaved } = renderSheet();
    fireEvent.changeText(getByTestId('ritual-configurator-name'), 'My Morning Sit');
    fireEvent.changeText(getByTestId('meditation-timer-duration'), '15');
    await act(async () => {
      fireEvent.press(getByTestId('ritual-configurator-save'));
      await flushPromises();
    });
    expect(customize).toHaveBeenCalledWith(17, {
      custom_name: 'My Morning Sit',
      mode_config_override: {
        mode: 'meditation_timer',
        duration_minutes: 15,
      },
    });
    expect(onSaved).toHaveBeenCalledWith(updated);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the custom_name when only the config changed', async () => {
    const { getByTestId, customize } = renderSheet();
    fireEvent.changeText(getByTestId('meditation-timer-duration'), '12');
    await act(async () => {
      fireEvent.press(getByTestId('ritual-configurator-save'));
      await flushPromises();
    });
    expect(customize).toHaveBeenCalledWith(17, {
      custom_name: undefined,
      mode_config_override: { mode: 'meditation_timer', duration_minutes: 12 },
    });
  });

  it('shows validation errors and blocks save when out of range', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.changeText(getByTestId('meditation-timer-duration'), '0');
    expect(queryByTestId('configurator-errors')).toBeTruthy();
    expect(getByTestId('ritual-configurator-save').props.accessibilityState?.disabled).toBe(true);
  });

  it('sends nulls for both fields when the user resets to default', async () => {
    const { getByTestId, customize, onSaved, onClose } = renderSheet();
    await act(async () => {
      fireEvent.press(getByTestId('ritual-configurator-reset'));
      await flushPromises();
    });
    expect(customize).toHaveBeenCalledWith(17, {
      custom_name: null,
      mode_config_override: null,
    });
    expect(onSaved).toHaveBeenCalledWith(updated);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the API error message and keeps the sheet open on failure', async () => {
    const customize = jest.fn(async () => {
      throw new ApiError(500, 'internal');
    });
    const onClose = jest.fn();
    const { getByTestId } = renderSheet({ customize, onClose });
    fireEvent.changeText(getByTestId('ritual-configurator-name'), 'My Sit');
    await act(async () => {
      fireEvent.press(getByTestId('ritual-configurator-save'));
      await flushPromises();
    });
    expect(getByTestId('ritual-configurator-api-error').props.children).toBe(
      'Could not save practice.',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the unknown-mode notice for unsupported modes', () => {
    const unknownConfig = { mode: 'mystery' } as unknown as ModeConfig;
    const { getByTestId } = renderSheet({ initialConfig: unknownConfig });
    expect(getByTestId('ritual-configurator-unknown')).toBeTruthy();
  });

  it('disables Save and Reset while the API call is in flight', async () => {
    let resolveCustomize: ((value: UserPractice) => void) | undefined;
    const customize = jest.fn(
      () =>
        new Promise<UserPractice>((resolve) => {
          resolveCustomize = resolve;
        }),
    );
    const { getByTestId } = renderSheet({ customize });
    fireEvent.changeText(getByTestId('ritual-configurator-name'), 'My Sit');
    fireEvent.press(getByTestId('ritual-configurator-save'));
    expect(getByTestId('ritual-configurator-save').props.accessibilityState?.disabled).toBe(true);
    expect(getByTestId('ritual-configurator-reset').props.accessibilityState?.disabled).toBe(true);
    await act(async () => {
      resolveCustomize?.(updated);
      await flushPromises();
    });
  });

  it('blocks save when the name is cleared and shows an inline error', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.changeText(getByTestId('ritual-configurator-name'), '');
    expect(queryByTestId('configurator-errors')).toBeTruthy();
    expect(getByTestId('ritual-configurator-save').props.accessibilityState?.disabled).toBe(true);
  });

  it('cancels without calling the API', () => {
    const { getByTestId, customize, onClose } = renderSheet();
    fireEvent.press(getByTestId('ritual-configurator-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(customize).not.toHaveBeenCalled();
  });

  it('renders each supported mode form by discriminator', () => {
    const cases: { config: ModeConfig; testID: string }[] = [
      { config: { mode: 'count_up', soft_cap_minutes: null }, testID: 'count-up-form' },
      {
        config: {
          mode: 'metronome',
          bpm: 60,
          timer: { mode: 'meditation_timer', duration_minutes: 10 },
        },
        testID: 'metronome-form',
      },
      {
        config: {
          mode: 'interval_bell',
          duration_minutes: 20,
          interval_minutes: 5,
          cue_offsets_minutes: null,
          bell_tone: 'bowl',
        },
        testID: 'interval-bell-form',
      },
      {
        config: { mode: 'rep_counter', target_reps: 10, unit_label: 'reps' },
        testID: 'rep-counter-form',
      },
      {
        config: {
          mode: 'sense_grounding',
          prompts: [{ sense: 'sight', label: 'See' }],
        },
        testID: 'sense-grounding-form',
      },
      {
        config: {
          mode: 'tarot',
          deck: 'major_arcana',
          per_card_minutes: 5,
          hide_timer_during_meditation: true,
        },
        testID: 'tarot-form',
      },
    ];
    cases.forEach(({ config, testID }) => {
      const { getByTestId, unmount } = renderSheet({ initialConfig: config });
      expect(getByTestId(testID)).toBeTruthy();
      unmount();
    });
  });
});

// Candle & Ink token guard: save button background is accent.primary, the migrated semantic token.
describe('Candle & Ink token guard — RitualConfiguratorSheet save button', () => {
  const flatBackground = (style: unknown): string | undefined =>
    (StyleSheet.flatten(style as never) as { backgroundColor?: string }).backgroundColor;

  it('save button background resolves to accent.primary when the sheet is dirty', () => {
    const { getByTestId } = renderSheet();
    // Make the sheet dirty so the save button is enabled (canSave=true).
    fireEvent.changeText(getByTestId('ritual-configurator-name'), 'Adjusted sit');
    const save = getByTestId('ritual-configurator-save');
    expect(flatBackground(save.props.style)).toBe(accent.primary);
  });
});
