/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Platform } from 'react-native';

import { seedRunReducer, EMPTY_SEED_RUN, type SeedEntry } from '../seedRun';
import { UploadQueueIndicator } from '../UploadQueueIndicator';

import { useUploadQueueStore } from '@/store/useUploadQueueStore';

/**
 * #3772: the queue outlives the Seed screen, so a small indicator shows it from
 * anywhere in the app and opens the run.
 */

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const globalRef = globalThis as { window?: Window & typeof globalThis };
const originalOS = Platform.OS;

function setPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

/** Put the queue mid-run: one landed, one in flight, the rest still queued. */
function queueMidRun(queued: number): void {
  const entries: SeedEntry[] = [
    { id: 'seed-0', name: 'a.md', status: 'ingested' },
    { id: 'seed-1', name: 'b.md', status: 'queued' },
    ...Array.from({ length: queued }, (_unused, index) => ({
      id: `seed-${index + 2}`,
      name: `${index}.md`,
      status: 'queued' as const,
    })),
  ];
  let run = seedRunReducer(EMPTY_SEED_RUN, { type: 'add', entries });
  run = seedRunReducer(run, { type: 'start', id: 'seed-1' });
  useUploadQueueStore.setState({ run, isSending: true });
}

beforeEach(() => {
  useUploadQueueStore.getState().reset();
  mockNavigate.mockReset();
});

afterEach(() => {
  setPlatform(originalOS);
  delete globalRef.window;
});

describe('the upload queue indicator', () => {
  test('shows nothing while the queue is idle', () => {
    const { queryByTestId } = render(<UploadQueueIndicator />);

    expect(queryByTestId('upload-queue-indicator')).toBeNull();
  });

  test('adds what failed once anything has, and leaves skipped files out of it (#3771)', () => {
    queueMidRun(2);
    const { run } = useUploadQueueStore.getState();
    let next = seedRunReducer(run, {
      type: 'add',
      entries: [
        { id: 'seed-x', name: 'x.md', status: 'failed' },
        { id: 'seed-y', name: 'export.json', status: 'unsupported_format' },
      ],
    });
    next = seedRunReducer(next, { type: 'settle', id: 'seed-x', status: 'failed' });
    act(() => {
      useUploadQueueStore.setState({ run: next });
    });
    const { getByTestId } = render(<UploadQueueIndicator />);

    expect(getByTestId('upload-queue-indicator-line').props.children).toBe(
      'Uploading · 3 remaining · 1 failed',
    );
  });

  test('counts what is still to go, from anywhere, and follows the queue', () => {
    queueMidRun(36);
    const { getByTestId, queryByTestId } = render(<UploadQueueIndicator />);

    expect(getByTestId('upload-queue-indicator-line').props.children).toBe(
      'Uploading · 37 remaining',
    );

    act(() => {
      useUploadQueueStore.getState().reset();
    });
    expect(queryByTestId('upload-queue-indicator')).toBeNull();
  });

  test('opens the run on the seeding screen', () => {
    queueMidRun(1);
    const { getByTestId } = render(<UploadQueueIndicator />);

    fireEvent.press(getByTestId('upload-queue-indicator'));

    expect(mockNavigate).toHaveBeenCalledWith('SeedCorpus');
  });

  test('warns before the tab closes while the queue is going over, on the web', () => {
    setPlatform('web');
    const view = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    globalRef.window = view as unknown as Window & typeof globalThis;
    queueMidRun(1);

    const { unmount } = render(<UploadQueueIndicator />);

    expect(view.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    unmount();
    expect(view.removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });
});
