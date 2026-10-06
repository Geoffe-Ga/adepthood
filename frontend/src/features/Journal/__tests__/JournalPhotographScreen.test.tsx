/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { Linking, Platform } from 'react-native';

import type { CaptureResult, MultiPickResult, PickedAsset } from '../pickJournalPhoto';

import { TranscriptionError } from '@/api';
import type { JournalMessage, MediaType, TranscribePageT, TranscriptionErrorKind } from '@/api';
import { toISODate } from '@/components/DatePicker';
import { useCapturedTranscriptStore } from '@/store/useCapturedTranscriptStore';
import { settle } from '@/testing/asyncSettle';

// Real-clock-relative dates stay deterministic without fake timers (which leak into RNTL waitFor).
const isoOffsetFromToday = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toISODate(date);
};

const mockPick = jest.fn() as jest.MockedFunction<(_limit: number) => Promise<MultiPickResult>>;
const mockCapture = jest.fn() as jest.MockedFunction<() => Promise<CaptureResult>>;
const mockTranscribe = jest.fn() as jest.MockedFunction<
  (_p: { imageBase64: string; mediaType: MediaType }) => Promise<TranscribePageT>
>;
const mockCreate = jest.fn() as jest.MockedFunction<
  (_e: unknown, _options?: unknown) => Promise<JournalMessage>
>;
// Every capture's create is sent under its idempotency key (#2936).
const KEYED = { idempotencyKey: expect.any(String) };
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;

/** What the (mocked) client-side downscaler hands back for one page. */
interface PreparedTranscriptionImage {
  base64: string;
  mediaType: 'image/jpeg';
  byteLength: number;
  uri: string;
}

const MAX_TRANSCRIBE_IMAGE_BYTES = 5 * 1024 * 1024;
const PREPARED_BYTE_LENGTH = 1024;

/** The deterministic manipulator-output uri for a given picker/camera source uri. */
const preparedUri = (sourceUri: string): string => `${sourceUri}.prepared.jpg`;
/** The deterministic downscaled base64 payload for a given source uri. */
const preparedBase64 = (sourceUri: string): string => `prepared-${sourceUri}`;

function preparedPage(sourceUri: string): PreparedTranscriptionImage {
  return {
    base64: preparedBase64(sourceUri),
    mediaType: 'image/jpeg',
    byteLength: PREPARED_BYTE_LENGTH,
    uri: preparedUri(sourceUri),
  };
}

const mockPrepare = jest.fn() as jest.MockedFunction<
  (_uri: string) => Promise<PreparedTranscriptionImage>
>;
const mockReleasePageFiles = jest.fn() as jest.MockedFunction<(_page: unknown) => Promise<void>>;
const mockReleaseAllPageFiles = jest.fn() as jest.MockedFunction<
  (_pages: readonly unknown[]) => Promise<void>
>;
const mockReleaseUris = jest.fn() as jest.MockedFunction<
  (_uris: readonly string[]) => Promise<void>
>;

jest.mock(
  '../capture/prepareImage',
  () => ({
    MAX_TRANSCRIBE_IMAGE_BYTES: 5 * 1024 * 1024,
    TRANSCRIBE_LONG_EDGE_PX: 1568,
    TRANSCRIBE_JPEG_QUALITY: 0.8,
    preparePageForTranscription: (...a: unknown[]) =>
      (mockPrepare as unknown as (...x: unknown[]) => unknown)(...a),
  }),
  { virtual: true },
);

jest.mock(
  '../capture/cleanupPageFiles',
  () => ({
    releasePageFiles: (...a: unknown[]) =>
      (mockReleasePageFiles as unknown as (...x: unknown[]) => unknown)(...a),
    releaseAllPageFiles: (...a: unknown[]) =>
      (mockReleaseAllPageFiles as unknown as (...x: unknown[]) => unknown)(...a),
    releaseUris: (...a: unknown[]) =>
      (mockReleaseUris as unknown as (...x: unknown[]) => unknown)(...a),
  }),
  { virtual: true },
);

jest.mock(
  '../pickJournalPhoto',
  () => ({
    pickJournalPhotos: (...a: unknown[]) =>
      (mockPick as unknown as (...x: unknown[]) => unknown)(...a),
    captureJournalPhoto: (...a: unknown[]) =>
      (mockCapture as unknown as (...x: unknown[]) => unknown)(...a),
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
  return { uri: 'file:///p1.jpg', ...overrides } as PickedAsset;
}

function uriList(count: number, startAt = 1): string[] {
  return Array.from({ length: count }, (_v, i) => `file:///p${startAt + i}.jpg`);
}

function pageAssets(uris: string[]): PickedAsset[] {
  return uris.map((uri) => pickedAsset({ uri }));
}

function picked(assets: PickedAsset[] = [pickedAsset()]): MultiPickResult {
  return { kind: 'picked', assets };
}

function capturedPage(uri: string): CaptureResult {
  return { kind: 'captured', asset: pickedAsset({ uri }) };
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

/** The route params the append-mode entry point arrives with. */
interface PhotographParams {
  appendTo?: string;
}

function renderScreen(params?: PhotographParams) {
  const route = { key: 'k', name: 'JournalPhotograph' as const, params };
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
  };
  const Screen = JournalPhotographScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return { ...render(<Screen navigation={navigation} route={route} />), navigation };
}

/** The hand-off token the open journal entry addressed this capture to. */
const APPEND_TOKEN = 'capture-1';

/** Render the screen the way the open journal entry opens it: in append mode. */
function renderAppendScreen() {
  return renderScreen({ appendTo: APPEND_TOKEN });
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
  mockCapture.mockReset();
  mockTranscribe.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockPrepare.mockReset();
  mockPrepare.mockImplementation((uri: string) => Promise.resolve(preparedPage(uri)));
  mockReleasePageFiles.mockReset();
  mockReleasePageFiles.mockResolvedValue(undefined);
  mockReleaseAllPageFiles.mockReset();
  mockReleaseAllPageFiles.mockResolvedValue(undefined);
  mockReleaseUris.mockReset();
  mockReleaseUris.mockResolvedValue(undefined);
  act(() => {
    useCapturedTranscriptStore.getState().clear();
  });
});

describe('JournalPhotographScreen — auto-launch', () => {
  it('launches the photo picker automatically on mount', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    renderScreen();
    await settle();
    expect(mockPick).toHaveBeenCalledTimes(1);
  });
});

describe('JournalPhotographScreen — permission denied', () => {
  it('shows the permission-denied view', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'denied' });
    const { getByTestId } = renderScreen();
    await settle();
    expect(getByTestId('photograph-permission-denied')).toBeTruthy();
  });

  it('opens device settings from Open Settings', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('photograph-open-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('goes back from Cancel without opening settings', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('photograph-cancel'));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });
});

describe('JournalPhotographScreen — cancelled initial pick with zero pages', () => {
  it('goes back immediately with no lingering UI', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    const { navigation, queryByTestId } = renderScreen();
    await settle();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(queryByTestId('photograph-transcribing')).toBeNull();
    expect(queryByTestId('photograph-error')).toBeNull();
    expect(queryByTestId('photograph-permission-denied')).toBeNull();
    expect(queryByTestId('capture-pages-list')).toBeNull();
  });
});

describe('JournalPhotographScreen — pick itself failed', () => {
  it('shows the error container with Pick another, no retry', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'failed' });
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    expect(getByTestId('photograph-error')).toBeTruthy();
    expect(getByTestId('photograph-pick-another')).toBeTruthy();
    expect(queryByTestId('photograph-retry')).toBeNull();
  });
});

