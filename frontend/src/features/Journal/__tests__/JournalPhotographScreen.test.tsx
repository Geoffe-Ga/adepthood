/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import type { MultiPickResult, PickedAsset } from '../pickJournalPhoto';

import { TranscriptionError } from '@/api';
import type { JournalMessage, MediaType, TranscribePageT, TranscriptionErrorKind } from '@/api';
import { toISODate } from '@/components/DatePicker';

// Real-clock-relative dates stay deterministic without fake timers (which leak into RNTL waitFor).
const isoOffsetFromToday = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toISODate(date);
};

const mockPick = jest.fn() as jest.MockedFunction<(_limit: number) => Promise<MultiPickResult>>;
const mockTranscribe = jest.fn() as jest.MockedFunction<
  (_p: { imageBase64: string; mediaType: MediaType }) => Promise<TranscribePageT>
>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;

jest.mock(
  '../pickJournalPhoto',
  () => ({
    pickJournalPhotos: (...a: unknown[]) =>
      (mockPick as unknown as (...x: unknown[]) => unknown)(...a),
  }),
  { virtual: true },
);

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    journal: {
      ...(actual.journal as Record<string, unknown>),
      transcribePage: (...a: unknown[]) =>
        (mockTranscribe as unknown as (...x: unknown[]) => unknown)(...a),
      create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
      update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

jest.mock('react-native-draggable-flatlist', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ({ data, renderItem, onDragEnd, testID }: any) =>
    ReactLib.createElement(
      View,
      { testID: testID ?? 'capture-pages-list', data, onDragEnd },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data.map((item: any, index: number) =>
        ReactLib.cloneElement(
          renderItem({ item, index, drag: jest.fn(), isActive: false, getIndex: () => index }),
          { key: item.id ?? index },
        ),
      ),
    );
});

const JournalPhotographScreen = require('../JournalPhotographScreen').default;

function pickedAsset(overrides: Partial<PickedAsset> = {}): PickedAsset {
  return { uri: 'file:///p1.jpg', imageBase64: 'abc123', mediaType: 'image/jpeg', ...overrides };
}

function uriList(count: number, startAt = 1): string[] {
  return Array.from({ length: count }, (_v, i) => `file:///p${startAt + i}.jpg`);
}

function pageAssets(uris: string[]): PickedAsset[] {
  return uris.map((uri, i) => pickedAsset({ uri, imageBase64: `b64-${i + 1}` }));
}

function picked(assets: PickedAsset[] = [pickedAsset()]): MultiPickResult {
  return { kind: 'picked', assets };
}

function makeEntry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 1,
    message: 'x',
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    status: 'draft',
    ...overrides,
  };
}

function renderScreen() {
  const route = { key: 'k', name: 'JournalPhotograph' as const, params: undefined };
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
  };
  const Screen = JournalPhotographScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return { ...render(<Screen navigation={navigation} route={route} />), navigation };
}

/** One deferred transcription call: resolve/reject it whenever the test wants. */
interface DeferredTranscription {
  resolve: (_text: string) => void;
  reject: (_err: unknown) => void;
}

/** Queue `count` deferred transcribePage calls in invocation order, so callers
 *  can settle a specific in-flight page (out of order) without fake timers. */
function queueDeferredTranscriptions(count: number): DeferredTranscription[] {
  const handles: DeferredTranscription[] = [];
  for (let i = 0; i < count; i += 1) {
    mockTranscribe.mockReturnValueOnce(
      new Promise<TranscribePageT>((resolvePromise, rejectPromise) => {
        handles.push({
          resolve: (text: string) => resolvePromise({ text }),
          reject: rejectPromise,
        });
      }),
    );
  }
  return handles;
}

beforeEach(() => {
  mockPick.mockReset();
  mockTranscribe.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
});

describe('JournalPhotographScreen — auto-launch', () => {
  it('launches the photo picker automatically on mount', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    renderScreen();
    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(1));
  });
});

