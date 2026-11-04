/* eslint-env jest */
/* global describe, test, expect, afterEach, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

type Run = {
  id: number;
  lane: 'app_provider' | 'vault_bound';
  state: 'running' | 'completed' | 'stopped' | 'failed';
  stop_reason: 'no_consent' | 'vault_unavailable' | null;
  entries_total: number;
  entries_offered: number;
  entries_sorted: number;
  started_at: string;
  finished_at: string | null;
};
type Estimate = { entries_pending: number; run: Run | null };
type SweepResult = Estimate & { entries_sorted: number; entries_remaining: number };

const mockSweepEstimate = jest.fn<Promise<Estimate>, []>();
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
  CORPUS_SORT_STOP_LINES,
  CORPUS_SWEEP_FAILURE,
  CORPUS_SWEEP_HOW_LINE,
  CORPUS_SWEEP_NOTHING_PENDING,
  CORPUS_SWEEP_NOTHING_SORTED_REASON,
  CORPUS_SWEEP_RATE_LIMITED,
  CORPUS_SWEEP_READ_FAILURE,
  CORPUS_SWEEP_TITLE,
} from '../corpusSweepCopy';
import CorpusSweepScreen, { SORT_POLL_INTERVAL_MS } from '../CorpusSweepScreen';

import { ApiError } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { expectNavigationOwnsTitle } from '@/testing/navigationOwnsTitle';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const BACKLOG = 412;

/** A run with sensible defaults, any field overridden. */
function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 7,
    lane: 'app_provider',
    state: 'running',
    stop_reason: null,
    entries_total: BACKLOG,
    entries_offered: 0,
    entries_sorted: 0,
    started_at: '2026-11-03T10:00:00Z',
    finished_at: null,
    ...overrides,
  };
}

/** What a finished version of ``run()`` looks like. */
function finished(overrides: Partial<Run> = {}): Run {
  return run({ state: 'completed', finished_at: '2026-11-03T10:05:00Z', ...overrides });
}

/** A press answer carrying ``started``. */
function pressed(started: Run, pending = BACKLOG): SweepResult {
  return {
    entries_pending: pending,
    entries_sorted: started.entries_sorted,
    entries_remaining: pending,
    run: started,
  };
}

/** Let one poll interval pass and its read land. */
async function nextPoll(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(SORT_POLL_INTERVAL_MS);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  resetAllStores();
  mockSweepEstimate.mockResolvedValue({ entries_pending: BACKLOG, run: null });
});

afterEach(() => {
  jest.useRealTimers();
  setActiveUser(null);
});

