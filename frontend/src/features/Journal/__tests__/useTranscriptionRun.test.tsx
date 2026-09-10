/* eslint-env jest */
/**
 * The driver seam, at the level where the money is actually spent: how many
 * `transcribePage` calls are outstanding at once.
 *
 * The reducer suite pins the same bound as arithmetic; this one pins it against
 * real promises and the real effect loop, because that is where a wrongly-freed
 * slot turns into a third charged request.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { CapturePage } from '../captureSession';

import { TranscriptionError } from '@/api';

/** The concurrency the run promises, hand-written: importing the production
 *  constant would let the constant itself go wrong without a test noticing. */
const HARD_BOUND = 2;

interface Deferred {
  resolve: (_text: string) => void;
  reject: (_err: unknown) => void;
}

const mockTranscribe = jest.fn() as jest.MockedFunction<
  (_args: { imageBase64: string; mediaType: string }) => Promise<{ text: string }>
>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    journal: {
      ...(actual.journal as Record<string, unknown>),
      transcribePage: (...a: unknown[]) =>
        (mockTranscribe as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

const { useTranscriptionRun } = require('../useTranscriptionRun');

/** Queue `count` transcriptions that never settle on their own, so a test can
 *  settle one specific in-flight page and watch what the run does next. */
function queueDeferred(count: number): Deferred[] {
  const handles: Deferred[] = [];
  for (let index = 0; index < count; index += 1) {
    mockTranscribe.mockReturnValueOnce(
      new Promise<{ text: string }>((resolvePromise, rejectPromise) => {
        handles.push({
          resolve: (text: string) => resolvePromise({ text }),
          reject: rejectPromise,
        });
      }),
    );
  }
  return handles;
}

function page(id: string): CapturePage {
  return {
    id,
    sourceUri: `file:///${id}-source.jpg`,
    uri: `file:///${id}.jpg`,
    imageBase64: `base64-${id}`,
    byteLength: 1024,
    mediaType: 'image/jpeg',
    status: 'ready',
  };
}

/** Four pages: two fill the bound, two wait behind them. The queue is the point —
 *  it means a wrongly-freed slot always has something to spend itself on, so
 *  "no third call" can never pass because the run had run out of work. */
const FOUR_PAGES = [page('page-1'), page('page-2'), page('page-3'), page('page-4')];

function renderRun(pages: CapturePage[]) {
  return renderHook(
    ({ livePages }: { livePages: CapturePage[] }) =>
      useTranscriptionRun({
        pages: livePages,
        started: true,
        onRetake: jest.fn(),
        onRemove: jest.fn(),
      }),
    { initialProps: { livePages: pages } },
  );
}

/** The base64 payloads the run has actually sent, in call order. */
function sentImages(): string[] {
  return mockTranscribe.mock.calls.map((call) => call[0]?.imageBase64 ?? '');
}

beforeEach(() => {
  mockTranscribe.mockReset();
});

describe('useTranscriptionRun — the concurrency bound survives a mid-flight removal', () => {
  it('starts exactly the bound, then one more as each read legitimately settles', async () => {
    // The control the removal tests lean on: with pages queued behind the bound,
    // a freed slot really does spend itself immediately.
    const handles = queueDeferred(4);
    renderRun(FOUR_PAGES);

    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND));
    expect(sentImages()).toEqual(['base64-page-1', 'base64-page-2']);

    await act(async () => {
      handles[0]?.resolve('page one');
    });
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND + 1));
    expect(sentImages()[2]).toBe('base64-page-3');
  });

  it('does not start a third read while a removed page’s request is still outstanding', async () => {
    const handles = queueDeferred(4);
    const { result, rerender } = renderRun(FOUR_PAGES);
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND));

    // The writer trims page one while its read — a live, charged request — is
    // still outstanding. Its slot is not free: the request is still running.
    await act(async () => {
      rerender({ livePages: FOUR_PAGES.slice(1) });
    });
    expect(result.current.blocks['page-1']).toBeUndefined();
    expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND);

    // Settling it is what frees the slot — and page three goes then, proving the
    // run had work queued the whole time it was holding still.
    await act(async () => {
      handles[0]?.resolve('ghost text');
    });
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND + 1));
    expect(sentImages()[2]).toBe('base64-page-3');
  });

  it('treats the removed page’s late resolve as a no-op everywhere but the slot', async () => {
    const handles = queueDeferred(4);
    const { result, rerender } = renderRun(FOUR_PAGES);
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND));

    await act(async () => {
      rerender({ livePages: FOUR_PAGES.slice(1) });
    });
    await act(async () => {
      handles[0]?.resolve('ghost text');
    });

    expect(result.current.blocks['page-1']).toBeUndefined();
    expect(result.current.mergedText).not.toContain('ghost text');
    expect(result.current.progress).toBe('Transcribing 0 of 3…');
    expect(result.current.isComplete).toBe(false);
  });

  it('frees the slot when the removed page’s request rejects instead', async () => {
    // Without this, a removal that ends in a failure would strand its slot for
    // the rest of the session and quietly halve the run's concurrency.
    const handles = queueDeferred(4);
    const { result, rerender } = renderRun(FOUR_PAGES);
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND));

    await act(async () => {
      rerender({ livePages: FOUR_PAGES.slice(1) });
    });
    expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND);

    await act(async () => {
      handles[0]?.reject(new TranscriptionError('network', null));
    });
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND + 1));
    expect(sentImages()[2]).toBe('base64-page-3');
    // The failure belonged to a page that is gone: it surfaces on no block.
    expect(result.current.blocks['page-1']).toBeUndefined();
    expect(result.current.hasTerminalError).toBe(false);
  });

  it('holds both slots when both in-flight pages are removed at once', async () => {
    const handles = queueDeferred(4);
    const { rerender } = renderRun(FOUR_PAGES);
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND));

    await act(async () => {
      rerender({ livePages: FOUR_PAGES.slice(2) });
    });
    expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND);

    await act(async () => {
      handles[0]?.resolve('ghost one');
    });
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND + 1));

    await act(async () => {
      handles[1]?.resolve('ghost two');
    });
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(HARD_BOUND + 2));
    expect(sentImages().slice(2)).toEqual(['base64-page-3', 'base64-page-4']);
  });
});