describe('JournalPhotographScreen — permission denied', () => {
  it('shows the permission-denied view', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'denied' });
    const { findByTestId } = renderScreen();
    expect(await findByTestId('photograph-permission-denied')).toBeTruthy();
  });

  it('opens device settings from Open Settings', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('photograph-open-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('goes back from Cancel without opening settings', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    const { findByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('photograph-cancel'));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });
});

describe('JournalPhotographScreen — cancelled initial pick with zero pages', () => {
  it('goes back immediately with no lingering UI', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    const { navigation, queryByTestId } = renderScreen();
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(queryByTestId('photograph-transcribing')).toBeNull();
    expect(queryByTestId('photograph-error')).toBeNull();
    expect(queryByTestId('photograph-permission-denied')).toBeNull();
    expect(queryByTestId('capture-pages-list')).toBeNull();
  });
});

describe('JournalPhotographScreen — pick itself failed', () => {
  it('shows the error container with Pick another, no retry', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'failed' });
    const { findByTestId, queryByTestId } = renderScreen();
    expect(await findByTestId('photograph-error')).toBeTruthy();
    expect(await findByTestId('photograph-pick-another')).toBeTruthy();
    expect(queryByTestId('photograph-retry')).toBeNull();
  });
});

describe('JournalPhotographScreen — collect stage', () => {
  it('renders picked pages in selection order with a numbered remove affordance each', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { findByTestId } = renderScreen();
    const list = await findByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual(uriList(3));
    expect(await findByTestId('capture-page-remove-1')).toBeTruthy();
    expect(await findByTestId('capture-page-remove-2')).toBeTruthy();
    expect(await findByTestId('capture-page-remove-3')).toBeTruthy();
  });

  it('renders the entry-date row during collect, and again once the run starts', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    const { findByTestId } = renderScreen();
    expect(await findByTestId('capture-entry-date')).toBeTruthy();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('photograph-block-1-input');
    expect(await findByTestId('capture-entry-date')).toBeTruthy();
  });

  it('adds pages additively, appending after the existing pages and requesting only remaining capacity', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { findByTestId } = renderScreen();
    await findByTestId('capture-pages-list');

    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2, 3))));
    fireEvent.press(await findByTestId('capture-add-pages'));

    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(2));
    expect(mockPick).toHaveBeenNthCalledWith(2, 8);

    const list = await findByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual(uriList(4));
  });

  it('reorders the strip from a drag end without any confirmation step', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { findByTestId } = renderScreen();
    const list = await findByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    const reversed = [...data].reverse();

    act(() => {
      list.props.onDragEnd({ data: reversed });
    });

    const reorderedList = await findByTestId('capture-pages-list');
    const reorderedData = reorderedList.props.data as Array<{ uri: string }>;
    expect(reorderedData.map((p) => p.uri)).toEqual([...uriList(3)].reverse());
  });

  it('removes a page by its id, renumbering the remaining remove affordances', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { findByTestId, queryByTestId } = renderScreen();
    await findByTestId('capture-pages-list');

    fireEvent.press(await findByTestId('capture-page-remove-2'));

    const list = await findByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual(['file:///p1.jpg', 'file:///p3.jpg']);
    expect(await findByTestId('capture-page-remove-1')).toBeTruthy();
    expect(await findByTestId('capture-page-remove-2')).toBeTruthy();
    expect(queryByTestId('capture-page-remove-3')).toBeNull();
  });

  it('disables Add pages and shows the cap notice once the session holds the maximum pages', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(10))));
    const { findByTestId } = renderScreen();
    const addButton = await findByTestId('capture-add-pages');
    expect(addButton.props.accessibilityState.disabled).toBe(true);
    expect(await findByTestId('capture-cap-notice')).toHaveTextContent(/10/);
  });
});

describe('JournalPhotographScreen — multi-page transcription gate', () => {
  it('enables Transcribe for more than one page, with no multi-page notice', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { findByTestId, queryByTestId } = renderScreen();
    const transcribeButton = await findByTestId('capture-transcribe');
    expect(transcribeButton.props.accessibilityState.disabled).toBe(false);
    expect(queryByTestId('capture-multi-page-notice')).toBeNull();
  });
});