describe('JournalPhotographScreen — collect stage', () => {
  it('renders picked pages in selection order with a numbered remove affordance each', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { getByTestId } = renderScreen();
    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual(uriList(3).map(preparedUri));
    await settle();
    expect(getByTestId('capture-page-remove-1')).toBeTruthy();
    expect(getByTestId('capture-page-remove-2')).toBeTruthy();
    expect(getByTestId('capture-page-remove-3')).toBeTruthy();
  });

  it('renders the entry-date row during collect, and again once the run starts', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    const { getByTestId } = renderScreen();
    await settle();
    expect(getByTestId('capture-entry-date')).toBeTruthy();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');
    expect(getByTestId('capture-entry-date')).toBeTruthy();
  });

  it('adds pages additively, appending after the existing pages and requesting only remaining capacity', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2, 3))));
    await settle();
    fireEvent.press(getByTestId('capture-add-pages'));

    await settle();
    expect(mockPick).toHaveBeenCalledTimes(2);
    expect(mockPick).toHaveBeenNthCalledWith(2, 8);

    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual(uriList(4).map(preparedUri));
  });

  it('reorders the strip from a drag end without any confirmation step', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { getByTestId } = renderScreen();
    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    const reversed = [...data].reverse();

    act(() => {
      list.props.onDragEnd({ data: reversed });
    });

    await settle();
    const reorderedList = getByTestId('capture-pages-list');
    const reorderedData = reorderedList.props.data as Array<{ uri: string }>;
    expect(reorderedData.map((p) => p.uri)).toEqual(uriList(3).map(preparedUri).reverse());
  });

  it('removes a page by its id, renumbering the remaining remove affordances', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-page-remove-2'));

    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual([
      preparedUri('file:///p1.jpg'),
      preparedUri('file:///p3.jpg'),
    ]);
    await settle();
    expect(getByTestId('capture-page-remove-1')).toBeTruthy();
    expect(getByTestId('capture-page-remove-2')).toBeTruthy();
    expect(queryByTestId('capture-page-remove-3')).toBeNull();
  });

  it('disables Add pages and shows the cap notice once the session holds the maximum pages', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(10))));
    const { getByTestId } = renderScreen();
    await settle();
    const addButton = getByTestId('capture-add-pages');
    expect(addButton.props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('capture-cap-notice')).toHaveTextContent(/10/);
  });

  it('never prepares assets beyond the session cap, so no cache file is left untracked', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(12))));
    const { getByTestId } = renderScreen();

    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual(uriList(10).map(preparedUri));
    expect(mockPrepare).toHaveBeenCalledTimes(10);
    expect(mockPrepare).not.toHaveBeenCalledWith('file:///p11.jpg');
    expect(mockPrepare).not.toHaveBeenCalledWith('file:///p12.jpg');
  });

  it('reclaims every transient file of a batch when one page cannot be prepared', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    mockPrepare.mockImplementation((uri: string) =>
      uri === 'file:///p2.jpg'
        ? Promise.reject(new Error('unreadable'))
        : Promise.resolve(preparedPage(uri)),
    );
    const { getByTestId } = renderScreen();

    await settle();
    expect(getByTestId('photograph-pick-another')).toBeTruthy();
    await settle();
    expect(mockReleaseUris).toHaveBeenCalledTimes(1);
    const [releasedUris] = mockReleaseUris.mock.calls[0] ?? [[]];
    expect(releasedUris).toEqual(
      expect.arrayContaining(['file:///p1.jpg', 'file:///p2.jpg', preparedUri('file:///p1.jpg')]),
    );
  });
});

describe('JournalPhotographScreen — multi-page transcription gate', () => {
  it('enables Transcribe for more than one page, with no multi-page notice', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    const transcribeButton = getByTestId('capture-transcribe');
    expect(transcribeButton.props.accessibilityState.disabled).toBe(false);
    expect(queryByTestId('capture-multi-page-notice')).toBeNull();
  });
});

describe('JournalPhotographScreen — single-page transcribe proceed', () => {
  it('transcribes the single page with the prepared base64 and image/jpeg, no uri field', async () => {
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///p1.jpg' })]));
    mockTranscribe.mockResolvedValueOnce({ text: 'x' });
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));

    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockTranscribe).toHaveBeenCalledWith({
      imageBase64: preparedBase64('file:///p1.jpg'),
      mediaType: 'image/jpeg',
    });
  });
});

describe('JournalPhotographScreen — cancelled additive pick', () => {
  it('keeps the session intact and stays in collect, without going back', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId, navigation } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    await settle();
    fireEvent.press(getByTestId('capture-add-pages'));

    await settle();
    expect(mockPick).toHaveBeenCalledTimes(2);
    await settle();
    const list = getByTestId('capture-pages-list');
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
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(getByTestId('photograph-block-1-skeleton')).toBeTruthy();
    await act(async () => {
      resolveTranscribe({ text: 'done' });
    });
    await settle();
    expect(getByTestId('photograph-block-1-input')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-skeleton')).toBeNull();
  });

  it('sends the prepared image payload to transcribePage, never the raw picker file', async () => {
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///page-a.jpg' })]));
    mockTranscribe.mockResolvedValueOnce({ text: 'x' });
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledWith({
      imageBase64: preparedBase64('file:///page-a.jpg'),
      mediaType: 'image/jpeg',
    });
  });
});

