/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

type SweepResult = { entries_pending: number; entries_sorted: number; entries_remaining: number };

const mockSweepEstimate = jest.fn<Promise<{ entries_pending: number }>, []>();
const mockSweep = jest.fn<Promise<SweepResult>, []>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    corpus: {
      sweepEstimate: () => mockSweepEstimate(),
      sweep: () => mockSweep(),
    },
  };
});

import { CORPUS_CONSENT_GAIN, CORPUS_INVITATION_REACH } from '../corpusConsentCopy';
import {
  CORPUS_SWEEP_FAILURE,
  CORPUS_SWEEP_NOTHING_PENDING,
  CORPUS_SWEEP_NOTHING_SORTED_REASON,
  CORPUS_SWEEP_RATE_LIMITED,
  CORPUS_SWEEP_READ_FAILURE,
  CORPUS_SWEEP_TITLE,
} from '../corpusSweepCopy';
import CorpusSweepScreen from '../CorpusSweepScreen';

import { ApiError } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { expectNavigationOwnsTitle } from '@/testing/navigationOwnsTitle';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  resetAllStores();
  mockSweepEstimate.mockResolvedValue({ entries_pending: 412 });
});

afterEach(() => {
  setActiveUser(null);
});

describe('CorpusSweepScreen', () => {
  test('says how much is unsorted and what sorting does, in the consent vocabulary', async () => {
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText("412 of your entries haven't been sorted yet.")).toBeTruthy();
    expect(screen.getByText(CORPUS_CONSENT_GAIN)).toBeTruthy();
    expect(screen.getByText(CORPUS_INVITATION_REACH)).toBeTruthy();
    expectNavigationOwnsTitle(screen, CORPUS_SWEEP_TITLE);
  });

  test('renders no price and no money language at all, because sorting is free', async () => {
    const screen = render(<CorpusSweepScreen />);
    await screen.findByText('Sort the next 40');

    expect(screen.queryAllByText(/credit|token|price|cost|charge|\$|\b0\b/i)).toHaveLength(0);
  });

  test('sorts one pass on request, reports it, and offers the next without asking on its own', async () => {
    mockSweep.mockResolvedValueOnce({
      entries_pending: 372,
      entries_sorted: 40,
      entries_remaining: 372,
    });
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort the next 40'));

    expect(
      await screen.findByText('Sorted 40 entries this pass. 372 entries still unsorted.'),
    ).toBeTruthy();
    expect(screen.getByTestId('corpus-sweep-confirm')).toBeTruthy();
    expect(screen.getByText('Sort the next 40')).toBeTruthy();
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  test('a pass that sorted nothing with a remainder says so and still offers to continue', async () => {
    mockSweepEstimate.mockResolvedValue({ entries_pending: 12 });
    mockSweep.mockResolvedValueOnce({
      entries_pending: 12,
      entries_sorted: 0,
      entries_remaining: 12,
    });
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort the next 12'));

    expect(
      await screen.findByText('Nothing was sorted this pass. 12 entries still unsorted.'),
    ).toBeTruthy();
    expect(screen.getByText(CORPUS_SWEEP_NOTHING_SORTED_REASON)).toBeTruthy();
    expect(screen.getByText('Sort the next 12')).toBeTruthy();
  });

  test('a pass that cleared the backlog leaves nothing to press', async () => {
    mockSweepEstimate.mockResolvedValue({ entries_pending: 3 });
    mockSweep.mockResolvedValueOnce({
      entries_pending: 0,
      entries_sorted: 3,
      entries_remaining: 0,
    });
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort the next 3'));

    expect(
      await screen.findByText('Sorted 3 entries this pass. Nothing is left unsorted.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();
  });

  test('holds the button while a pass is in flight, so one press is one pass', async () => {
    let finish: (result: SweepResult) => void = () => undefined;
    mockSweep.mockReturnValueOnce(
      new Promise<SweepResult>((resolve) => {
        finish = resolve;
      }),
    );
    const screen = render(<CorpusSweepScreen />);
    const button = await screen.findByTestId('corpus-sweep-confirm');

    fireEvent.press(button);
    fireEvent.press(screen.getByTestId('corpus-sweep-confirm'));

    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('corpus-sweep-confirm').props.accessibilityState).toMatchObject({
      busy: true,
    });
    await act(async () => {
      finish({ entries_pending: 372, entries_sorted: 40, entries_remaining: 372 });
    });
  });

  test('meets the per-account limit with a calm retry-later line', async () => {
    mockSweep.mockRejectedValueOnce(new ApiError(HTTP_TOO_MANY_REQUESTS, 'rate_limit_exceeded'));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort the next 40'));

    expect(await screen.findByText(CORPUS_SWEEP_RATE_LIMITED)).toBeTruthy();
    expect(screen.getByTestId('corpus-sweep-confirm')).toBeTruthy();
  });

  test('says only what is known when a pass does not come back', async () => {
    mockSweep.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'internal'));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort the next 40'));

    expect(await screen.findByText(CORPUS_SWEEP_FAILURE)).toBeTruthy();
  });

  test('offers a retry when the count does not load, and recovers on it', async () => {
    mockSweepEstimate.mockRejectedValueOnce(new Error('offline'));
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText(CORPUS_SWEEP_READ_FAILURE)).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();

    fireEvent.press(screen.getByTestId('corpus-sweep-retry'));

    expect(await screen.findByText('Sort the next 40')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(CORPUS_SWEEP_READ_FAILURE)).toBeNull());
  });

  test('with nothing unsorted, says so and offers nothing to press', async () => {
    mockSweepEstimate.mockResolvedValue({ entries_pending: 0 });
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText(CORPUS_SWEEP_NOTHING_PENDING)).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();
  });
});