describe('JournalPhotographScreen — single-page transcribe proceed', () => {
  it('transcribes the single page with imageBase64 + mediaType only, no uri field', async () => {
    mockPick.mockResolvedValueOnce(
      picked([
        pickedAsset({ uri: 'file:///p1.jpg', imageBase64: 'b64-1', mediaType: 'image/png' }),
      ]),
    );
    mockTranscribe.mockResolvedValueOnce({ text: 'x' });
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));

    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(1));
    expect(mockTranscribe).toHaveBeenCalledWith({ imageBase64: 'b64-1', mediaType: 'image/png' });
  });
});

describe('JournalPhotographScreen — cancelled additive pick', () => {
  it('keeps the session intact and stays in collect, without going back', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { findByTestId, navigation } = renderScreen();
    await findByTestId('capture-pages-list');

    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    fireEvent.press(await findByTestId('capture-add-pages'));

    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(2));
    const list = await findByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data).toHaveLength(2);
    expect(navigation.goBack).not.toHaveBeenCalled();
  });
});

describe('JournalPhotographScreen — transcribing (single page)', () => {
  it('shows a skeleton for the sole page while in flight, then its editable text once it resolves', async () => {
    mockPick.mockResolvedValueOnce(picked());
    let resolveTranscribe!: (_v: TranscribePageT) => void;
    mockTranscribe.mockReturnValueOnce(
      new Promise<TranscribePageT>((res) => {
        resolveTranscribe = res;
      }),
    );
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    expect(await findByTestId('photograph-block-1-skeleton')).toBeTruthy();
    await act(async () => {
      resolveTranscribe({ text: 'done' });
    });
    expect(await findByTestId('photograph-block-1-input')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-skeleton')).toBeNull();
  });

  it('sends the picked image + media type to transcribePage', async () => {
    mockPick.mockResolvedValueOnce(
      picked([pickedAsset({ imageBase64: 'b64data', mediaType: 'image/png' })]),
    );
    mockTranscribe.mockResolvedValueOnce({ text: 'x' });
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() =>
      expect(mockTranscribe).toHaveBeenCalledWith({
        imageBase64: 'b64data',
        mediaType: 'image/png',
      }),
    );
  });
});

describe('JournalPhotographScreen — editable transcript (single page)', () => {
  it('seeds the block input with the transcribed text', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'A page about the willow.' });
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    expect(input.props.value).toBe('A page about the willow.');
    expect(await findByTestId('photograph-save')).toBeTruthy();
  });

  it('lets the writer edit the seeded text', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Original, corrected.');
    expect(getByTestId('photograph-block-1-input').props.value).toBe('Original, corrected.');
  });
});

const RETRY_KINDS: TranscriptionErrorKind[] = [
  'provider_error',
  'network',
  'timeout',
  'rate_limited',
];
const RETAKE_KINDS: TranscriptionErrorKind[] = ['invalid_image', 'image_too_large'];