describe('JournalPhotographScreen — editable transcript (single page)', () => {
  it('seeds the block input with the transcribed text', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'A page about the willow.' });
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    expect(input.props.value).toBe('A page about the willow.');
    expect(getByTestId('photograph-save')).toBeTruthy();
  });

  it('lets the writer edit the seeded text', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
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
const RETAKE_KINDS: TranscriptionErrorKind[] = [
  'invalid_image',
  'image_too_large',
  'no_text_found',
  'transcription_refused',
];

/** The reply was read but held nothing usable (#2851): exact copy per kind. */
const UNUSABLE_READ_COPY: Array<[TranscriptionErrorKind, string]> = [
  ['no_text_found', "We couldn't find any text in that photo. Retake it, or remove this page."],
  [
    'transcription_refused',
    'The helper declined to read that page. Try once more, or type it in by hand.',
  ],
];

describe('JournalPhotographScreen — single-page error recovery', () => {
  it.each(RETRY_KINDS)('offers Retry (not Retake) on the block for a %s failure', async (kind) => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, null));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(getByTestId('photograph-block-1-retry')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retake')).toBeNull();
    expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
  });

  it.each(RETAKE_KINDS)('offers Retake (not Retry) on the block for a %s failure', async (kind) => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, 422));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(getByTestId('photograph-block-1-retake')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retry')).toBeNull();
    expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
  });

  it.each(UNUSABLE_READ_COPY)(
    'shows the %s copy with Retake and Remove, never the terminal offramp',
    async (kind, copy) => {
      mockPick.mockResolvedValueOnce(picked());
      mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, 422));
      const { getByTestId, queryByTestId } = renderScreen();
      await settle();
      fireEvent.press(getByTestId('capture-transcribe'));
      await settle();
      expect(getByTestId('photograph-block-1-error')).toHaveTextContent(copy);
      expect(getByTestId('photograph-block-1-retake')).toBeTruthy();
      expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
      expect(queryByTestId('photograph-typed-entry')).toBeNull();
    },
  );

  it('asks for a retake with the text clearer, not clearer handwriting', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('invalid_image', 422));
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(getByTestId('photograph-block-1-error')).toHaveTextContent(
      "We couldn't quite read that page. Retake it with the text clearer.",
    );
  });

  it('shows the wallet-exhausted copy on the block, with Retry offered', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('wallet_exhausted', 402));
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(getByTestId('photograph-block-1-error')).toHaveTextContent(
      /this month's free BotMason messages/,
    );
    expect(getByTestId('photograph-block-1-retry')).toBeTruthy();
  });

  it('calls transcribePage exactly once more per retry tap, never auto-retrying', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-retry');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);

    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retry'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    mockTranscribe.mockResolvedValueOnce({ text: 'ok' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retry'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(3);
  });

  it('retakes the sole page by re-picking exactly one image and substituting it', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('invalid_image', 422));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-retake');
    expect(mockPick).toHaveBeenCalledTimes(1);

    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///retaken.jpg' })]));
    mockTranscribe.mockResolvedValueOnce({ text: 'retaken text' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retake'));

    await settle();
    expect(mockPick).toHaveBeenNthCalledWith(2, 1);
    // The retaken page is prepared (one async encode) then read; once its text
    // lands the failed-block error is gone.
    await settle();
    const input = getByTestId('photograph-block-1-input');
    expect(input.props.value).toBe('retaken text');
    expect(queryByTestId('photograph-block-1-error')).toBeNull();
  });

  it('releases the superseded page files when the sole page is retaken', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('invalid_image', 422));
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-retake');

    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///retaken.jpg' })]));
    mockTranscribe.mockResolvedValueOnce({ text: 'retaken text' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retake'));

    // The outgoing page's transient device files are reclaimed on the swap, so a
    // retake never strands the old photo's cache copy or downscaled output.
    await settle();
    expect(mockReleasePageFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUri: 'file:///p1.jpg',
        uri: preparedUri('file:///p1.jpg'),
      }),
    );
  });

  it('keeps the existing page, releasing nothing, when a retake photo cannot be prepared', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('invalid_image', 422));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-retake');

    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///bad.jpg' })]));
    mockPrepare.mockRejectedValueOnce(new Error('unreadable'));
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retake'));

    await settle();
    expect(mockPick).toHaveBeenCalledTimes(2);
    // The unpreparable retake is declined: the original failed block stays put and
    // its still-owned files are never released.
    await settle();
    expect(getByTestId('photograph-block-1-retake')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-input')).toBeNull();
    expect(mockReleasePageFiles).not.toHaveBeenCalled();
  });
});

describe('JournalPhotographScreen — terminal model-lacks-vision failure', () => {
  it('renders terminal copy, typed-entry offramp, and disabled Save without Retry or Retake', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(getByTestId('photograph-block-1-error')).toHaveTextContent(
      'The AI that reads pages here can’t see photos. You can still type this page in by hand.',
    );
    expect(getByTestId('photograph-run-progress')).toHaveTextContent(
      '0 of 1 read · 1 need attention',
    );
    expect(getByTestId('photograph-typed-entry')).toBeTruthy();
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retry')).toBeNull();
    expect(queryByTestId('photograph-block-1-retake')).toBeNull();
  });

  it('offers a hand-typed-entry offramp that leaves for a plain entry without charging', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));
    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    fireEvent.press(getByTestId('photograph-typed-entry'));
    expect(navigation.navigate).toHaveBeenCalledWith('JournalEntry');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });

  it('hides the typed-entry offramp when no page hit a terminal failure', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-error');
    expect(queryByTestId('photograph-typed-entry')).toBeNull();
  });
});

describe('JournalPhotographScreen — multi-page run', () => {
  it('renders one block per page in session order and fills each block as its result arrives, out of order', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const handles = queueDeferredTranscriptions(3);
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));

    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await settle();
    expect(getByTestId('photograph-block-1-skeleton')).toBeTruthy();
    expect(getByTestId('photograph-block-2-skeleton')).toBeTruthy();
    expect(getByTestId('photograph-block-3-skeleton')).toBeTruthy();

    await act(async () => {
      handles[1]?.resolve('B (page two)');
    });
    await settle();
    expect(getByTestId('photograph-block-2-input').props.value).toBe('B (page two)');
    expect(queryByTestId('photograph-block-2-skeleton')).toBeNull();
    expect(getByTestId('photograph-block-1-skeleton')).toBeTruthy();

    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(3);
    await act(async () => {
      handles[0]?.resolve('A (page one)');
    });
    await act(async () => {
      handles[2]?.resolve('C (page three)');
    });

    await settle();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('A (page one)');
    expect(getByTestId('photograph-block-3-input').props.value).toBe('C (page three)');
  });
});

describe('JournalPhotographScreen — per-block error taxonomy across a run', () => {
  it.each(RETRY_KINDS)(
    'offers Retry on a %s block without disturbing the other, still-running page',
    async (kind) => {
      mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
      const handles = queueDeferredTranscriptions(2);
      const { getByTestId, queryByTestId } = renderScreen();
      await settle();
      fireEvent.press(getByTestId('capture-transcribe'));
      await settle();
      expect(mockTranscribe).toHaveBeenCalledTimes(2);

      await act(async () => {
        handles[0]?.reject(new TranscriptionError(kind, null));
      });
      await settle();
      expect(getByTestId('photograph-block-1-retry')).toBeTruthy();
      expect(queryByTestId('photograph-block-1-retake')).toBeNull();
      expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
      expect(getByTestId('photograph-block-2-skeleton')).toBeTruthy();
    },
  );

  it.each(RETAKE_KINDS)(
    'offers Retake on a %s block without disturbing the other, still-running page',
    async (kind) => {
      mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
      const handles = queueDeferredTranscriptions(2);
      const { getByTestId, queryByTestId } = renderScreen();
      await settle();
      fireEvent.press(getByTestId('capture-transcribe'));
      await settle();
      expect(mockTranscribe).toHaveBeenCalledTimes(2);

      await act(async () => {
        handles[0]?.reject(new TranscriptionError(kind, 422));
      });
      await settle();
      expect(getByTestId('photograph-block-1-retake')).toBeTruthy();
      expect(queryByTestId('photograph-block-1-retry')).toBeNull();
      expect(getByTestId('photograph-block-1-remove')).toBeTruthy();
    },
  );

  it('retakes just the failed page, calling the picker with a limit of one, substituting only that block', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await act(async () => {
      handles[0]?.reject(new TranscriptionError('invalid_image', 422));
    });
    await act(async () => {
      handles[1]?.resolve('page two text');
    });
    await settle();
    getByTestId('photograph-block-1-retake');

    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///retaken.jpg' })]));
    mockTranscribe.mockResolvedValueOnce({ text: 'page one retaken' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retake'));

    await settle();
    expect(mockPick).toHaveBeenNthCalledWith(2, 1);
    await settle();
    const block1Input = getByTestId('photograph-block-1-input');
    expect(block1Input.props.value).toBe('page one retaken');
    expect(getByTestId('photograph-block-2-input').props.value).toBe('page two text');
  });
});

describe('JournalPhotographScreen — retry replaces only its own block', () => {
  it('never re-charges a page that already succeeded when a different page retries', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      handles[0]?.resolve('page one text');
    });
    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });
    await settle();
    expect(getByTestId('photograph-block-2-retry')).toBeTruthy();

    mockTranscribe.mockResolvedValueOnce({ text: 'page two retried' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-2-retry'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(3);

    const imagesSent = mockTranscribe.mock.calls.map(
      (call) => (call[0] as { imageBase64: string }).imageBase64,
    );
    expect(imagesSent.filter((image) => image === preparedBase64('file:///p1.jpg'))).toHaveLength(
      1,
    );
    expect(imagesSent[2]).toBe(preparedBase64('file:///p2.jpg'));
  });
});

