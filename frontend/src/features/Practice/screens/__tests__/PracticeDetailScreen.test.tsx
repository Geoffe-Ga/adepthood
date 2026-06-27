/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem, UserPractice } from '@/api';

const samplePractice: PracticeItem = {
  id: 77,
  stage_number: 4,
  name: 'Forest grounding',
  description: 'A 5-minute reset under canopy.',
  instructions: 'Find a tree, place a palm on the bark, breathe.',
  default_duration_minutes: 5,
  submitted_by_user_id: null,
  approved: true,
  mode: 'random_interval_bell',
  mode_config: {
    mode: 'random_interval_bell',
    duration_minutes: 5,
    min_interval_seconds: 10,
    max_interval_seconds: 30,
    bell_tone: 'bowl',
  },
};

const assignedUserPractice: UserPractice = {
  id: 1,
  user_id: 9,
  practice_id: 77,
  stage_number: 4,
  start_date: '2026-05-23',
  end_date: null,
};

const mockPracticesGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<PracticeItem>>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    get: (...args: unknown[]) =>
      (mockPracticesGet as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
  },
}));

// Stub the ShareSheet — its mint/revoke behaviour is covered by its own test;
// here we only assert the Share action mounts it (visible).
jest.mock('@/features/Practice/components/ShareSheet', () => {
  const { Text } = require('react-native');
  const Stub = ({ visible }: { visible: boolean }) =>
    visible ? <Text testID="share-sheet">share-sheet</Text> : null;
  return { __esModule: true, default: Stub };
});

const { PracticeDetailScreen } = require('../PracticeDetailScreen');

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

function renderScreen(practiceId = 77, navOverride?: NavMock) {
  const navigation = navOverride ?? makeNav();
  const route = {
    key: 'k',
    name: 'PracticeDetail' as const,
    params: { practiceId },
  };
  const Screen = PracticeDetailScreen as unknown as React.ComponentType<{
    navigation: NavMock;
    route: typeof route;
  }>;
  const view = render(<Screen navigation={navigation} route={route} />);
  return { view, navigation };
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitForLoad() {
  await act(async () => {
    await flushPromises();
  });
}

describe('PracticeDetailScreen — read-only summary', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('renders the practice name, mode badge, stage badge, and description', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-detail-name').props.children).toBe('Forest grounding');
    expect(view.getByTestId('practice-detail-description')).toBeTruthy();
    expect(view.getByTestId('practice-detail-instructions')).toBeTruthy();
    expect(view.getByTestId('practice-detail-mode-badge')).toBeTruthy();
    expect(view.getByTestId('practice-detail-stage-badge')).toBeTruthy();
    // Duration badge uses the shared formatter ("{n} min").
    expect(view.getByText('5 min')).toBeTruthy();
  });

  it('renders a per-mode config summary block', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-detail-config-summary')).toBeTruthy();
  });

  it('surfaces a load error with retry', async () => {
    mockPracticesGet.mockRejectedValueOnce(new Error('boom'));
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-detail-error')).toBeTruthy();
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    fireEvent.press(view.getByTestId('practice-detail-retry'));
    await waitForLoad();
    expect(view.getByTestId('practice-detail-screen')).toBeTruthy();
  });
});

describe('PracticeDetailScreen — Use for stage', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('sets the practice active for the current stage in one tap (no picker)', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    const { view } = renderScreen();
    await waitForLoad();
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
      await flushPromises();
    });
    // Store default current stage is 1; no stage picker is opened.
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 77, stage_number: 1 });
    expect(view.queryByTestId('practice-detail-stage-picker')).toBeNull();
    expect(view.getByTestId('practice-detail-assigned-banner')).toBeTruthy();
  });

  it('opens the stage picker and writes via userPractices.create on pick', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-for-stage'));
    expect(view.getByTestId('practice-detail-stage-picker')).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-detail-stage-pick-4'));
      await flushPromises();
    });
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({
      practice_id: 77,
      stage_number: 4,
    });
    expect(view.getByTestId('practice-detail-assigned-banner')).toBeTruthy();
  });

  it('opens the share sheet from the Share action', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.queryByTestId('share-sheet')).toBeNull();
    fireEvent.press(view.getByTestId('practice-detail-share'));
    expect(view.getByTestId('share-sheet')).toBeTruthy();
  });

  it('surfaces an action error if assignment fails', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockUserPracticesCreate.mockRejectedValueOnce(new Error('nope'));
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-for-stage'));
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-detail-stage-pick-2'));
      await flushPromises();
    });
    expect(view.getByTestId('practice-detail-action-error')).toBeTruthy();
  });
});

describe('PracticeDetailScreen — Duplicate & edit', () => {
  it('reads "Duplicate & edit" and navigates to CreatePractice with this practice prefilled', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    const button = view.getByTestId('practice-detail-customize-copy');
    expect(view.getByText('Duplicate & edit')).toBeTruthy();
    expect(button.props.accessibilityLabel).toBe(
      'Duplicate this practice into a new, editable copy',
    );
    fireEvent.press(button);
    expect(nav.navigate).toHaveBeenCalledWith(
      'CreatePractice',
      expect.objectContaining({
        prefill: expect.objectContaining({
          config: samplePractice.mode_config,
          name: 'Forest grounding (copy)',
          duration: 5,
          stageNumber: 4,
        }),
      }),
    );
  });

  it('is disabled and silent when the practice has no mode_config', async () => {
    const noConfig: PracticeItem = { ...samplePractice, mode_config: undefined };
    mockPracticesGet.mockResolvedValueOnce(noConfig);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    const button = view.getByTestId('practice-detail-customize-copy');
    expect(button.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(button);
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('PracticeDetailScreen — stage picker cancel', () => {
  it('closes the stage picker without writing when Cancel is tapped', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-for-stage'));
    expect(view.getByTestId('practice-detail-stage-picker')).toBeTruthy();
    fireEvent.press(view.getByTestId('practice-detail-stage-pick-cancel'));
    expect(view.queryByTestId('practice-detail-stage-picker')).toBeNull();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
  });
});

describe('PracticeDetailScreen — config summary variants', () => {
  it.each([
    [{ mode: 'meditation_timer', duration_minutes: 10 } as const],
    [{ mode: 'count_up' } as const],
    [{ mode: 'count_up', soft_cap_minutes: 20 } as const],
    [
      {
        mode: 'metronome',
        bpm: 60,
        timer: { mode: 'meditation_timer', duration_minutes: 10 },
      } as const,
    ],
    [
      {
        mode: 'interval_bell',
        duration_minutes: 20,
        interval_minutes: 5,
        bell_tone: 'bowl',
      } as const,
    ],
    [
      {
        mode: 'interval_bell',
        duration_minutes: 20,
        cue_offsets_minutes: [2, 7, 15],
        bell_tone: 'bowl',
      } as const,
    ],
    [{ mode: 'rep_counter', target_reps: 12, unit_label: 'reps' } as const],
    [
      {
        mode: 'sense_grounding',
        prompts: [{ sense: 'sight', label: 'blue' }],
      } as const,
    ],
    [
      {
        mode: 'tallied_grounding',
        rounds: 2,
        categories: [{ key: 'c', label: 'a circle', target_count: 3 }],
      } as const,
    ],
    [{ mode: 'tarot', deck: 'major_arcana' } as const],
    [{ mode: 'card_meditation', deck_id: 'rws' } as const],
  ])('summarises %p', async (config) => {
    mockPracticesGet.mockResolvedValueOnce({ ...samplePractice, mode_config: config });
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-detail-config-summary')).toBeTruthy();
  });
});