describe('JournalPhotographScreen — single-page error recovery', () => {
  it.each(RETRY_KINDS)('offers Retry (not Retake) on the block for a %s failure', async (kind) => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, null));
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    expect(await findByTestId('photograph-block-1-retry')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retake')).toBeNull();
    expect(await findByTestId('photograph-block-1-remove')).toBeTruthy();
  });

  it.each(RETAKE_KINDS)('offers Retake (not Retry) on the block for a %s failure', async (kind) => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, 422));
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    expect(await findByTestId('photograph-block-1-retake')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retry')).toBeNull();
    expect(await findByTestId('photograph-block-1-remove')).toBeTruthy();
  });

  it('shows the wallet-exhausted copy on the block, with Retry offered', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('wallet_exhausted', 402));
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    expect(await findByTestId('photograph-block-1-error')).toHaveTextContent(
      /this month's free allotment/,
    );
    expect(await findByTestId('photograph-block-1-retry')).toBeTruthy();
  });

  it('calls transcribePage exactly once more per retry tap, never auto-retrying', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('photograph-block-1-retry');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);

    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    fireEvent.press(await findByTestId('photograph-block-1-retry'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    mockTranscribe.mockResolvedValueOnce({ text: 'ok' });
    fireEvent.press(await findByTestId('photograph-block-1-retry'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(3));
  });

  it('retakes the sole page by re-picking exactly one image and substituting it', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('invalid_image', 422));
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('photograph-block-1-retake');
    expect(mockPick).toHaveBeenCalledTimes(1);

    mockPick.mockResolvedValueOnce(
      picked([pickedAsset({ uri: 'file:///retaken.jpg', imageBase64: 'b64-retaken' })]),
    );
    mockTranscribe.mockResolvedValueOnce({ text: 'retaken text' });
    fireEvent.press(await findByTestId('photograph-block-1-retake'));

    await waitFor(() => expect(mockPick).toHaveBeenNthCalledWith(2, 1));
    expect(queryByTestId('photograph-block-1-error')).toBeNull();
    const input = await findByTestId('photograph-block-1-input');
    expect(input.props.value).toBe('retaken text');
  });
});

describe('JournalPhotographScreen — terminal model-lacks-vision failure', () => {
  it('shows only Remove on the block, never a wallet-charging Retry or Retake', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    expect(await findByTestId('photograph-block-1-error')).toHaveTextContent(/isn't available/);
    expect(await findByTestId('photograph-block-1-remove')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retry')).toBeNull();
    expect(queryByTestId('photograph-block-1-retake')).toBeNull();
  });

  it('offers a hand-typed-entry offramp that leaves for a plain entry without charging', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));
    const { findByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    fireEvent.press(await findByTestId('photograph-typed-entry'));
    expect(navigation.navigate).toHaveBeenCalledWith('JournalEntry');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });

  it('hides the typed-entry offramp when no page hit a terminal failure', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('photograph-block-1-error');
    expect(queryByTestId('photograph-typed-entry')).toBeNull();
  });
});

describe('JournalPhotographScreen — multi-page run', () => {
  it('renders one block per page in session order and fills each block as its result arrives, out of order', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const handles = queueDeferredTranscriptions(3);
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));

    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));
    expect(await findByTestId('photograph-block-1-skeleton')).toBeTruthy();
    expect(await findByTestId('photograph-block-2-skeleton')).toBeTruthy();
    expect(await findByTestId('photograph-block-3-skeleton')).toBeTruthy();

    await act(async () => {
      handles[1]?.resolve('B (page two)');
    });
    expect((await findByTestId('photograph-block-2-input')).props.value).toBe('B (page two)');
    expect(queryByTestId('photograph-block-2-skeleton')).toBeNull();
    expect(await findByTestId('photograph-block-1-skeleton')).toBeTruthy();

    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(3));
    await act(async () => {
      handles[0]?.resolve('A (page one)');
    });
    await act(async () => {
      handles[2]?.resolve('C (page three)');
    });

    expect((await findByTestId('photograph-block-1-input')).props.value).toBe('A (page one)');
    expect((await findByTestId('photograph-block-3-input')).props.value).toBe('C (page three)');
  });
});