describe('JournalPhotographScreen — edited blocks are never clobbered', () => {
  it('keeps a hand-edited block intact while another page in the run is retried', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      handles[0]?.resolve('page one original');
    });
    await settle();
    fireEvent.changeText(getByTestId('photograph-block-1-input'), 'page one hand-edited');

    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });
    mockTranscribe.mockResolvedValueOnce({ text: 'page two retried' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-2-retry'));
    await settle();
    expect(getByTestId('photograph-block-2-input').props.value).toBe('page two retried');

    expect(getByTestId('photograph-block-1-input').props.value).toBe('page one hand-edited');
  });
});

describe('JournalPhotographScreen — redo a resolved block', () => {
  it('redoes an unedited block immediately, with no confirm step', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'first pass' });
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');

    mockTranscribe.mockResolvedValueOnce({ text: 'second pass' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-redo'));
    expect(queryByTestId('photograph-block-1-redo-confirm')).toBeNull();
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await settle();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('second pass');
  });

  it('requires an inline confirm before redoing an edited block, and leaves it untouched until confirmed', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'first pass' });
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'hand-edited');

    await settle();
    fireEvent.press(getByTestId('photograph-block-1-redo'));
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(getByTestId('photograph-block-1-input').props.value).toBe('hand-edited');
    await settle();
    expect(getByTestId('photograph-block-1-redo-confirm')).toBeTruthy();

    mockTranscribe.mockResolvedValueOnce({ text: 'redone text' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-redo-confirm'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await settle();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('redone text');
    expect(queryByTestId('photograph-block-1-redo-confirm')).toBeNull();
  });
});

describe('JournalPhotographScreen — save gate across the run', () => {
  it('disables Save while any page is unresolved, labels progress, and enables once every page settles', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    await settle();
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('photograph-run-progress')).toHaveTextContent('Transcribing 0 of 2…');

    await act(async () => {
      handles[0]?.resolve('page one');
    });
    await settle();
    expect(getByTestId('photograph-run-progress')).toHaveTextContent('Transcribing 1 of 2…');
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      handles[1]?.resolve('page two');
    });
    await settle();
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false);
  });

  // Kind-dependent: an unusable read is a recoverable, per-page failure. It
  // holds Save only until that page is dealt with, offers Retake, and never
  // raises the hand-typed offramp a terminal (key/model) failure does.
  it.each(['no_text_found', 'transcription_refused'] as const)(
    'holds Save on a %s page, offers Retake without the offramp, and frees Save on Remove',
    async (kind) => {
      mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
      const handles = queueDeferredTranscriptions(2);
      const { getByTestId, queryByTestId } = renderScreen();
      await settle();
      fireEvent.press(getByTestId('capture-transcribe'));
      await settle();
      expect(mockTranscribe).toHaveBeenCalledTimes(2);

      await act(async () => {
        handles[0]?.reject(new TranscriptionError(kind, 422));
      });
      await act(async () => {
        handles[1]?.resolve('page two');
      });
      expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);
      await settle();
      expect(getByTestId('photograph-block-1-retake')).toBeTruthy();
      expect(queryByTestId('photograph-typed-entry')).toBeNull();

      fireEvent.press(getByTestId('photograph-block-1-remove'));
      await settle();
      expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false);
      expect(queryByTestId('photograph-typed-entry')).toBeNull();
      expect(mockTranscribe).toHaveBeenCalledTimes(2);
    },
  );

  it('unblocks Save when a failed page is removed rather than retried', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      handles[0]?.resolve('page one');
    });
    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(true);

    await settle();
    fireEvent.press(getByTestId('photograph-block-2-remove'));
    await settle();
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false);
  });
});

describe('JournalPhotographScreen — remove every page mid-review (never a dead end)', () => {
  it('returns to the collect stage when the writer removes every page during review, instead of a permanently-disabled Save', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    // Both pages fail transiently, so each block offers Remove rather than a landed edit.
    await act(async () => {
      handles[0]?.reject(new TranscriptionError('network', null));
    });
    await act(async () => {
      handles[1]?.reject(new TranscriptionError('network', null));
    });

    await settle();
    fireEvent.press(getByTestId('photograph-block-2-remove'));
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-remove'));

    // No dead end: the disabled Save and the "Transcribing 0 of 0…" line are gone,
    // and we are back in collect where the writer can add pages again (from the
    // library or the camera) or leave cleanly.
    await settle();
    getByTestId('capture-add-pages');
    expect(getByTestId('capture-transcribe')).toBeTruthy();
    expect(getByTestId('capture-take-photo')).toBeTruthy();
    expect(queryByTestId('photograph-save')).toBeNull();
    expect(queryByTestId('photograph-run-progress')).toBeNull();
  });

  it('disarms the run on return to collect: a re-added page only transcribes on an explicit Transcribe, reading the fresh page and never the removed one', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    const handles = queueDeferredTranscriptions(1);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      handles[0]?.reject(new TranscriptionError('network', null));
    });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-remove'));
    await settle();
    getByTestId('capture-add-pages');

    // Re-add a fresh page. Because the run is disarmed, adding does not re-charge.
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///fresh.jpg' })]));
    await settle();
    fireEvent.press(getByTestId('capture-add-pages'));
    await settle();
    expect(mockPick).toHaveBeenCalledTimes(2);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);

    // Only an explicit Transcribe re-arms the run — and it reads the fresh page's
    // downscaled bytes (prepared once when the page was picked).
    mockTranscribe.mockResolvedValueOnce({ text: 'fresh page text' });
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await settle();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('fresh page text');
    expect(mockTranscribe.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ imageBase64: preparedBase64('file:///fresh.jpg') }),
    );
  });
});

