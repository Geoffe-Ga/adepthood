/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem } from '@/api';
import { suggestedDurationFor } from '@/features/Practice/configurator/defaults';

// ---------------------------------------------------------------------------
// Bug B — wizard Step-4 duration field derive tests (tests 6, 7, 8)
//
// Tests 6 and 7 are RED until the fix hides the standalone duration field for
// duration-driven modes and derives default_duration_minutes from mode_config.
// Test 8 is a regression guard — must stay green after the fix.
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => {
  const ReactMod = require('react');
  const passthrough = ({ children }: { children: unknown }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

const meditationPractice: PracticeItem = {
  id: 601,
  stage_number: 1,
  name: 'Still Mind',
  description: '',
  instructions: '',
  default_duration_minutes: 10,
  submitted_by_user_id: 9,
  approved: false,
  mode: 'meditation_timer',
  mode_config: { mode: 'meditation_timer', duration_minutes: 10 },
};

const metronomePractice: PracticeItem = {
  id: 602,
  stage_number: 1,
  name: 'Beat Sit',
  description: '',
  instructions: '',
  default_duration_minutes: 10,
  submitted_by_user_id: 9,
  approved: false,
  mode: 'metronome',
  mode_config: {
    mode: 'metronome',
    bpm: 60,
    timer: { mode: 'meditation_timer', duration_minutes: 10 },
  },
};

const mockPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: Record<string, unknown>) => Promise<PracticeItem>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<unknown>
>;

jest.mock('@/api', () => ({
  practices: {
    create: (...args: unknown[]) =>
      (mockPracticesCreate as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  },
}));

const { CreatePracticeWizard } = require('../CreatePracticeWizard');

interface NavMock {
  goBack: jest.Mock<() => void>;
  replace: jest.Mock<(...args: unknown[]) => void>;
  navigate: jest.Mock<(...args: unknown[]) => void>;
}

function makeNav(): NavMock {
  return {
    goBack: jest.fn() as jest.Mock<() => void>,
    replace: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
    navigate: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
  };
}

function renderWizard(navOverride?: NavMock) {
  const navigation = navOverride ?? makeNav();
  const route = {
    key: 'k',
    name: 'CreatePractice' as const,
    params: undefined,
  };
  const Screen = CreatePracticeWizard as unknown as React.ComponentType<{
    navigation: NavMock;
    route: typeof route;
  }>;
  const view = render(<Screen navigation={navigation} route={route} />);
  return { view, navigation };
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

// Navigate past Entry and Mode to the Configure step for the given mode.
function advanceToConfigStep(view: ReturnType<typeof render>, mode: string): void {
  fireEvent.press(view.getByTestId('create-practice-from-scratch'));
  fireEvent.press(view.getByTestId(`mode-picker-mode-${mode}`));
}

// Navigate to the Metadata step after choosing a mode.
function advanceToMetadataStep(view: ReturnType<typeof render>, mode: string): void {
  advanceToConfigStep(view, mode);
  fireEvent.press(view.getByTestId('create-practice-configure-next'));
}

describe('CreatePracticeWizard — Bug B: duration field hiding + derive', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  // Test 6 — RED
  // For a meditation_timer draft the standalone duration field must be hidden
  // on the metadata step, and at submit default_duration_minutes must equal
  // mode_config.duration_minutes (derived via suggestedDurationFor).
  //
  // Today the field IS present and default_duration_minutes comes from
  // state.duration (which starts at the default seed and does not track
  // mode_config.duration_minutes edits).
  it('hides create-practice-duration for meditation_timer and derives default_duration_minutes from mode_config', async () => {
    mockPracticesCreate.mockResolvedValueOnce(meditationPractice);
    const { view } = renderWizard();

    // Navigate to configure step, change duration to 45 min, advance.
    advanceToConfigStep(view, 'meditation_timer');
    fireEvent.changeText(view.getByTestId('meditation-timer-duration'), '45');
    fireEvent.press(view.getByTestId('create-practice-configure-next'));

    // On the metadata step, the standalone duration field must NOT be present.
    // RED today: field is present, query returns a node instead of null.
    expect(view.queryByTestId('create-practice-duration')).toBeNull();

    // Fill the required name field and submit.
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Awareness sit');

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    // mode_config.duration_minutes must be 45 (from the form edit).
    expect(payload?.mode_config).toEqual(
      expect.objectContaining({ mode: 'meditation_timer', duration_minutes: 45 }),
    );
    // default_duration_minutes must equal suggestedDurationFor of the final config — 45.
    // RED today: it equals whatever state.duration was seeded to (10 by default).
    expect(payload?.default_duration_minutes).toBe(
      suggestedDurationFor({ mode: 'meditation_timer', duration_minutes: 45 }),
    );
    expect(payload?.default_duration_minutes).toBe(45);
  });

  // Test 7 — RED
  // For a metronome draft, default_duration_minutes must equal
  // timer.duration_minutes (derived via suggestedDurationFor which reads
  // c.timer.duration_minutes for the metronome mode).  The standalone field
  // must also be hidden for this duration-driven mode.
  it('hides create-practice-duration for metronome and derives default_duration_minutes from timer.duration_minutes', async () => {
    mockPracticesCreate.mockResolvedValueOnce(metronomePractice);
    const { view } = renderWizard();

    advanceToConfigStep(view, 'metronome');
    // Change the embedded meditation_timer duration inside the metronome form.
    fireEvent.changeText(view.getByTestId('metronome-timer-duration'), '45');
    fireEvent.press(view.getByTestId('create-practice-configure-next'));

    // The standalone duration field must not appear for metronome either.
    expect(view.queryByTestId('create-practice-duration')).toBeNull();

    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Beat sit 45');

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    // mode_config timer must carry 45 minutes.
    expect(payload?.mode_config).toEqual(
      expect.objectContaining({
        mode: 'metronome',
        timer: expect.objectContaining({ duration_minutes: 45 }),
      }),
    );
    // suggestedDurationFor a metronome config with timer.duration_minutes=45 returns 45.
    expect(payload?.default_duration_minutes).toBe(45);
  });

  // Test 8 — Regression guard (must stay green after the fix)
  // For a rep_counter draft (non-duration-driven mode) the standalone duration
  // field MUST remain present, and the user-typed value must flow to
  // default_duration_minutes at submit.
  it('keeps create-practice-duration visible for rep_counter and threads its value to default_duration_minutes', async () => {
    const repPractice: PracticeItem = {
      id: 603,
      stage_number: 1,
      name: 'Breath count',
      description: '',
      instructions: '',
      default_duration_minutes: 10,
      submitted_by_user_id: 9,
      approved: false,
      mode: 'rep_counter',
      mode_config: { mode: 'rep_counter', target_reps: 10, unit_label: 'reps' },
    };
    mockPracticesCreate.mockResolvedValueOnce(repPractice);
    const { view } = renderWizard();

    advanceToMetadataStep(view, 'rep_counter');

    // For a non-duration-driven mode the standalone duration field must be present.
    expect(view.queryByTestId('create-practice-duration')).toBeTruthy();

    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Breath count');
    // User types a custom duration.
    fireEvent.changeText(view.getByTestId('create-practice-duration'), '7');

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    // The typed value (7) must flow through as default_duration_minutes.
    expect(payload?.default_duration_minutes).toBe(7);
    expect(payload?.mode).toBe('rep_counter');
  });
});
