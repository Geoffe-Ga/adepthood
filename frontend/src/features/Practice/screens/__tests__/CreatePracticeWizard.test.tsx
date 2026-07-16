/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem, UserPractice } from '@/api';
import type { ModeConfig } from '@/features/Practice/engine/types';

// The wizard reads useSafeAreaInsets; stub it with non-zero insets (no
// SafeAreaProvider in tests) so the safe-area padding is observable.
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

const createdPractice: PracticeItem = {
  id: 501,
  stage_number: 4,
  name: 'Awareness bells',
  description: '',
  instructions: '',
  default_duration_minutes: 20,
  submitted_by_user_id: 9,
  approved: false,
  mode: 'random_interval_bell',
  mode_config: {
    mode: 'random_interval_bell',
    duration_minutes: 20,
    min_interval_seconds: 30,
    max_interval_seconds: 180,
    bell_tone: 'bowl',
  },
};

const createdUserPractice: UserPractice = {
  id: 4242,
  user_id: 9,
  practice_id: 501,
  stage_number: 4,
  start_date: '2026-05-23',
  end_date: null,
};

const mockPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: Record<string, unknown>) => Promise<PracticeItem>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    create: (...args: unknown[]) =>
      (mockPracticesCreate as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
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

interface RenderOptions {
  prefill?: {
    config: ModeConfig;
    name?: string;
    description?: string;
    instructions?: string;
    duration?: number;
    stageNumber?: number | null;
  };
}

function renderScreen(options: RenderOptions = {}, navOverride?: NavMock) {
  const navigation = navOverride ?? makeNav();
  const route = {
    key: 'k',
    name: 'CreatePractice' as const,
    params: options.prefill ? { prefill: options.prefill } : undefined,
  };
  const Screen = CreatePracticeWizard as unknown as React.ComponentType<{
    navigation: NavMock;
    route: typeof route;
  }>;
  const view = render(<Screen navigation={navigation} route={route} />);
  return { view, navigation };
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CreatePracticeWizard — step navigation', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('opens on the entry step with two equal-weight start options', () => {
    const { view } = renderScreen();
    expect(view.getByTestId('create-practice-step-entry')).toBeTruthy();
    expect(view.getByTestId('create-practice-from-preset')).toBeTruthy();
    expect(view.getByTestId('create-practice-from-scratch')).toBeTruthy();
    // Each option is a one-line card (no paragraph lead).
    expect(view.getByText('Customize a copy from the catalog.')).toBeTruthy();
    expect(view.getByText('Pick a mode and configure it.')).toBeTruthy();
    // Quiet step chrome: a "Step N of M" caption replaces the dense "1 / 4".
    expect(view.getByText('Step 1 of 4')).toBeTruthy();
  });

  it('applies safe-area insets to the wizard container', () => {
    const { view } = renderScreen();
    expect(view.getByTestId('create-practice-wizard')).toHaveStyle({
      paddingTop: 47,
      paddingBottom: 34,
    });
  });

  it('start-from-scratch advances to the mode picker', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    expect(view.getByTestId('create-practice-step-mode')).toBeTruthy();
    expect(view.getByTestId('mode-picker')).toBeTruthy();
  });

  it('start-from-preset opens the catalog picker and never dismisses the wizard', () => {
    // Issue #472: the CTA used to be wired to onCancel (goBack), silently
    // closing the recommended on-ramp. It must open the Practice catalog
    // (preset picker) instead, where a chosen preset copies into the wizard.
    const nav = makeNav();
    const { view } = renderScreen({}, nav);
    fireEvent.press(view.getByTestId('create-practice-from-preset'));
    expect(nav.navigate).toHaveBeenCalledWith('Catalog');
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  it('back from the mode picker returns to the entry step', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('create-practice-back'));
    expect(view.getByTestId('create-practice-step-entry')).toBeTruthy();
  });
});