describe('JournalPhotographScreen — merged save across pages', () => {
  it('saves the ordered, blank-line-merged text with edits winning', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const handles = queueDeferredTranscriptions(3);
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 40, message: 'A\n\nB-edited\n\nC' }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 40, status: 'finished' }));
    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      handles[1]?.resolve('B');
    });
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(3);
    await act(async () => {
      handles[0]?.resolve('A');
    });
    await act(async () => {
      handles[2]?.resolve('C');
    });
    await settle();
    fireEvent.changeText(getByTestId('photograph-block-2-input'), 'B-edited');

    await settle();
    expect(getByTestId('photograph-save').props.accessibilityState.disabled).toBe(false);
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalledWith(
      {
        message: 'A\n\nB-edited\n\nC',
        classification: 'personal',
      },
      KEYED,
    );
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

    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Edited by hand.');
    await settle();
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockUpdate).toHaveBeenCalledWith(99, { status: 'finished' });
    expect(mockCreate).toHaveBeenCalledWith(
      { message: 'Edited by hand.', classification: 'personal' },
      KEYED,
    );
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

    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'No entry_date please.');
    await settle();
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('entry_date');
  });

  it('keeps the edited text visible and offers Retry-save when saving fails', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));

    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'My hand-edited page.');
    await settle();
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(getByTestId('photograph-retry-save')).toBeTruthy();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('My hand-edited page.');
  });

  it('re-invokes save when Retry-save is tapped', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValue(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 99, status: 'finished' }));

    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Try again please.');
    await settle();
    fireEvent.press(getByTestId('photograph-save'));
    await settle();
    getByTestId('photograph-retry-save');
    fireEvent.press(getByTestId('photograph-retry-save'));

    await settle();
    expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', {
      entryId: 99,
      justSaved: true,
    });
    // The retry reuses the created id (no second create), so the page is never
    // duplicated and the wallet is never charged twice.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a Retry-save after a create whose answer was lost re-sends the same key (#2936)', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockRejectedValueOnce(new Error('network down'));
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 99 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 99, status: 'finished' }));

    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    fireEvent.changeText(getByTestId('photograph-block-1-input'), 'One page.');
    await settle();
    fireEvent.press(getByTestId('photograph-save'));
    await settle();
    getByTestId('photograph-retry-save');
    fireEvent.press(getByTestId('photograph-retry-save'));

    await settle();
    expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', {
      entryId: 99,
      justSaved: true,
    });
    const keys = mockCreate.mock.calls.map(
      (call) => (call[1] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(typeof keys[0]).toBe('string');
    expect(keys[1]).toBe(keys[0]);
    // Nothing changed here since the first attempt, so nothing but the status
    // is written over the replayed row: it may hold edits made elsewhere.
    expect(mockUpdate.mock.calls).toEqual([[99, { status: 'finished' }]]);
  });

  it('persists text edited after a failed save on the retry, without re-creating', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValue(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 99, status: 'finished' }));

    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    const input = getByTestId('photograph-block-1-input');
    fireEvent.changeText(input, 'Before the failure.');
    await settle();
    fireEvent.press(getByTestId('photograph-save'));
    await settle();
    getByTestId('photograph-retry-save');
    fireEvent.changeText(getByTestId('photograph-block-1-input'), 'Edited after the failure.');
    fireEvent.press(getByTestId('photograph-retry-save'));

    await settle();
    expect(navigation.replace).toHaveBeenCalled();
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

    const { getByTestId, getByLabelText } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('capture-entry-date');
    fireEvent.changeText(getByLabelText('Date'), yesterday);
    await settle();
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ entry_date: yesterday }),
    );
  });

  it('omits entry_date on Save when today is re-selected explicitly', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 22 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 22, status: 'finished' }));

    const { getByTestId, getByLabelText } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('capture-entry-date');
    fireEvent.changeText(getByLabelText('Date'), isoOffsetFromToday(-1));
    fireEvent.changeText(getByLabelText('Date'), isoOffsetFromToday(0));
    await settle();
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('entry_date');
  });

  it('clamps the entry-date picker to maxDate today', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });

    const { getByTestId, getByLabelText, getByText } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('capture-entry-date');
    const todayButton = getByLabelText('Select today');
    expect(todayButton.props.accessibilityState.disabled).toBe(false);

    fireEvent.changeText(getByLabelText('Date'), isoOffsetFromToday(1));
    expect(getByText(/Pick a date between/)).toBeTruthy();
  });
});

describe('JournalPhotographScreen — camera capture', () => {
  it('appends a captured photo after the existing pages, preserving order', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce(capturedPage('file:///cam1.jpg'));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(mockCapture).toHaveBeenCalledTimes(1);

    await settle();
    expect(getByTestId('capture-pages-list').props.data as Array<{ uri: string }>).toHaveLength(2);
    const data = getByTestId('capture-pages-list').props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual([
      preparedUri('file:///p1.jpg'),
      preparedUri('file:///cam1.jpg'),
    ]);
  });

  it('routes an unusable capture to the pick-failed offramp with Pick another, no retry', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce({ kind: 'failed' });
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(mockCapture).toHaveBeenCalledTimes(1);

    await settle();
    expect(getByTestId('photograph-error')).toBeTruthy();
    expect(getByTestId('photograph-pick-another')).toBeTruthy();
    expect(queryByTestId('photograph-retry')).toBeNull();
  });

  it('leaves the session unchanged and stays in collect when the camera is cancelled', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce({ kind: 'cancelled' });
    const { getByTestId, navigation } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(mockCapture).toHaveBeenCalledTimes(1);

    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data).toHaveLength(1);
    expect(navigation.goBack).not.toHaveBeenCalled();
  });
});

describe('JournalPhotographScreen — camera permission denied', () => {
  it('shows the camera-denied recovery view and opens device settings once', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce({ kind: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(getByTestId('camera-denied')).toBeTruthy();

    fireEvent.press(getByTestId('camera-open-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('returns to collect from Not now, keeping the pages and never going back or opening settings', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    mockCapture.mockResolvedValueOnce({ kind: 'denied' });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    const { getByTestId, navigation, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    getByTestId('camera-denied');

    fireEvent.press(getByTestId('camera-not-now'));

    expect(queryByTestId('camera-denied')).toBeNull();
    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data).toHaveLength(2);
    expect(data.map((p) => p.uri)).toEqual(uriList(2).map(preparedUri));
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('falls back to the library pick from Add from library, landing back in collect', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce({ kind: 'denied' });
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    getByTestId('camera-denied');
    expect(mockPick).toHaveBeenCalledTimes(1);

    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///lib2.jpg' })]));
    await settle();
    fireEvent.press(getByTestId('camera-add-from-library'));
    await settle();
    expect(mockPick).toHaveBeenCalledTimes(2);

    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual([
      preparedUri('file:///p1.jpg'),
      preparedUri('file:///lib2.jpg'),
    ]);
    expect(queryByTestId('camera-denied')).toBeNull();
  });
});

describe('JournalPhotographScreen — take-another loop', () => {
  it('offers Take another and Done after a capture, looping until Done returns to collect', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce(capturedPage('file:///cam2.jpg'));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(getByTestId('capture-take-another')).toBeTruthy();
    expect(getByTestId('capture-done')).toBeTruthy();
    expect(queryByTestId('capture-take-photo')).toBeNull();
    expect(queryByTestId('capture-add-pages')).toBeNull();
    expect(queryByTestId('capture-transcribe')).toBeNull();

    mockCapture.mockResolvedValueOnce(capturedPage('file:///cam3.jpg'));
    await settle();
    fireEvent.press(getByTestId('capture-take-another'));
    await settle();
    expect(mockCapture).toHaveBeenCalledTimes(2);

    await settle();
    fireEvent.press(getByTestId('capture-done'));
    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toEqual([
      preparedUri('file:///p1.jpg'),
      preparedUri('file:///cam2.jpg'),
      preparedUri('file:///cam3.jpg'),
    ]);
    expect(queryByTestId('capture-take-another')).toBeNull();
  });

  it('hides Take another when the capture fills the session, keeping only Done', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(9))));
    mockCapture.mockResolvedValueOnce(capturedPage('file:///cam10.jpg'));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(getByTestId('capture-done')).toBeTruthy();
    expect(queryByTestId('capture-take-another')).toBeNull();

    fireEvent.press(getByTestId('capture-done'));
    await settle();
    expect(getByTestId('capture-cap-notice')).toBeTruthy();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data).toHaveLength(10);
  });
});

describe('JournalPhotographScreen — camera pages feed the transcription run', () => {
  it('transcribes a camera-captured page alongside a library page once the set proceeds', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce(capturedPage('file:///cam2.jpg'));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    // Add a second page through the camera take-another loop, then settle into collect.
    await settle();
    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    fireEvent.press(getByTestId('capture-done'));

    // Proceeding runs the progressive transcription over both the library page and
    // the camera page: two blocks, in session order, each reading its own bytes.
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);

    await act(async () => {
      handles[0]?.resolve('library page');
    });
    await act(async () => {
      handles[1]?.resolve('camera page');
    });

    await settle();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('library page');
    expect(getByTestId('photograph-block-2-input').props.value).toBe('camera page');
    const images = mockTranscribe.mock.calls.map(
      (call) => (call[0] as { imageBase64: string }).imageBase64,
    );
    expect(images).toContain(preparedBase64('file:///cam2.jpg'));
  });
});