describe('JournalPhotographScreen — per-block error taxonomy across a run', () => {
  it.each(RETRY_KINDS)(
    'offers Retry on a %s block without disturbing the other, still-running page',
    async (kind) => {
      mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
      const handles = queueDeferredTranscriptions(2);
      const { findByTestId, queryByTestId } = renderScreen();
      fireEvent.press(await findByTestId('capture-transcribe'));
      await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

      await act(async () => {
        handles[0]?.reject(new TranscriptionError(kind, null));
      });
      expect(await findByTestId('photograph-block-1-retry')).toBeTruthy();
      expect(queryByTestId('photograph-block-1-retake')).toBeNull();
      expect(await findByTestId('photograph-block-1-remove')).toBeTruthy();
      expect(await findByTestId('photograph-block-2-skeleton')).toBeTruthy();
    },
  );

  it.each(RETAKE_KINDS)(
    'offers Retake on a %s block without disturbing the other, still-running page',
    async (kind) => {
      mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
      const handles = queueDeferredTranscriptions(2);
      const { findByTestId, queryByTestId } = renderScreen();
      fireEvent.press(await findByTestId('capture-transcribe'));
      await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

      await act(async () => {
        handles[0]?.reject(new TranscriptionError(kind, 422));
      });
      expect(await findByTestId('photograph-block-1-retake')).toBeTruthy();
      expect(queryByTestId('photograph-block-1-retry')).toBeNull();
      expect(await findByTestId('photograph-block-1-remove')).toBeTruthy();
    },
  );

  it('retakes just the failed page, calling the picker with a limit of one, substituting only that block', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));
    await act(async () => {
      handles[0]?.reject(new TranscriptionError('invalid_image', 422));
    });
    await act(async () => {
      handles[1]?.resolve('page two text');
    });
    await findByTestId('photograph-block-1-retake');

    mockPick.mockResolvedValueOnce(
      picked([pickedAsset({ uri: 'file:///retaken.jpg', imageBase64: 'b64-retaken' })]),
    );
    mockTranscribe.mockResolvedValueOnce({ text: 'page one retaken' });
    fireEvent.press(await findByTestId('photograph-block-1-retake'));

    await waitFor(() => expect(mockPick).toHaveBeenNthCalledWith(2, 1));
    const block1Input = await findByTestId('photograph-block-1-input');
    expect(block1Input.props.value).toBe('page one retaken');
    expect((await findByTestId('photograph-block-2-input')).props.value).toBe('page two text');
  });
});

describe('JournalPhotographScreen — retry replaces only its own block', () => {
  it('never re-charges a page that already succeeded when a different page retries', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    await act(async () => {
      handles[0]?.resolve('page one text');
    });
    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });
    expect(await findByTestId('photograph-block-2-retry')).toBeTruthy();

    mockTranscribe.mockResolvedValueOnce({ text: 'page two retried' });
    fireEvent.press(await findByTestId('photograph-block-2-retry'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(3));

    const imagesSent = mockTranscribe.mock.calls.map(
      (call) => (call[0] as { imageBase64: string }).imageBase64,
    );
    expect(imagesSent.filter((image) => image === 'b64-1')).toHaveLength(1);
    expect(imagesSent[2]).toBe('b64-2');
  });
});

describe('JournalPhotographScreen — edited blocks are never clobbered', () => {
  it('keeps a hand-edited block intact while another page in the run is retried', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    await act(async () => {
      handles[0]?.resolve('page one original');
    });
    fireEvent.changeText(await findByTestId('photograph-block-1-input'), 'page one hand-edited');

    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });
    mockTranscribe.mockResolvedValueOnce({ text: 'page two retried' });
    fireEvent.press(await findByTestId('photograph-block-2-retry'));
    await waitFor(() =>
      expect(getByTestId('photograph-block-2-input').props.value).toBe('page two retried'),
    );

    expect(getByTestId('photograph-block-1-input').props.value).toBe('page one hand-edited');
  });
});

describe('JournalPhotographScreen — redo a resolved block', () => {
  it('redoes an unedited block immediately, with no confirm step', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'first pass' });
    const { findByTestId, getByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('photograph-block-1-input');

    mockTranscribe.mockResolvedValueOnce({ text: 'second pass' });
    fireEvent.press(await findByTestId('photograph-block-1-redo'));
    expect(queryByTestId('photograph-block-1-redo-confirm')).toBeNull();
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(getByTestId('photograph-block-1-input').props.value).toBe('second pass'),
    );
  });

  it('requires an inline confirm before redoing an edited block, and leaves it untouched until confirmed', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'first pass' });
    const { findByTestId, getByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'hand-edited');

    fireEvent.press(await findByTestId('photograph-block-1-redo'));
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(getByTestId('photograph-block-1-input').props.value).toBe('hand-edited');
    expect(await findByTestId('photograph-block-1-redo-confirm')).toBeTruthy();

    mockTranscribe.mockResolvedValueOnce({ text: 'redone text' });
    fireEvent.press(await findByTestId('photograph-block-1-redo-confirm'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(getByTestId('photograph-block-1-input').props.value).toBe('redone text'),
    );
    expect(queryByTestId('photograph-block-1-redo-confirm')).toBeNull();
  });
});