describe('CreatePracticeWizard — mode → configure dispatch', () => {
  it('routes random_interval_bell to its form with smart defaults', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-random_interval_bell'));
    expect(view.getByTestId('create-practice-step-configure')).toBeTruthy();
    expect(view.getByTestId('random-interval-bell-form')).toBeTruthy();
    expect(view.getByTestId('random-interval-bell-duration').props.value).toBe('20');
  });

  it('routes meditation_timer to its own form', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    expect(view.getByTestId('meditation-timer-form')).toBeTruthy();
  });

  it('renders the configurator form for mindful_anchor', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-mindful_anchor'));
    expect(view.getByTestId('mindful-anchor-form')).toBeTruthy();
    expect(view.queryByTestId('create-practice-configure-unsupported')).toBeNull();
    expect(view.queryByTestId('create-practice-configure-fallback')).toBeNull();
  });

  it('renders the configurator form for tallied_grounding', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-tallied_grounding'));
    expect(view.getByTestId('tallied-grounding-form')).toBeTruthy();
    expect(view.queryByTestId('create-practice-configure-fallback')).toBeNull();
  });
});

describe('CreatePracticeWizard — metadata + submit', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('disables submit until a name is entered', async () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    const submit = view.getByTestId('create-practice-submit');
    expect(submit.props.accessibilityState?.disabled).toBe(true);
  });

  it('shows a formatted suggested-duration hint on the metadata step', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    // A non-duration-driven mode keeps the standalone duration field (and its
    // suggested-duration hint); duration-driven modes derive it from the config.
    fireEvent.press(view.getByTestId('mode-picker-mode-rep_counter'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    expect(view.getByTestId('create-practice-duration-suggested')).toBeTruthy();
    expect(view.getByText(/Suggested:/)).toBeTruthy();
  });

  it('submits practice + user-practice when a stage is selected', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdPractice);
    mockUserPracticesCreate.mockResolvedValueOnce(createdUserPractice);
    const nav = makeNav();
    const { view } = renderScreen({}, nav);

    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-random_interval_bell'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Awareness bells');
    fireEvent.press(view.getByTestId('create-practice-stage-4'));

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    expect(payload?.name).toBe('Awareness bells');
    expect(payload?.stage_number).toBe(4);
    expect(payload?.mode).toBe('random_interval_bell');
    expect(payload?.mode_config).toEqual(
      expect.objectContaining({ mode: 'random_interval_bell', duration_minutes: 20 }),
    );
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({
      practice_id: 501,
      stage_number: 4,
    });
    expect(nav.replace).toHaveBeenCalledWith('PracticeDetail', { practiceId: 501 });
  });

  it('skips the user-practice call when the stage is left as "Skip"', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdPractice);
    const { view } = renderScreen();

    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Quiet sit');

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    // Skip-stage mints the draft under FALLBACK_STAGE (=1); the catalog row
    // exists but is not active anywhere (no user-practice row). Asserting
    // the wire value closes the contract gap flagged in the PR review.
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    expect(payload?.stage_number).toBe(1);
  });

  it('surfaces an API error when the create call fails', async () => {
    mockPracticesCreate.mockRejectedValueOnce(new Error('boom'));
    const { view } = renderScreen();

    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Quiet sit');

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(view.getByTestId('create-practice-api-error')).toBeTruthy();
  });
});

describe('CreatePracticeWizard — prefill mode (name step first)', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  const prefillOptions: RenderOptions = {
    prefill: {
      config: {
        mode: 'random_interval_bell',
        duration_minutes: 25,
        min_interval_seconds: 30,
        max_interval_seconds: 90,
        bell_tone: 'chime',
      },
      name: 'Awareness bells',
      duration: 25,
    },
  };

  it('opens on the name step with the original name prefilled verbatim and autofocused', () => {
    const { view } = renderScreen(prefillOptions);
    expect(view.getByTestId('create-practice-step-name')).toBeTruthy();
    const nameInput = view.getByTestId('create-practice-name');
    expect(nameInput.props.value).toBe('Awareness bells');
    expect(nameInput.props.autoFocus).toBe(true);
    expect(view.queryByTestId('create-practice-step-configure')).toBeNull();
  });

  it('reads "Step 1 of 3" on the name step of a copy flow', () => {
    const { view } = renderScreen(prefillOptions);
    expect(view.getByText('Step 1 of 3')).toBeTruthy();
  });

  it('disables Continue and shows "Name is required." when the name is trimmed empty', () => {
    const { view } = renderScreen(prefillOptions);
    fireEvent.changeText(view.getByTestId('create-practice-name'), '   ');
    const next = view.getByTestId('create-practice-name-next');
    expect(next.props.accessibilityState?.disabled).toBe(true);
    expect(view.getByText(/Name is required\./)).toBeTruthy();
  });

  it('enables Continue by default and advances to configure on tap', () => {
    const { view } = renderScreen(prefillOptions);
    const next = view.getByTestId('create-practice-name-next');
    expect(next.props.accessibilityState?.disabled).toBe(false);
    fireEvent.press(next);
    expect(view.getByTestId('create-practice-step-configure')).toBeTruthy();
    expect(view.getByTestId('random-interval-bell-duration').props.value).toBe('25');
  });

  it('allows duplicate names (no uniqueness error on the name step)', () => {
    const { view } = renderScreen(prefillOptions);
    // Re-typing the exact same name the original had is not an error.
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Awareness bells');
    const next = view.getByTestId('create-practice-name-next');
    expect(next.props.accessibilityState?.disabled).toBe(false);
    expect(view.queryByText(/Name is required\./)).toBeNull();
  });

  it('Back from configure in a copy flow returns to the name step, not the mode step', () => {
    const { view } = renderScreen(prefillOptions);
    fireEvent.press(view.getByTestId('create-practice-name-next'));
    fireEvent.press(view.getByTestId('create-practice-back'));
    expect(view.getByTestId('create-practice-step-name')).toBeTruthy();
    expect(view.queryByTestId('create-practice-step-mode')).toBeNull();
  });

  it('submits the edited (trimmed) name, not the original prefill name', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdPractice);
    const { view } = renderScreen(prefillOptions);
    fireEvent.changeText(view.getByTestId('create-practice-name'), '  Morning bells  ');
    fireEvent.press(view.getByTestId('create-practice-name-next'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    expect(payload?.name).toBe('Morning bells');
  });
});