describe('JournalPhotographScreen — web guard', () => {
  it('never offers Take photo when running on web', async () => {
    const osDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });
    try {
      mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
      const { getByTestId, queryByTestId } = renderScreen();
      await settle();
      getByTestId('capture-pages-list');
      expect(queryByTestId('capture-take-photo')).toBeNull();
    } finally {
      if (osDescriptor) {
        Object.defineProperty(Platform, 'OS', osDescriptor);
      }
    }
  });
});

describe('JournalPhotographScreen — page preparation', () => {
  it('pipes every picked page through preparePageForTranscription with its picker uri', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    await settle();
    expect(mockPrepare).toHaveBeenCalledTimes(3);
    expect(mockPrepare).toHaveBeenCalledWith('file:///p1.jpg');
    expect(mockPrepare).toHaveBeenCalledWith('file:///p2.jpg');
    expect(mockPrepare).toHaveBeenCalledWith('file:///p3.jpg');
  });

  it('stores the prepared output uri on each page, keeping the picker uri as sourceUri', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId } = renderScreen();
    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string; sourceUri: string }>;
    expect(data.map((p) => p.uri)).toEqual(uriList(2).map(preparedUri));
    expect(data.map((p) => p.sourceUri)).toEqual(uriList(2));
  });

  it('pipes a camera capture through preparePageForTranscription before storing it', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    mockCapture.mockResolvedValueOnce(capturedPage('file:///cam1.jpg'));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-take-photo'));
    await settle();
    expect(mockPrepare).toHaveBeenCalledWith('file:///cam1.jpg');

    await settle();
    const list = getByTestId('capture-pages-list');
    const data = list.props.data as Array<{ uri: string }>;
    expect(data.map((p) => p.uri)).toContain(preparedUri('file:///cam1.jpg'));
  });
});

describe('JournalPhotographScreen — oversize page guard', () => {
  it('routes a page at the byte cap to the block image_too_large recovery without transcribing', async () => {
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///huge.jpg' })]));
    mockPrepare.mockResolvedValueOnce({
      base64: preparedBase64('file:///huge.jpg'),
      mediaType: 'image/jpeg',
      byteLength: MAX_TRANSCRIBE_IMAGE_BYTES,
      uri: preparedUri('file:///huge.jpg'),
    });
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));

    await settle();
    expect(getByTestId('photograph-block-1-error')).toHaveTextContent(/a little large/);
    // The photo itself is the problem, so the page offers Retake — never a
    // wallet-charging Retry — and no network call was ever spent.
    expect(getByTestId('photograph-block-1-retake')).toBeTruthy();
    expect(queryByTestId('photograph-block-1-retry')).toBeNull();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('still transcribes a page one byte under the cap', async () => {
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///near.jpg' })]));
    mockPrepare.mockResolvedValueOnce({
      base64: preparedBase64('file:///near.jpg'),
      mediaType: 'image/jpeg',
      byteLength: MAX_TRANSCRIBE_IMAGE_BYTES - 1,
      uri: preparedUri('file:///near.jpg'),
    });
    mockTranscribe.mockResolvedValueOnce({ text: 'fits' });
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));

    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });
});

describe('JournalPhotographScreen — transient file cleanup', () => {
  it('releases the page files once transcription succeeds', async () => {
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///p1.jpg' })]));
    mockTranscribe.mockResolvedValueOnce({ text: 'x' });
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');

    await settle();
    expect(mockReleasePageFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUri: 'file:///p1.jpg',
        uri: preparedUri('file:///p1.jpg'),
      }),
    );
  });

  it('releases only the removed page files when a page is removed from the strip', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(3))));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('capture-page-remove-2'));

    await settle();
    expect(mockReleasePageFiles).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUri: 'file:///p2.jpg' }),
    );
    expect(mockReleasePageFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceUri: 'file:///p1.jpg' }),
    );
    expect(mockReleasePageFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceUri: 'file:///p3.jpg' }),
    );
  });

  it('releases every session file on save', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 31 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 31, status: 'finished' }));

    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(navigation.replace).toHaveBeenCalled();
    expect(mockReleaseAllPageFiles).toHaveBeenCalled();
  });

  it('still navigates to the saved entry when file cleanup rejects', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 32 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 32, status: 'finished' }));
    mockReleasePageFiles.mockRejectedValue(new Error('cache is gone'));
    mockReleaseAllPageFiles.mockRejectedValue(new Error('cache is gone'));

    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', {
      entryId: 32,
      justSaved: true,
    });
  });

  it('releases every session file when stepping off to a typed entry', async () => {
    mockPick.mockResolvedValueOnce(picked());
    // The typed-entry offramp surfaces only on a terminal, config-level failure
    // the writer cannot retry past — model_lacks_vision — so drive the run there.
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));
    const { getByTestId, navigation } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    fireEvent.press(getByTestId('photograph-typed-entry'));

    await settle();
    expect(navigation.navigate).toHaveBeenCalledWith('JournalEntry');
    expect(mockReleaseAllPageFiles).toHaveBeenCalled();
  });

  it('releases every collected session file on unmount', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId, unmount } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    unmount();

    await settle();
    expect(mockReleaseAllPageFiles).toHaveBeenCalled();
    const [pagesArg] = mockReleaseAllPageFiles.mock.calls[0] ?? [];
    expect(pagesArg).toEqual([
      expect.objectContaining({ sourceUri: 'file:///p1.jpg' }),
      expect.objectContaining({ sourceUri: 'file:///p2.jpg' }),
    ]);
  });

  it('releases the removed page files when a page is removed mid-run', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const handles = queueDeferredTranscriptions(2);
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await act(async () => {
      handles[0]?.reject(new TranscriptionError('network', null));
    });

    // Drop the failed page while the other is still reading; its transient files
    // are reclaimed and the surviving page's are left untouched.
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-remove'));

    await settle();
    expect(mockReleasePageFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUri: 'file:///p1.jpg',
        uri: preparedUri('file:///p1.jpg'),
      }),
    );
    expect(mockReleasePageFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceUri: 'file:///p2.jpg' }),
    );
  });
});