describe('CorpusSweepScreen', () => {
  test('says how much is unsorted and what sorting does, in the consent vocabulary', async () => {
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText("412 of your entries haven't been sorted yet.")).toBeTruthy();
    expect(screen.getByText(CORPUS_CONSENT_GAIN)).toBeTruthy();
    expect(screen.getByText(CORPUS_INVITATION_REACH)).toBeTruthy();
    expect(screen.getByText(CORPUS_SWEEP_HOW_LINE)).toBeTruthy();
    expectNavigationOwnsTitle(screen, CORPUS_SWEEP_TITLE);
  });

  test('renders no price and no money language at all, because sorting is free', async () => {
    const screen = render(<CorpusSweepScreen />);
    await screen.findByText('Sort all 412 entries');

    expect(screen.queryAllByText(/credit|token|price|cost|charge|\$|\b0\b/i)).toHaveLength(0);
  });

  test('one press sorts everything: progress while it runs, then how it ended', async () => {
    jest.useFakeTimers();
    mockSweep.mockResolvedValueOnce(pressed(run()));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort all 412 entries'));

    expect(await screen.findByText('Sorting 412 entries in the background.')).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();

    mockSweepEstimate.mockResolvedValueOnce({
      entries_pending: 300,
      run: run({ entries_offered: 112, entries_sorted: 112 }),
    });
    await nextPoll();
    expect(
      await screen.findByText('Sorting in the background: 112 of 412 looked at so far.'),
    ).toBeTruthy();

    mockSweepEstimate.mockResolvedValueOnce({
      entries_pending: 0,
      run: finished({ entries_offered: BACKLOG, entries_sorted: BACKLOG }),
    });
    await nextPoll();
    expect(await screen.findByText('Sorted 412 entries. Nothing is left unsorted.')).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  test('stops polling once the sort ends, and when the screen goes', async () => {
    jest.useFakeTimers();
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 9, run: run() });
    const screen = render(<CorpusSweepScreen />);
    await screen.findByText('Sorting 412 entries in the background.');

    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 0, run: finished() });
    await nextPoll();
    await screen.findByText(/Nothing is left unsorted|Nothing is waiting/);
    const readsWhenItEnded = mockSweepEstimate.mock.calls.length;

    await nextPoll();
    await nextPoll();
    expect(mockSweepEstimate).toHaveBeenCalledTimes(readsWhenItEnded);

    screen.unmount();
  });

  test('leaving mid-sort stops the polling, not the sort', async () => {
    jest.useFakeTimers();
    mockSweepEstimate.mockResolvedValue({ entries_pending: 9, run: run() });
    const screen = render(<CorpusSweepScreen />);
    await screen.findByText('Sorting 412 entries in the background.');
    const readsBeforeLeaving = mockSweepEstimate.mock.calls.length;

    screen.unmount();
    await nextPoll();
    await nextPoll();

    expect(mockSweepEstimate).toHaveBeenCalledTimes(readsBeforeLeaving);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  test('arriving while a sort is going follows it rather than offering another', async () => {
    mockSweepEstimate.mockResolvedValue({
      entries_pending: 200,
      run: run({ entries_offered: 212, entries_sorted: 200 }),
    });
    const screen = render(<CorpusSweepScreen />);

    expect(
      await screen.findByText('Sorting in the background: 212 of 412 looked at so far.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();
  });

  test('a sort that ended before this visit is not reported as news', async () => {
    mockSweepEstimate.mockResolvedValue({
      entries_pending: 12,
      run: finished({ entries_sorted: 400 }),
    });
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText('Sort all 12 entries')).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-outcome')).toBeNull();
  });

  test('a sort that sorted nothing with a remainder says so and offers to sort again', async () => {
    jest.useFakeTimers();
    mockSweepEstimate.mockResolvedValueOnce({ entries_pending: 12, run: null });
    mockSweep.mockResolvedValueOnce(pressed(run({ entries_total: 12 }), 12));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort all 12 entries'));
    await screen.findByText('Sorting 12 entries in the background.');
    mockSweepEstimate.mockResolvedValue({
      entries_pending: 12,
      run: finished({ entries_total: 12, entries_offered: 12, entries_sorted: 0 }),
    });
    await nextPoll();

    expect(await screen.findByText('Nothing was sorted. 12 entries still unsorted.')).toBeTruthy();
    expect(screen.getByText(CORPUS_SWEEP_NOTHING_SORTED_REASON)).toBeTruthy();
    expect(screen.getByText('Sort all 12 entries')).toBeTruthy();
  });

  test('a stopped sort says why, and offers to start again', async () => {
    jest.useFakeTimers();
    mockSweep.mockResolvedValueOnce(pressed(run()));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort all 412 entries'));
    await screen.findByText('Sorting 412 entries in the background.');
    mockSweepEstimate.mockResolvedValue({
      entries_pending: 400,
      run: finished({
        state: 'stopped',
        stop_reason: 'vault_unavailable',
        entries_offered: 12,
        entries_sorted: 12,
      }),
    });
    await nextPoll();

    expect(
      await screen.findByText(
        `${CORPUS_SORT_STOP_LINES.vault_unavailable} It sorted 12 entries first. ` +
          '400 entries still unsorted.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Sort all 400 entries')).toBeTruthy();
  });

  test('a press without a standing yes is answered at once, with why', async () => {
    mockSweep.mockResolvedValueOnce(
      pressed(finished({ state: 'stopped', stop_reason: 'no_consent', entries_offered: 0 })),
    );
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort all 412 entries'));

    expect(
      await screen.findByText(`${CORPUS_SORT_STOP_LINES.no_consent} 412 entries still unsorted.`),
    ).toBeTruthy();
  });

  test('holds the button while a press is in flight, so one press is one request', async () => {
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
      finish(pressed(finished({ entries_sorted: BACKLOG, entries_offered: BACKLOG }), 0));
    });
  });

  test('meets the per-account limit with a calm retry-later line', async () => {
    mockSweep.mockRejectedValueOnce(new ApiError(HTTP_TOO_MANY_REQUESTS, 'rate_limit_exceeded'));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort all 412 entries'));

    expect(await screen.findByText(CORPUS_SWEEP_RATE_LIMITED)).toBeTruthy();
    expect(screen.getByTestId('corpus-sweep-confirm')).toBeTruthy();
  });

  test('says only what is known when a press does not come back', async () => {
    mockSweep.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'internal'));
    const screen = render(<CorpusSweepScreen />);

    fireEvent.press(await screen.findByText('Sort all 412 entries'));

    expect(await screen.findByText(CORPUS_SWEEP_FAILURE)).toBeTruthy();
  });

  test('offers a retry when the count does not load, and recovers on it', async () => {
    mockSweepEstimate.mockRejectedValueOnce(new Error('offline'));
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText(CORPUS_SWEEP_READ_FAILURE)).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();

    fireEvent.press(screen.getByTestId('corpus-sweep-retry'));

    expect(await screen.findByText('Sort all 412 entries')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(CORPUS_SWEEP_READ_FAILURE)).toBeNull());
  });

  test('with nothing unsorted, says so and offers nothing to press', async () => {
    mockSweepEstimate.mockResolvedValue({ entries_pending: 0, run: null });
    const screen = render(<CorpusSweepScreen />);

    expect(await screen.findByText(CORPUS_SWEEP_NOTHING_PENDING)).toBeTruthy();
    expect(screen.queryByTestId('corpus-sweep-confirm')).toBeNull();
  });
});