// ---------------------------------------------------------------------------
// Ownership-aware select fix — submit idempotency and navigation contract
//
// Tests 5-7 cover three behaviours that are RED until the fix lands:
//   5. Happy path — both API calls resolve → navigates to PracticeDetail,
//      practices.create called exactly once.  (May be partially green already
//      for the navigation assertion; the call-count assertion is the pin.)
//   6. Select-failure navigates — practices.create resolves but
//      userPractices.create rejects → wizard still navigates to PracticeDetail
//      because the draft exists even when the select fails.  RED today: the
//      throw from the catch block prevents navigation.
//   7. Idempotent retry — userPractices.create rejects on tap 1; user taps
//      Save again → practices.create must be called exactly ONCE across both
//      taps (no duplicate draft).  RED today: every tap re-calls create.
// ---------------------------------------------------------------------------

describe('CreatePracticeWizard — submit idempotency + navigation contract', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  // Helper: navigate to the metadata step with stage 4 selected and a name
  // filled in, then return the view + nav so the caller can trigger Save.
  function navigateToReadyMetadata(navOverride?: NavMock) {
    const { view, navigation } = renderScreen({}, navOverride);
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-random_interval_bell'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Awareness bells');
    fireEvent.press(view.getByTestId('create-practice-stage-4'));
    return { view, navigation };
  }

  // Test 5 — happy path: both calls resolve → navigates with created id,
  // practices.create called exactly once.
  it('navigates to PracticeDetail when both API calls succeed', async () => {
    mockPracticesCreate.mockResolvedValue(createdPractice);
    mockUserPracticesCreate.mockResolvedValue(createdUserPractice);
    const nav = makeNav();
    const { view } = navigateToReadyMetadata(nav);

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('PracticeDetail', { practiceId: createdPractice.id });
  });

  // Test 6 — RED: select-failure must still navigate to PracticeDetail AND
  // thread the assign-failure message so the detail screen can surface it.
  // Today the wizard passes only { practiceId } (no assignError), so the
  // objectContaining assertion below fails.
  it('navigates to PracticeDetail with assignError when userPractices.create rejects', async () => {
    mockPracticesCreate.mockResolvedValue(createdPractice);
    mockUserPracticesCreate.mockRejectedValue(new Error('select_failed'));
    const nav = makeNav();
    const { view } = navigateToReadyMetadata(nav);

    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    // The draft exists — navigate regardless of the select failure, and carry
    // the error message so PracticeDetailScreen can render it on mount.
    expect(nav.replace).toHaveBeenCalledWith(
      'PracticeDetail',
      expect.objectContaining({ practiceId: createdPractice.id, assignError: expect.any(String) }),
    );
  });

  // Test 7 — RED: a second Save tap after a select failure must NOT call
  // practices.create again.  The created practice id must be remembered
  // within the submit attempt so a retry only re-tries the select step.
  // Today the controller has no such memoisation, so the second tap calls
  // practices.create a second time.
  it('does not re-call practices.create on a retry after select failure', async () => {
    mockPracticesCreate.mockResolvedValue(createdPractice);
    // Reject on first call, resolve on second so the second tap can complete.
    mockUserPracticesCreate
      .mockRejectedValueOnce(new Error('select_failed'))
      .mockResolvedValue(createdUserPractice);
    const nav = makeNav();
    const { view } = navigateToReadyMetadata(nav);

    // First tap — practices.create resolves, userPractices.create rejects.
    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    // Second tap — idempotent: must reuse the already-created practice id.
    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });

    // practices.create must have been called exactly once across both taps.
    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('CreatePracticeWizard — configurator dispatch (smoke)', () => {
  it.each([
    ['count_up', 'count-up-form'],
    ['metronome', 'metronome-form'],
    ['interval_bell', 'interval-bell-form'],
    ['rep_counter', 'rep-counter-form'],
    ['sense_grounding', 'sense-grounding-form'],
    ['tarot', 'tarot-form'],
    ['card_meditation', 'card-meditation-form'],
  ])('routes %s to its existing form (%s)', (mode, formTestId) => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId(`mode-picker-mode-${mode}`));
    expect(view.getByTestId(formTestId)).toBeTruthy();
  });
});

