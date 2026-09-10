/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem, PracticeStatsResponse, UserPractice } from '@/api';

/**
 * Issue #2449 — the practice detail screen carries the practitioner's own
 * investment in the practice it is describing: how many sittings, and how long
 * in total.
 *
 * The totals come from the backend aggregate, never from paging the session
 * list, so the assertions below are equally about *which* requests the screen
 * makes as about what it renders.
 */

const PRACTICE_ID = 77;
const USER_PRACTICE_ID = 12;

const samplePractice: PracticeItem = {
  id: PRACTICE_ID,
  stage_number: 4,
  name: 'Breath counting',
  description: 'Count ten breaths, then start again.',
  instructions: 'Sit. Count.',
  default_duration_minutes: 10,
  approved: true,
  mode: 'meditation_timer',
  mode_config: {
    mode: 'meditation_timer',
    duration_minutes: 10,
    start_bell: true,
    halfway_bell: false,
    end_bell: true,
  },
};

const adopted: UserPractice = {
  id: USER_PRACTICE_ID,
  practice_id: PRACTICE_ID,
  stage_number: 4,
  start_date: '2026-05-23',
  end_date: null,
};

const otherPractice: UserPractice = {
  id: 99,
  practice_id: 501,
  stage_number: 6,
  start_date: '2026-07-15',
  end_date: null,
};

const mockPracticesGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<PracticeItem>>;
const mockUserPracticesList = jest.fn() as jest.MockedFunction<() => Promise<UserPractice[]>>;
const mockSessionStats = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<PracticeStatsResponse>
>;

jest.mock('@/api', () => ({
  practices: {
    get: (...args: unknown[]) =>
      (mockPracticesGet as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
    create: jest.fn(),
  },
  userPractices: {
    create: jest.fn(),
    list: (...args: unknown[]) =>
      (mockUserPracticesList as unknown as (...a: unknown[]) => Promise<UserPractice[]>)(...args),
  },
  practiceSessions: {
    stats: (...args: unknown[]) =>
      (mockSessionStats as unknown as (...a: unknown[]) => Promise<PracticeStatsResponse>)(...args),
  },
}));

jest.mock('@/features/Practice/components/ShareSheet', () => {
  const { Text } = require('react-native');
  const Stub = ({ visible }: { visible: boolean }) =>
    visible ? <Text testID="share-sheet">share-sheet</Text> : null;
  return { __esModule: true, default: Stub };
});

const { PracticeDetailScreen } = require('../PracticeDetailScreen');

function renderScreen() {
  const navigation = {
    goBack: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    popToTop: jest.fn(),
  };
  const route = { key: 'k', name: 'PracticeDetail' as const, params: { practiceId: PRACTICE_ID } };
  const Screen = PracticeDetailScreen as unknown as React.ComponentType<{
    navigation: typeof navigation;
    route: typeof route;
  }>;
  return render(<Screen navigation={navigation} route={route} />);
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitForLoad(): Promise<void> {
  await act(async () => {
    await flushPromises();
    await flushPromises();
  });
}

describe('PracticeDetailScreen — per-practice statistics', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockUserPracticesList.mockReset();
    mockSessionStats.mockReset();
    mockPracticesGet.mockResolvedValue(samplePractice);
  });

  it('shows the total sittings and the total time as hours past 60', async () => {
    mockUserPracticesList.mockResolvedValue([otherPractice, adopted]);
    mockSessionStats.mockResolvedValue({ total_sessions: 24, total_minutes: 460 });

    const view = renderScreen();
    await waitForLoad();

    expect(view.getByTestId('practice-detail-total-sessions')).toHaveTextContent('24');
    expect(view.getByTestId('practice-detail-total-time')).toHaveTextContent('7h 40m');
  });

  it('asks the backend aggregate for the adoption of this practice, and only that one', async () => {
    mockUserPracticesList.mockResolvedValue([otherPractice, adopted]);
    mockSessionStats.mockResolvedValue({ total_sessions: 1, total_minutes: 10 });

    renderScreen();
    await waitForLoad();

    // Keyed on the user-practice, not the catalog id: the catalog row is shared
    // between accounts and could never scope a personal total.
    expect(mockSessionStats).toHaveBeenCalledWith(USER_PRACTICE_ID);
    expect(mockSessionStats).toHaveBeenCalledTimes(1);
  });

  it('renders real zeros for a practice adopted but never sat', async () => {
    mockUserPracticesList.mockResolvedValue([adopted]);
    mockSessionStats.mockResolvedValue({ total_sessions: 0, total_minutes: 0 });

    const view = renderScreen();
    await waitForLoad();

    expect(view.getByTestId('practice-detail-total-sessions')).toHaveTextContent('0');
    expect(view.getByTestId('practice-detail-total-time')).toHaveTextContent('0m');
  });

  it('shows no stats block, and asks for no aggregate, when the practice is not adopted', async () => {
    mockUserPracticesList.mockResolvedValue([otherPractice]);

    const view = renderScreen();
    await waitForLoad();

    // Browsing the catalog is not an invitation to measure yourself against a
    // practice you have not chosen -- there is nothing to report and nothing to
    // ask for.
    expect(view.queryByTestId('practice-detail-stats')).toBeNull();
    expect(mockSessionStats).not.toHaveBeenCalled();
  });

  it('leaves the rest of the screen intact when the aggregate fails', async () => {
    mockUserPracticesList.mockResolvedValue([adopted]);
    mockSessionStats.mockRejectedValue(new Error('network down'));

    const view = renderScreen();
    await waitForLoad();

    // The totals are an aside, not the reason the screen exists: a failed
    // rollup must not take the practice description down with it.
    expect(view.queryByTestId('practice-detail-stats')).toBeNull();
    expect(view.getByTestId('practice-detail-name')).toHaveTextContent('Breath counting');
    expect(view.queryByTestId('practice-detail-error')).toBeNull();
  });

  it('survives a user-practice listing that fails', async () => {
    mockUserPracticesList.mockRejectedValue(new Error('network down'));

    const view = renderScreen();
    await waitForLoad();

    expect(view.queryByTestId('practice-detail-stats')).toBeNull();
    expect(view.getByTestId('practice-detail-name')).toHaveTextContent('Breath counting');
  });
});