describe('JournalPhotographScreen — one downscale per page', () => {
  it('never re-prepares a page across a transcription retry', async () => {
    mockPick.mockResolvedValueOnce(picked([pickedAsset({ uri: 'file:///p1.jpg' })]));
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-retry');
    expect(mockPrepare).toHaveBeenCalledTimes(1);

    // Retrying re-reads the already-downscaled bytes — the page is encoded once
    // when picked, never again on a re-read.
    mockTranscribe.mockResolvedValueOnce({ text: 'read on retry' });
    await settle();
    fireEvent.press(getByTestId('photograph-block-1-retry'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await settle();
    expect(getByTestId('photograph-block-1-input').props.value).toBe('read on retry');
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  });
});

describe('JournalPhotographScreen — privacy classification in collect', () => {
  it('renders the classification control in collect with personal selected by default', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    const control = getByTestId('capture-classification');
    expect(within(control).getByTestId('privacy-tier-public')).toBeTruthy();
    expect(within(control).getByTestId('privacy-tier-personal')).toBeTruthy();
    expect(within(control).getByTestId('privacy-tier-intimate')).toBeTruthy();
    expect(
      within(control).getByTestId('privacy-tier-personal').props.accessibilityState.selected,
    ).toBe(true);
  });

  it('disables Transcribe once intimate is selected', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');
    expect(getByTestId('capture-transcribe').props.accessibilityState.disabled).toBe(false);

    fireEvent.press(getByTestId('privacy-tier-intimate'));

    expect(getByTestId('capture-transcribe').props.accessibilityState.disabled).toBe(true);
  });

  it('renders the intimate gate: a transcription explainer plus type-instead and keep-personal', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('privacy-tier-intimate'));

    await settle();
    expect(getByTestId('capture-intimate-explainer')).toHaveTextContent(/transcri/i);
    expect(getByTestId('capture-type-instead')).toBeTruthy();
    expect(getByTestId('capture-keep-personal')).toBeTruthy();
  });

  it('shows no gate block for the personal default or after choosing public', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    expect(queryByTestId('capture-intimate-explainer')).toBeNull();
    expect(queryByTestId('capture-type-instead')).toBeNull();
    expect(queryByTestId('capture-keep-personal')).toBeNull();

    fireEvent.press(getByTestId('privacy-tier-public'));

    expect(queryByTestId('capture-intimate-explainer')).toBeNull();
    expect(queryByTestId('capture-type-instead')).toBeNull();
    expect(getByTestId('capture-transcribe').props.accessibilityState.disabled).toBe(false);
  });
});

describe('JournalPhotographScreen — intimate makes transcription structurally unreachable', () => {
  it('never calls transcribePage when Transcribe is pressed with intimate selected', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('privacy-tier-intimate'));
    // Hostile press: even if the disabled state were bypassed, the run must not start.
    fireEvent.press(getByTestId('capture-transcribe'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(queryByTestId('photograph-block-1-skeleton')).toBeNull();
    expect(queryByTestId('photograph-block-1-input')).toBeNull();
    expect(queryByTestId('photograph-save')).toBeNull();
    expect(getByTestId('capture-pages-list')).toBeTruthy();
  });
});

describe('JournalPhotographScreen — type-it-instead offramp for intimate', () => {
  it('releases the session images and leaves for a typed intimate entry without transcribing', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId, navigation } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('privacy-tier-intimate'));
    await settle();
    fireEvent.press(getByTestId('capture-type-instead'));

    await settle();
    expect(navigation.navigate).toHaveBeenCalledWith('JournalEntry', {
      classification: 'intimate',
    });
    expect(mockReleaseAllPageFiles).toHaveBeenCalled();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('sends only the scalar classification in the nav params, never any image payload', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    const { getByTestId, navigation } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('privacy-tier-intimate'));
    await settle();
    fireEvent.press(getByTestId('capture-type-instead'));
    await settle();
    expect(navigation.navigate).toHaveBeenCalled();

    const navCall = navigation.navigate.mock.calls.find((call) => call[0] === 'JournalEntry');
    const navParams = (navCall?.[1] ?? {}) as Record<string, unknown>;
    expect(Object.keys(navParams)).toEqual(['classification']);
    expect(navParams.classification).toBe('intimate');
    expect(JSON.stringify(navParams)).not.toMatch(/base64|image|page|uri|file:|prepared/i);
  });
});

describe('JournalPhotographScreen — keep as personal reverts the gate', () => {
  it('reverts to personal, re-enabling Transcribe and dropping the gate block', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(1))));
    const { getByTestId, queryByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');

    fireEvent.press(getByTestId('privacy-tier-intimate'));
    await settle();
    fireEvent.press(getByTestId('capture-keep-personal'));

    expect(getByTestId('privacy-tier-personal').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('privacy-tier-intimate').props.accessibilityState.selected).toBe(false);
    expect(getByTestId('capture-transcribe').props.accessibilityState.disabled).toBe(false);
    expect(queryByTestId('capture-intimate-explainer')).toBeNull();
    expect(queryByTestId('capture-type-instead')).toBeNull();
    expect(queryByTestId('capture-keep-personal')).toBeNull();
  });
});

describe('JournalPhotographScreen — classification threaded into save', () => {
  it('creates with classification personal by default after transcribe and save', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 61 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 61, status: 'finished' }));

    const { getByTestId } = renderScreen();
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ classification: 'personal' }),
    );
  });

  it('creates with classification public when public was chosen in collect', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 62 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 62, status: 'finished' }));

    const { getByTestId } = renderScreen();
    await settle();
    getByTestId('capture-pages-list');
    fireEvent.press(getByTestId('privacy-tier-public'));
    await settle();
    fireEvent.press(getByTestId('capture-transcribe'));
    await settle();
    getByTestId('photograph-block-1-input');
    fireEvent.press(getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ classification: 'public' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Append mode: the same capture, handed back to the page already being written
// ---------------------------------------------------------------------------

describe('JournalPhotographScreen — append into the open entry', () => {
  /** Drive one page through the shared capture flow to the review stage. */
  async function transcribeThenPress(
    screen: ReturnType<typeof renderAppendScreen>,
    confirmTestId: string,
  ): Promise<void> {
    await settle();
    fireEvent.press(screen.getByTestId('capture-transcribe'));
    await settle();
    screen.getByTestId('photograph-block-1-input');
    fireEvent.press(screen.getByTestId(confirmTestId));
  }

  it('offers Add-to-entry instead of Save-this-entry', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });

    const screen = renderAppendScreen();
    await settle();
    fireEvent.press(screen.getByTestId('capture-transcribe'));
    await settle();
    screen.getByTestId('photograph-block-1-input');

    expect(screen.getByTestId('photograph-append')).toBeTruthy();
    expect(screen.queryByTestId('photograph-save')).toBeNull();
  });

  it('hands the merged transcript back under the token it was opened with', async () => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    mockTranscribe.mockResolvedValueOnce({ text: 'Page one.' });
    mockTranscribe.mockResolvedValueOnce({ text: 'Page two.' });

    const screen = renderAppendScreen();
    await transcribeThenPress(screen, 'photograph-append');

    await settle();
    expect(useCapturedTranscriptStore.getState().pending).toEqual({
      token: APPEND_TOKEN,
      text: 'Page one.\n\nPage two.',
    });
  });

  it('creates no second entry — the open page owns the write', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });

    const screen = renderAppendScreen();
    await transcribeThenPress(screen, 'photograph-append');

    await settle();
    expect(screen.navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.navigation.replace).not.toHaveBeenCalled();
  });

  it('releases every page image once the transcript is handed back', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });

    const screen = renderAppendScreen();
    await transcribeThenPress(screen, 'photograph-append');

    await settle();
    expect(mockReleaseAllPageFiles).toHaveBeenCalled();
  });

  it('hands back the hand-edited transcript, not the raw transcription', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Misread scrawl.' });

    const screen = renderAppendScreen();
    await settle();
    fireEvent.press(screen.getByTestId('capture-transcribe'));
    await settle();
    fireEvent.changeText(screen.getByTestId('photograph-block-1-input'), 'What it actually said.');
    await settle();
    fireEvent.press(screen.getByTestId('photograph-append'));

    await settle();
    expect(useCapturedTranscriptStore.getState().pending?.text).toBe('What it actually said.');
  });

  it('withholds the entry-date row: the open page already has its own date', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });

    const screen = renderAppendScreen();
    await settle();
    screen.getByTestId('capture-pages-list');

    expect(screen.queryByTestId('capture-entry-date')).toBeNull();
  });

  it('still refuses to transcribe an intimate page', async () => {
    mockPick.mockResolvedValueOnce(picked());

    const screen = renderAppendScreen();
    await settle();
    screen.getByTestId('capture-pages-list');
    fireEvent.press(screen.getByTestId('privacy-tier-intimate'));
    expect(screen.getByTestId('capture-transcribe').props.accessibilityState.disabled).toBe(true);
    // Reach past the rendered button to the handler it was given, rather than
    // pressing it: a disabled press is swallowed before it arrives, so it can
    // only ever prove the disabled state. The claim under test is the SECOND
    // defence — that the gate itself refuses even when the first is bypassed.
    const control = screen.UNSAFE_getByProps({ testID: 'capture-transcribe' });
    await act(async () => {
      (control.props as { onPress: () => void }).onPress();
      await Promise.resolve();
    });

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(useCapturedTranscriptStore.getState().pending).toBeNull();
    expect(screen.queryByTestId('photograph-append')).toBeNull();
  });

  it('returns the writer to the page they were on from the intimate offramp', async () => {
    mockPick.mockResolvedValueOnce(picked());

    const screen = renderAppendScreen();
    await settle();
    screen.getByTestId('capture-pages-list');
    fireEvent.press(screen.getByTestId('privacy-tier-intimate'));
    await settle();
    fireEvent.press(screen.getByTestId('capture-type-instead'));

    await settle();
    expect(screen.navigation.goBack).toHaveBeenCalledTimes(1);
    expect(screen.navigation.navigate).not.toHaveBeenCalled();
    expect(mockReleaseAllPageFiles).toHaveBeenCalled();
  });

  it('returns the writer to the page they were on when transcription cannot work at all', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));

    const screen = renderAppendScreen();
    await settle();
    fireEvent.press(screen.getByTestId('capture-transcribe'));
    await settle();
    fireEvent.press(screen.getByTestId('photograph-typed-entry'));

    await settle();
    expect(screen.navigation.goBack).toHaveBeenCalledTimes(1);
    expect(screen.navigation.navigate).not.toHaveBeenCalled();
  });

  it('leaves the ordinary shelf capture saving a new entry, exactly as before', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 77 }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 77, status: 'finished' }));

    const screen = renderScreen();
    await transcribeThenPress(screen, 'photograph-save');

    await settle();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(useCapturedTranscriptStore.getState().pending).toBeNull();
    expect(screen.navigation.replace).toHaveBeenCalledWith('JournalEntry', {
      entryId: 77,
      justSaved: true,
    });
  });
});