describe('JournalPhotographScreen — save gate across the run', () => {
  it('disables Save while any page is unresolved, labels progress, and enables once every page settles', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    expect((await findByTestId('photograph-save')).props.accessibilityState.disabled).toBe(true);
    expect(await findByTestId('photograph-run-progress')).toHaveTextContent('Transcribing 0 of 2…');

    await act(async () => {
      handles[0]?.resolve('page one');
    });
    expect(await findByTestId('photograph-run-progress')).toHaveTextContent('Transcribing 1 of 2…');
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      handles[1]?.resolve('page two');
    });
    await waitFor(() =>
      expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false),
    );
  });

  it('unblocks Save when a failed page is removed rather than retried', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    await act(async () => {
      handles[0]?.resolve('page one');
    });
    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(await findByTestId('photograph-block-2-remove'));
    await waitFor(() =>
      expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false),
    );
  });
});

describe('JournalPhotographScreen — remove every page mid-review (never a dead end)', () => {
  it('returns to the collect stage when the writer removes every page during review, instead of a permanently-disabled Save', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { findByTestId, queryByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    // Both pages fail transiently, so each block offers Remove rather than a landed edit.
    await act(async () => {
      handles[0]?.reject(new TranscriptionError('network', null));
    });
    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });

    fireEvent.press(await findByTestId('photograph-block-2-remove'));
    fireEvent.press(await findByTestId('photograph-block-1-remove'));

    // No dead end: the disabled Save and the "Transcribing 0 of 0…" line are gone,
    // and we are back in collect where the writer can add pages again or leave cleanly.
    await findByTestId('capture-add-pages');
    expect(await findByTestId('capture-transcribe')).toBeTruthy();
    expect(queryByTestId('photograph-save')).toBeNull();
    expect(queryByTestId('photograph-run-progress')).toBeNull();
  });

  it('disarms the run on return to collect: a re-added page only transcribes on an explicit Transcribe, reading the fresh page and never the removed one', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    const handles = queueDeferredTranscriptions(1);
    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(1));

    await act(async () => {
      handles[0]?.reject(new TranscriptionError('network', null));
    });
    fireEvent.press(await findByTestId('photograph-block-1-remove'));
    await findByTestId('capture-add-pages');

    // Re-add a fresh page. Because the run is disarmed, adding does not re-charge.
    mockPick.mockResolvedValueOnce(
      picked([pickedAsset({ uri: 'file:///fresh.jpg', imageBase64: 'b64-fresh' })]),
    );
    fireEvent.press(await findByTestId('capture-add-pages'));
    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(2));
    expect(mockTranscribe).toHaveBeenCalledTimes(1);

    // Only an explicit Transcribe re-arms the run — and it reads the fresh page's bytes.
    mockTranscribe.mockResolvedValueOnce({ text: 'fresh page text' });
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));
    expect((await findByTestId('photograph-block-1-input')).props.value).toBe('fresh page text');
    expect(mockTranscribe.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ imageBase64: 'b64-fresh' }),
    );
  });
});

describe('JournalPhotographScreen — merged save across pages', () => {
  it('saves the ordered, blank-line-merged text with edits winning', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const handles = queueDeferredTranscriptions(3);
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 40, message: 'A\n\nB-edited\n\nC' }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 40, status: 'finished' }));
    const { findByTestId, getByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    await act(async () => {
      handles[1]?.resolve('B');
    });
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(3));
    await act(async () => {
      handles[0]?.resolve('A');
    });
    await act(async () => {
      handles[2]?.resolve('C');
    });
    fireEvent.changeText(await findByTestId('photograph-block-2-input'), 'B-edited');

    await waitFor(() =>
      expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false),
    );
    fireEvent.press(getByTestId('photograph-save'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ message: 'A\n\nB-edited\n\nC' }));
    expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', {
      entryId: 40,
      justSaved: true,
    });
  });
});

