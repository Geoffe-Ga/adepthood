/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import type { PickResult } from '../pickJournalPhoto';

import { TranscriptionError } from '@/api';
import type { JournalMessage, MediaType, TranscribePageT, TranscriptionErrorKind } from '@/api';

const mockPick = jest.fn() as jest.MockedFunction<() => Promise<PickResult>>;
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
    pickJournalPhoto: (...a: unknown[]) =>
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

const JournalPhotographScreen = require('../JournalPhotographScreen').default;

function picked(overrides: Partial<Extract<PickResult, { kind: 'picked' }>> = {}): PickResult {
  return { kind: 'picked', imageBase64: 'abc123', mediaType: 'image/jpeg', ...overrides };
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

describe('JournalPhotographScreen — cancelled pick', () => {
  it('goes back immediately with no lingering UI', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    const { navigation, queryByTestId } = renderScreen();
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(queryByTestId('photograph-transcribing')).toBeNull();
    expect(queryByTestId('photograph-error')).toBeNull();
    expect(queryByTestId('photograph-permission-denied')).toBeNull();
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

describe('JournalPhotographScreen — transcribing', () => {
  it('shows the transcribing state while the request is in flight', async () => {
    mockPick.mockResolvedValueOnce(picked());
    let resolveTranscribe!: (_v: TranscribePageT) => void;
    mockTranscribe.mockReturnValueOnce(
      new Promise<TranscribePageT>((res) => {
        resolveTranscribe = res;
      }),
    );
    const { findByTestId } = renderScreen();
    expect(await findByTestId('photograph-transcribing')).toBeTruthy();
    await act(async () => {
      resolveTranscribe({ text: 'done' });
    });
  });

  it('sends the picked image + media type to transcribePage', async () => {
    mockPick.mockResolvedValueOnce(picked({ imageBase64: 'b64data', mediaType: 'image/png' }));
    mockTranscribe.mockResolvedValueOnce({ text: 'x' });
    renderScreen();
    await waitFor(() =>
      expect(mockTranscribe).toHaveBeenCalledWith({
        imageBase64: 'b64data',
        mediaType: 'image/png',
      }),
    );
  });
});

describe('JournalPhotographScreen — editable preview', () => {
  it('seeds the preview input with the transcribed text', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'A page about the willow.' });
    const { findByTestId } = renderScreen();
    const input = await findByTestId('photograph-preview-input');
    expect(input.props.value).toBe('A page about the willow.');
    expect(await findByTestId('photograph-save')).toBeTruthy();
  });

  it('lets the writer edit the seeded text', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    const { findByTestId, getByTestId } = renderScreen();
    const input = await findByTestId('photograph-preview-input');
    fireEvent.changeText(input, 'Original, corrected.');
    expect(getByTestId('photograph-preview-input').props.value).toBe('Original, corrected.');
  });
});

const RETRY_KINDS: TranscriptionErrorKind[] = [
  'provider_error',
  'network',
  'timeout',
  'rate_limited',
];
const PICK_ANOTHER_KINDS: TranscriptionErrorKind[] = ['invalid_image', 'image_too_large'];

