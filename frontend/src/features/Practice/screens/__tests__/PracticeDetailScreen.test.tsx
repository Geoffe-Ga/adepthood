/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem, UserPractice } from '@/api';
import { useProgramStore } from '@/store/useProgramStore';

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

const copiedDraft: PracticeItem = {
  ...samplePractice,
  id: 501,
  stage_number: 6,
  approved: false,
  submitted_by_user_id: 9,
};

const copiedAssignment: UserPractice = {
  id: 2,
  user_id: 9,
  practice_id: 501,
  stage_number: 6,
  start_date: '2026-07-15',
  end_date: null,
};

const mockPracticesGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<PracticeItem>>;
const mockPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: Record<string, unknown>) => Promise<PracticeItem>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    get: (...args: unknown[]) =>
      (mockPracticesGet as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
    create: (...args: unknown[]) =>
      (mockPracticesCreate as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
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
  popToTop: jest.Mock<() => void>;
}

function makeNav(): NavMock {
  return {
    goBack: jest.fn() as jest.Mock<() => void>,
    replace: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
    navigate: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
    popToTop: jest.fn() as jest.Mock<() => void>,
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

const DAY_MS = 24 * 60 * 60 * 1000;
// STAGE_DURATIONS_DAYS is 21 days per stage through stage 8; these offsets land
// mid-stage-4 (the practice's home stage) and mid-stage-6 (a different stage).
const HOME_STAGE_DAYS_AGO = 70;
const OTHER_STAGE_DAYS_AGO = 110;

function setAnchorDaysAgo(days: number): void {
  useProgramStore.getState().hydrateProgramStartDate(new Date(Date.now() - days * DAY_MS));
}

afterEach(() => {
  useProgramStore.getState().hydrateProgramStartDate(null);
});

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
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
    useProgramStore.getState().hydrateProgramStartDate(null);
  });

  it("calls userPractices.create directly for the current stage when it matches the practice's home stage", async () => {
    setAnchorDaysAgo(HOME_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
      await flushPromises();
    });
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 77, stage_number: 4 });
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    expect(view.queryByTestId('practice-copy-dialog')).toBeNull();
    expect(view.queryByTestId('practice-detail-stage-picker')).toBeNull();
    expect(nav.popToTop).toHaveBeenCalledTimes(1);
  });

  it('opens the stage picker, writes via userPractices.create, and returns on pick', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
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
    expect(nav.popToTop).toHaveBeenCalledTimes(1);
  });

  it('does not render a write-only success banner on assign success', async () => {
    setAnchorDaysAgo(HOME_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
      await flushPromises();
    });
    expect(view.queryByTestId('practice-detail-assigned-banner')).toBeNull();
    expect(nav.popToTop).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId('practice-detail-stage-picker')).toBeNull();
  });

  it('opens the share sheet from the Share action', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.queryByTestId('share-sheet')).toBeNull();
    fireEvent.press(view.getByTestId('practice-detail-share'));
    expect(view.getByTestId('share-sheet')).toBeTruthy();
  });

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