describe('JournalPhotographScreen — save flow', () => {
  it('saves the edited transcript (not the original transcription) and replaces to the finished entry', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original transcribed text.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 99, message: 'Edited by hand.' }));
    mockUpdate.mockResolvedValueOnce(
      makeEntry({ id: 99, message: 'Edited by hand.', status: 'finished' }),
    );

    const { findByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Edited by hand.');
    fireEvent.press(await findByTestId('photograph-save'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(99, { status: 'finished' }));
    expect(mockCreate).toHaveBeenCalledWith({ message: 'Edited by hand.' });
    expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', {
      entryId: 99,
      justSaved: true,
    });
  });

  it('never sends entry_date on the create triggered by Save', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 5 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 5, status: 'finished' }));

    const { findByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'No entry_date please.');
    fireEvent.press(await findByTestId('photograph-save'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('entry_date');
  });

  it('keeps the edited text visible and offers Retry-save when saving fails', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));

    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'My hand-edited page.');
    fireEvent.press(await findByTestId('photograph-save'));

    expect(await findByTestId('photograph-retry-save')).toBeTruthy();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('My hand-edited page.');
  });

  it('re-invokes save when Retry-save is tapped', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValue(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 99, status: 'finished' }));

    const { findByTestId, getByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Try again please.');
    fireEvent.press(await findByTestId('photograph-save'));
    await findByTestId('photograph-retry-save');
    fireEvent.press(getByTestId('photograph-retry-save'));

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', {
        entryId: 99,
        justSaved: true,
      }),
    );
    // The retry reuses the created id (no second create), so the page is never
    // duplicated and the wallet is never charged twice.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('persists text edited after a failed save on the retry, without re-creating', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValue(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 99, status: 'finished' }));

    const { findByTestId, getByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    const input = await findByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Before the failure.');
    fireEvent.press(await findByTestId('photograph-save'));
    await findByTestId('photograph-retry-save');
    fireEvent.changeText(getByTestId('photograph-block-1-input'), 'Edited after the failure.');
    fireEvent.press(getByTestId('photograph-retry-save'));

    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenLastCalledWith(99, {
      message: 'Edited after the failure.',
      status: 'finished',
    });
  });
});

describe('JournalPhotographScreen — entry date', () => {
  it('threads a chosen past entry date to journal.create on Save', async () => {
    const yesterday = isoOffsetFromToday(-1);
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 21 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 21, status: 'finished' }));

    const { findByTestId, getByLabelText } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('capture-entry-date');
    fireEvent.changeText(getByLabelText('Date'), yesterday);
    fireEvent.press(await findByTestId('photograph-save'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ entry_date: yesterday }),
    );
  });

  it('omits entry_date on Save when today is re-selected explicitly', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 22 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 22, status: 'finished' }));

    const { findByTestId, getByLabelText } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('capture-entry-date');
    fireEvent.changeText(getByLabelText('Date'), isoOffsetFromToday(-1));
    fireEvent.changeText(getByLabelText('Date'), isoOffsetFromToday(0));
    fireEvent.press(await findByTestId('photograph-save'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('entry_date');
  });

  it('clamps the entry-date picker to maxDate today', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });

    const { findByTestId, getByLabelText, getByText } = renderScreen();
    fireEvent.press(await findByTestId('capture-transcribe'));
    await findByTestId('capture-entry-date');
    const todayButton = getByLabelText('Select today');
    expect(todayButton.props.accessibilityState.disabled).toBe(false);

    fireEvent.changeText(getByLabelText('Date'), isoOffsetFromToday(1));
    expect(getByText(/Pick a date between/)).toBeTruthy();
  });
});