describe('JournalPhotographScreen — transcription error recovery', () => {
  it.each(RETRY_KINDS)('offers retry (not pick-another) for a %s failure', async (kind) => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, null));
    const { findByTestId, queryByTestId } = renderScreen();
    expect(await findByTestId('photograph-retry')).toBeTruthy();
    expect(queryByTestId('photograph-pick-another')).toBeNull();
  });

  it.each(PICK_ANOTHER_KINDS)('offers Pick another (not retry) for a %s failure', async (kind) => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError(kind, 422));
    const { findByTestId, queryByTestId } = renderScreen();
    expect(await findByTestId('photograph-pick-another')).toBeTruthy();
    expect(queryByTestId('photograph-retry')).toBeNull();
  });

  it('offers both retry and a typed-entry offramp for an unknown failure', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('unknown', null));
    const { findByTestId } = renderScreen();
    expect(await findByTestId('photograph-retry')).toBeTruthy();
    expect(await findByTestId('photograph-typed-entry')).toBeTruthy();
  });

  it('shows the wallet-exhausted copy with a typed-entry offramp and no retry', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('wallet_exhausted', 402));
    const { findByTestId, queryByTestId, getByTestId } = renderScreen();
    await findByTestId('photograph-error');
    expect(getByTestId('photograph-error')).toHaveTextContent(/this month's free allotment/);
    expect(await findByTestId('photograph-typed-entry')).toBeTruthy();
    expect(queryByTestId('photograph-retry')).toBeNull();
  });

  it('shows a terminal, friendly message for model_lacks_vision with a typed-entry offramp, no retry', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('model_lacks_vision', 422));
    const { findByTestId, queryByTestId, getByTestId } = renderScreen();
    await findByTestId('photograph-error');
    expect(getByTestId('photograph-error')).toHaveTextContent(/isn't available/);
    expect(await findByTestId('photograph-typed-entry')).toBeTruthy();
    expect(queryByTestId('photograph-retry')).toBeNull();
  });

  it('navigates to a plain JournalEntry from the typed-entry offramp', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('wallet_exhausted', 402));
    const { findByTestId, navigation } = renderScreen();
    fireEvent.press(await findByTestId('photograph-typed-entry'));
    expect(navigation.navigate).toHaveBeenCalledWith('JournalEntry');
  });

  it('calls transcribePage exactly once more per retry tap, never auto-retrying', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    const { findByTestId } = renderScreen();
    await findByTestId('photograph-retry');
    expect(mockTranscribe).toHaveBeenCalledTimes(1);

    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('network', null));
    fireEvent.press(await findByTestId('photograph-retry'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(2));

    mockTranscribe.mockResolvedValueOnce({ text: 'ok' });
    fireEvent.press(await findByTestId('photograph-retry'));
    await waitFor(() => expect(mockTranscribe).toHaveBeenCalledTimes(3));
  });

  it('re-launches the picker from Pick another', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockRejectedValueOnce(new TranscriptionError('invalid_image', 422));
    const { findByTestId } = renderScreen();
    await findByTestId('photograph-pick-another');
    expect(mockPick).toHaveBeenCalledTimes(1);

    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    fireEvent.press(await findByTestId('photograph-pick-another'));
    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(2));
  });
});

describe('JournalPhotographScreen — save flow', () => {
  it('saves the edited preview text (not the original transcription) and replaces to the finished entry', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original transcribed text.' });
    mockCreate.mockResolvedValueOnce(makeEntry({ id: 99, message: 'Edited by hand.' }));
    mockUpdate.mockResolvedValueOnce(
      makeEntry({ id: 99, message: 'Edited by hand.', status: 'finished' }),
    );

    const { findByTestId, navigation } = renderScreen();
    const input = await findByTestId('photograph-preview-input');
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
    const input = await findByTestId('photograph-preview-input');
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
    const input = await findByTestId('photograph-preview-input');
    fireEvent.changeText(input, 'My hand-edited page.');
    fireEvent.press(await findByTestId('photograph-save'));

    expect(await findByTestId('photograph-retry-save')).toBeTruthy();
    expect(getByTestId('photograph-preview-input').props.value).toBe('My hand-edited page.');
  });

  it('re-invokes save when Retry-save is tapped', async () => {
    mockPick.mockResolvedValueOnce(picked());
    mockTranscribe.mockResolvedValueOnce({ text: 'Original.' });
    mockCreate.mockResolvedValue(makeEntry({ id: 99 }));
    mockUpdate.mockRejectedValueOnce(new Error('network down'));
    mockUpdate.mockResolvedValueOnce(makeEntry({ id: 99, status: 'finished' }));

    const { findByTestId, getByTestId, navigation } = renderScreen();
    const input = await findByTestId('photograph-preview-input');
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
    const input = await findByTestId('photograph-preview-input');
    fireEvent.changeText(input, 'Before the failure.');
    fireEvent.press(await findByTestId('photograph-save'));
    await findByTestId('photograph-retry-save');
    fireEvent.changeText(getByTestId('photograph-preview-input'), 'Edited after the failure.');
    fireEvent.press(getByTestId('photograph-retry-save'));

    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenLastCalledWith(99, {
      message: 'Edited after the failure.',
      status: 'finished',
    });
  });
});