describe('PracticeDetailScreen — cross-stage copy', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
    useProgramStore.getState().hydrateProgramStartDate(null);
  });

  it('shows the copy dialog instead of assigning when the current stage differs from the home stage', async () => {
    setAnchorDaysAgo(OTHER_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
    expect(view.getByTestId('practice-copy-dialog')).toBeTruthy();
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    expect(nav.popToTop).not.toHaveBeenCalled();
  });

  it('confirming the copy dialog creates a draft at the target stage, assigns it, and returns', async () => {
    setAnchorDaysAgo(OTHER_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockPracticesCreate.mockResolvedValueOnce(copiedDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(copiedAssignment);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-copy-dialog-confirm'));
      await flushPromises();
    });
    expect(mockPracticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ stage_number: 6, name: 'Forest grounding' }),
    );
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 501, stage_number: 6 });
    expect(nav.popToTop).toHaveBeenCalledTimes(1);
  });

  it('forwards an edited name from the copy dialog to the create payload', async () => {
    setAnchorDaysAgo(OTHER_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockPracticesCreate.mockResolvedValueOnce(copiedDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(copiedAssignment);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
    fireEvent.changeText(view.getByTestId('practice-copy-dialog-name'), 'My forest reset');
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-copy-dialog-confirm'));
      await flushPromises();
    });
    expect(mockPracticesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ stage_number: 6, name: 'My forest reset' }),
    );
  });

  it('cancelling the copy dialog makes zero API calls and leaves the screen in place', async () => {
    setAnchorDaysAgo(OTHER_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
    fireEvent.press(view.getByTestId('practice-copy-dialog-cancel'));
    expect(view.queryByTestId('practice-copy-dialog')).toBeNull();
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    expect(nav.popToTop).not.toHaveBeenCalled();
  });

  it('opens the stage picker instead of assigning when there is no program anchor', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
    expect(view.getByTestId('practice-detail-stage-picker')).toBeTruthy();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    expect(mockPracticesCreate).not.toHaveBeenCalled();
  });

  it('shows the copy dialog when a picker selection differs from the home stage', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const { view } = renderScreen();
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-for-stage'));
    fireEvent.press(view.getByTestId('practice-detail-stage-pick-6'));
    expect(view.getByTestId('practice-copy-dialog')).toBeTruthy();
    expect(mockPracticesCreate).not.toHaveBeenCalled();
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
  });

  it('surfaces an action error without navigating away when the assign step fails after a successful copy', async () => {
    setAnchorDaysAgo(OTHER_STAGE_DAYS_AGO);
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    mockPracticesCreate.mockResolvedValueOnce(copiedDraft);
    mockUserPracticesCreate.mockRejectedValueOnce(new Error('nope'));
    const nav = makeNav();
    const { view } = renderScreen(77, nav);
    await waitForLoad();
    fireEvent.press(view.getByTestId('practice-detail-use-current-stage'));
    await act(async () => {
      fireEvent.press(view.getByTestId('practice-copy-dialog-confirm'));
      await flushPromises();
    });
    expect(view.getByTestId('practice-detail-action-error')).toBeTruthy();
    expect(nav.popToTop).not.toHaveBeenCalled();
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
          name: 'Forest grounding',
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

describe('PracticeDetailScreen — assignError route param', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  // RED: the screen currently reads only `practiceId` from route params and
  // ignores `assignError`.  When the wizard threads the assign-failure message
  // through navigation.replace, the detail screen must surface it via the
  // existing `practice-detail-action-error` banner on mount.  Today that
  // banner is only shown after the screen's own assign() call fails, so this
  // assertion fails against current code.
  it('renders the action-error banner on mount when assignError is in route params', async () => {
    mockPracticesGet.mockResolvedValueOnce(samplePractice);
    const navigation = makeNav();
    const route = {
      key: 'k',
      name: 'PracticeDetail' as const,
      params: { practiceId: 77, assignError: 'Stage assign failed — try again from this screen.' },
    };
    const Screen = PracticeDetailScreen as unknown as React.ComponentType<{
      navigation: NavMock;
      route: typeof route;
    }>;
    const { getByTestId } = render(<Screen navigation={navigation} route={route} />);
    await waitForLoad();
    expect(getByTestId('practice-detail-action-error')).toBeTruthy();
  });
});

describe('PracticeDetailScreen — config summary variants', () => {
  it.each([
    [{ mode: 'meditation_timer', duration_minutes: 10 } as const, ['Duration: 10 min']],
    [{ mode: 'count_up' } as const, ['Open-ended']],
    [{ mode: 'count_up', soft_cap_minutes: 20 } as const, ['Soft cap: 20 min']],
    [
      {
        mode: 'metronome',
        bpm: 60,
        timer: { mode: 'meditation_timer', duration_minutes: 10 },
      } as const,
      ['BPM: 60', 'Duration: 10 min'],
    ],
    [
      {
        mode: 'interval_bell',
        duration_minutes: 20,
        interval_minutes: 5,
        bell_tone: 'bowl',
      } as const,
      ['Duration: 20 min', 'Spacing: every 5 min', 'Tone: bowl'],
    ],
    [
      {
        mode: 'interval_bell',
        duration_minutes: 20,
        cue_offsets_minutes: [2, 7, 15],
        bell_tone: 'bowl',
      } as const,
      ['Duration: 20 min', 'Spacing: 3 custom cues', 'Tone: bowl'],
    ],
    [{ mode: 'rep_counter', target_reps: 12, unit_label: 'reps' } as const, ['Target: 12 reps']],
    [
      {
        mode: 'sense_grounding',
        prompts: [{ sense: 'sight', label: 'blue' }],
      } as const,
      ['1 prompts across the senses'],
    ],
    [
      {
        mode: 'tallied_grounding',
        rounds: 2,
        categories: [{ key: 'c', label: 'a circle', target_count: 3 }],
      } as const,
      ['2 rounds', '1 categories'],
    ],
    [{ mode: 'tarot', deck: 'major_arcana' } as const, ['Major arcana — one card per sit']],
    [{ mode: 'card_meditation', deck_id: 'rws' } as const, ['Deck: rws']],
    [
      {
        mode: 'mindful_anchor',
        instruction: 'Step outside.',
        min_duration_seconds: 60,
        options: [],
        require_option_choice: false,
      } as const,
      ['Soft minimum: 60s', 'no chooser'],
    ],
    [
      {
        mode: 'mindful_anchor',
        instruction: 'Step outside.',
        min_duration_seconds: 60,
        options: [{ key: 'touch_grass', label: 'Touch grass' }],
        require_option_choice: false,
      } as const,
      ['Soft minimum: 60s', '1 options'],
    ],
  ])('summarises %p as %p', async (config, lines) => {
    mockPracticesGet.mockResolvedValueOnce({ ...samplePractice, mode_config: config });
    const { view } = renderScreen();
    await waitForLoad();
    const summary = view.getByTestId('practice-detail-config-summary');
    expect(within(summary).getAllByText(/^• /)).toHaveLength(lines.length);
    for (const line of lines) {
      expect(within(summary).getByText(`• ${line}`)).toBeTruthy();
    }
  });
});

describe('PracticeDetailScreen — badge + body fallbacks', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('falls back to the meditation_timer badge label when mode is absent', async () => {
    const noMode: PracticeItem = { ...samplePractice, mode: undefined };
    mockPracticesGet.mockResolvedValueOnce(noMode);
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.getByTestId('practice-detail-mode-badge').props.children.props.children).toBe(
      'meditation_timer',
    );
  });

  it('omits the description and instructions sections when both are blank', async () => {
    const blankBody: PracticeItem = { ...samplePractice, description: '', instructions: '' };
    mockPracticesGet.mockResolvedValueOnce(blankBody);
    const { view } = renderScreen();
    await waitForLoad();
    expect(view.queryByTestId('practice-detail-description')).toBeNull();
    expect(view.queryByTestId('practice-detail-instructions')).toBeNull();
  });
});
