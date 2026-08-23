/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import React from 'react';

import { MAX_SEED_DOCUMENT_LABEL } from '../readSeedDocument';
import { SEED_CHOOSE_LABEL, SEED_CONSENT_LINK_LABEL, SEED_STATUS_LINES } from '../seedCopy';
import SeedCorpusScreen from '../SeedCorpusScreen';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch as unknown as typeof fetch;

const getDocumentAsync = DocumentPicker.getDocumentAsync as unknown as jest.Mock;
const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

const OVERSIZE_BYTES = 11 * 1024 * 1024;

function asset(name: string, size = 512) {
  return { name, uri: `file:///cache/${name}`, size, lastModified: 0 };
}

/** What `POST /corpus/import` answers an account that has a vault. */
function vaultReply(status: string) {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () =>
      Promise.resolve({
        destination: 'vault',
        stored: status === 'accepted',
        vault_status: status,
        vault_ref: null,
        tags: [],
        corpus_status: null,
        fragment_id: null,
        message: 'ok',
      }),
  });
}

/** What it answers an account that has connected none. */
function corpusReply(status: string) {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () =>
      Promise.resolve({
        destination: 'corpus',
        stored: status === 'stored',
        vault_status: null,
        vault_ref: null,
        tags: [],
        corpus_status: status,
        fragment_id: status === 'stored' ? 4 : null,
        message: 'ok',
      }),
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockFetch.mockReset();
  getDocumentAsync.mockReset();
  getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(512);
});

async function chooseFiles(getByTestId: (_id: string) => unknown) {
  await act(async () => {
    fireEvent.press(getByTestId('seed-choose-button') as never);
  });
}

describe('the empty screen', () => {
  test('invites rather than instructs', () => {
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    expect(getByTestId('seed-choose-button')).toBeTruthy();
    expect(getByText(SEED_CHOOSE_LABEL)).toBeTruthy();
  });

  test('shows the privacy tier the files will be stored at, before any pick', () => {
    const { getByTestId } = render(<SeedCorpusScreen />);

    expect(getByTestId('privacy-tier-personal')).toBeTruthy();
    expect(getByTestId('privacy-tier-intimate')).toBeTruthy();
  });
});

describe('choosing a tier before committing', () => {
  test('sends the chosen tier with the document', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { getByTestId } = render(<SeedCorpusScreen />);

    fireEvent.press(getByTestId('privacy-tier-intimate'));
    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
    });
  });
});

describe('per-document status', () => {
  test('lists each picked document under its own name', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md')],
    });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText('one.md')).toBeTruthy();
      expect(getByText('two.md')).toBeTruthy();
    });
  });

  test('a vault that cannot take files reads as its own thing, not as an error', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(vaultReply('capability_unsupported'));
    const { getByTestId, getByText, queryByText } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText(SEED_STATUS_LINES.capability_unsupported)).toBeTruthy();
    });
    expect(queryByText(SEED_STATUS_LINES.failed)).toBeNull();
    expect(queryByText(SEED_STATUS_LINES.degraded)).toBeNull();
  });

  test('an oversize document names the limit and is never sent', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('huge.pdf', OVERSIZE_BYTES)],
    });
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText(SEED_STATUS_LINES.too_large)).toBeTruthy();
    });
    expect(SEED_STATUS_LINES.too_large).toContain(MAX_SEED_DOCUMENT_LABEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('one failure mid-list leaves the others landed', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md')],
    });
    mockFetch
      .mockReturnValueOnce(vaultReply('accepted'))
      .mockReturnValueOnce(
        Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ detail: 'x' }) }),
      );
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText(SEED_STATUS_LINES.ingested)).toBeTruthy();
      expect(getByText(SEED_STATUS_LINES.failed)).toBeTruthy();
    });
  });

  test('summarises the run once everything has settled', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { getByTestId } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByTestId('seed-summary')).toHaveTextContent(/1/);
    });
  });
});

describe('a person who has no vault', () => {
  test('imports a document into their own corpus and is told so', async () => {
    // The journey the import route exists for. This account has connected no
    // vault; before the route, this screen told them their vault had not
    // answered and their corpus stayed empty.
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('notes.md')] });
    mockFetch.mockReturnValue(corpusReply('stored'));
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText(SEED_STATUS_LINES.in_corpus)).toBeTruthy();
    });
    expect(mockFetch.mock.calls[0][0]).toBe('http://test/corpus/import');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).filename).toBe('notes.md');
  });

  test('is offered the consent screen when the corpus is still switched off', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('notes.md')] });
    mockFetch.mockReturnValue(corpusReply('consent_required'));
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText(SEED_STATUS_LINES.consent_required)).toBeTruthy();
    });
    fireEvent.press(getByTestId('seed-consent-link'));
    expect(mockNavigate).toHaveBeenCalledWith('CorpusConsent');
    expect(getByText(SEED_CONSENT_LINK_LABEL)).toBeTruthy();
  });

  test('offers nothing about consent when nothing was held back for it', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('notes.md')] });
    mockFetch.mockReturnValue(corpusReply('stored'));
    const { getByTestId, queryByTestId } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByTestId('seed-summary')).toBeTruthy();
    });
    expect(queryByTestId('seed-consent-invitation')).toBeNull();
  });

  test('says an Intimate document stayed on the device, and why', async () => {
    // A guarantee rather than an error: placing writing among the frequencies
    // means showing it to a language model, and this tier never goes to one.
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('diary.md')] });
    mockFetch.mockReturnValue(corpusReply('tier_refused'));
    const { getByTestId, getByText } = render(<SeedCorpusScreen />);

    fireEvent.press(getByTestId('privacy-tier-intimate'));
    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByText(SEED_STATUS_LINES.tier_refused)).toBeTruthy();
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });
});

describe('a pick that yields nothing', () => {
  test('says so without treating it as a failure', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
    const { getByTestId } = render(<SeedCorpusScreen />);

    await chooseFiles(getByTestId);

    await waitFor(() => {
      expect(getByTestId('seed-notice')).toBeTruthy();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