describe('JournalPhotographScreen — overlapping screenshots (#2929)', () => {
  const PAGE_ONE = [
    'Sam: Are you still coming tonight?',
    'Me: Yes — leaving at 6.',
    'Sam: Can you grab ice on the way?',
    'Me: Sure, how many bags',
  ].join('\n');
  const PAGE_TWO = [
    'leaving at 6.',
    'Sam: Can you grab ice on the way?',
    'Me: Sure, how many bags?',
    'Sam: Two should do it. Thank you!',
  ].join('\n');
  const MERGED_ONCE = [
    'Sam: Are you still coming tonight?',
    'Me: Yes — leaving at 6.',
    'Sam: Can you grab ice on the way?',
    'Me: Sure, how many bags?',
    'Sam: Two should do it. Thank you!',
  ].join('\n');
  const KEPT_WHOLE = `${PAGE_ONE}\n\n${PAGE_TWO}`;

  /** Pick two overlapping screenshots and let both land their text. */
  async function readOverlappingPages(screen: ReturnType<typeof renderScreen>): Promise<void> {
    await settle();
    fireEvent.press(screen.getByTestId('capture-transcribe'));
    await settle();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    await settle();
    screen.getByTestId('photograph-block-2-input');
  }

  beforeEach(() => {
    mockPick.mockResolvedValueOnce(picked(pageAssets(uriList(2))));
    mockTranscribe.mockResolvedValueOnce({ text: PAGE_ONE });
    mockTranscribe.mockResolvedValueOnce({ text: PAGE_TWO });
  });

  it('saves a new entry with the repeated lines once, and says so on page 2', async () => {
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 41, message: MERGED_ONCE }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 41, status: 'finished' }));
    const screen = renderScreen();
    await readOverlappingPages(screen);

    expect(screen.getByTestId('photograph-block-2-overlap')).toBeTruthy();
    expect(screen.queryByTestId('photograph-block-1-overlap')).toBeNull();
    // The page's own text is untouched: only the merge is derived.
    expect(screen.getByTestId('photograph-block-2-input').props.value).toBe(PAGE_TWO);
    await settle();
    fireEvent.press(screen.getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalledWith(
      { message: MERGED_ONCE, classification: 'personal' },
      KEYED,
    );
  });

  it('saves every line after the writer keeps them', async () => {
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 42, message: KEPT_WHOLE }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 42, status: 'finished' }));
    const screen = renderScreen();
    await readOverlappingPages(screen);

    fireEvent.press(screen.getByTestId('photograph-block-2-overlap-keep'));
    expect(screen.queryByTestId('photograph-block-2-overlap')).toBeNull();
    expect(screen.getByTestId('photograph-block-2-overlap-kept')).toBeTruthy();
    await settle();
    fireEvent.press(screen.getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalledWith(
      { message: KEPT_WHOLE, classification: 'personal' },
      KEYED,
    );
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
  });

  it('hands the open entry the repeated lines once in append mode', async () => {
    const screen = renderAppendScreen();
    await readOverlappingPages(screen);
    await settle();
    fireEvent.press(screen.getByTestId('photograph-append'));

    await settle();
    expect(useCapturedTranscriptStore.getState().pending).toEqual({
      token: APPEND_TOKEN,
      text: MERGED_ONCE,
    });
  });

  it('saves a hand correction to a repeated line, and drops the notice', async () => {
    const corrected = PAGE_TWO.replace('grab ice', 'grab rice');
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 43, message: corrected }));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 43, status: 'finished' }));
    const screen = renderScreen();
    await readOverlappingPages(screen);

    fireEvent.changeText(screen.getByTestId('photograph-block-2-input'), corrected);
    expect(screen.queryByTestId('photograph-block-2-overlap')).toBeNull();
    await settle();
    fireEvent.press(screen.getByTestId('photograph-save'));

    await settle();
    expect(mockCreate).toHaveBeenCalledWith(
      {
        message: `${PAGE_ONE}\n\n${corrected}`,
        classification: 'personal',
      },
      KEYED,
    );
  });

  it('hands the open entry a hand correction to a repeated line in append mode', async () => {
    const corrected = PAGE_TWO.replace('grab ice', 'grab rice');
    const screen = renderAppendScreen();
    await readOverlappingPages(screen);
    fireEvent.changeText(screen.getByTestId('photograph-block-2-input'), corrected);
    await settle();
    fireEvent.press(screen.getByTestId('photograph-append'));

    await settle();
    expect(useCapturedTranscriptStore.getState().pending?.text).toBe(`${PAGE_ONE}\n\n${corrected}`);
  });

  it('hands the open entry every line after Keep them in append mode', async () => {
    const screen = renderAppendScreen();
    await readOverlappingPages(screen);
    fireEvent.press(screen.getByTestId('photograph-block-2-overlap-keep'));
    await settle();
    fireEvent.press(screen.getByTestId('photograph-append'));

    await settle();
    expect(useCapturedTranscriptStore.getState().pending?.text).toBe(KEPT_WHOLE);
  });
});