describe('CreatePracticeWizard — metadata fields + nav', () => {
  it('updates description and instructions independently', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-description'), 'A short sit.');
    fireEvent.changeText(view.getByTestId('create-practice-instructions'), 'Sit.');
    expect(view.getByTestId('create-practice-description').props.value).toBe('A short sit.');
    expect(view.getByTestId('create-practice-instructions').props.value).toBe('Sit.');
  });

  it('strips non-numeric characters when parsing duration', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    // rep_counter is not duration-driven, so the standalone duration field is
    // shown and its parsing can be exercised.
    fireEvent.press(view.getByTestId('mode-picker-mode-rep_counter'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-duration'), 'abc');
    expect(view.getByTestId('create-practice-duration').props.value).toBe('');
    fireEvent.changeText(view.getByTestId('create-practice-duration'), '12a');
    expect(view.getByTestId('create-practice-duration').props.value).toBe('12');
  });

  it('lets the user step back from metadata to the configurator', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.press(view.getByTestId('create-practice-back'));
    expect(view.getByTestId('create-practice-step-configure')).toBeTruthy();
  });

  it('lets the user override the auto-suggested duration', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    // For a duration-driven mode the countdown is edited in the configurator, so
    // the standalone field only applies to modes without an inherent duration.
    fireEvent.press(view.getByTestId('mode-picker-mode-rep_counter'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    // Smart default was filled in from the mode default — user can still tweak.
    fireEvent.changeText(view.getByTestId('create-practice-duration'), '45');
    expect(view.getByTestId('create-practice-duration').props.value).toBe('45');
  });

  it('threads config edits from the form back into the wizard state', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdPractice);
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.changeText(view.getByTestId('meditation-timer-duration'), '17');
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.changeText(view.getByTestId('create-practice-name'), 'Tweaked sit');
    await act(async () => {
      fireEvent.press(view.getByTestId('create-practice-submit'));
      await flushPromises();
    });
    const payload = mockPracticesCreate.mock.calls[0]?.[0];
    expect(payload?.mode_config).toEqual(
      expect.objectContaining({ mode: 'meditation_timer', duration_minutes: 17 }),
    );
  });

  it('selecting Skip clears any previously chosen stage', () => {
    const { view } = renderScreen();
    fireEvent.press(view.getByTestId('create-practice-from-scratch'));
    fireEvent.press(view.getByTestId('mode-picker-mode-meditation_timer'));
    fireEvent.press(view.getByTestId('create-practice-configure-next'));
    fireEvent.press(view.getByTestId('create-practice-stage-5'));
    expect(view.getByTestId('create-practice-stage-5').props.accessibilityState?.selected).toBe(
      true,
    );
    fireEvent.press(view.getByTestId('create-practice-stage-skip'));
    expect(view.getByTestId('create-practice-stage-skip').props.accessibilityState?.selected).toBe(
      true,
    );
    expect(view.getByTestId('create-practice-stage-5').props.accessibilityState?.selected).toBe(
      false,
    );
  });
});
