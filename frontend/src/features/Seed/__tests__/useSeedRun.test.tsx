/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

import { SEED_CANCELLED_NOTICE, SEED_FAILED_PICK_NOTICE } from '../seedCopy';
import { useSeedRun } from '../useSeedRun';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch as unknown as typeof fetch;

const getDocumentAsync = DocumentPicker.getDocumentAsync as unknown as jest.Mock;
const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

function asset(name: string) {
  return { name, uri: `file:///cache/${name}`, size: 512, lastModified: 0 };
}

function vaultReply(status: string) {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () => Promise.resolve({ status, vault_ref: null, tags: [], message: 'ok' }),
  });
}

function serverError() {
  return Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ detail: 'boom' }),
  });
}

function statuses(items: readonly { status: string }[]): string[] {
  return items.map((item) => item.status);
}

beforeEach(() => {
  mockFetch.mockReset();
  getDocumentAsync.mockReset();
  mocked.__fileBase64.mockReset();
  mocked.__fileSize.mockReset();
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(512);
});

describe('choosing a privacy tier', () => {
  test('starts on personal and travels with the upload', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { result } = renderHook(() => useSeedRun());

    expect(result.current.classification).toBe('personal');
    act(() => {
      result.current.chooseClassification('intimate');
    });
    await act(async () => {
      await result.current.choose();
    });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).classification).toBe('intimate');
  });
});

describe('a pick that yields nothing', () => {
  test('says so plainly when the picker was dismissed', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    expect(result.current.notice).toBe(SEED_CANCELLED_NOTICE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('says so plainly when the pick came back empty', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [] });
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    expect(result.current.notice).toBe(SEED_FAILED_PICK_NOTICE);
  });
});

describe('a multi-document run', () => {
  test('uploads one at a time, in pick order', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md')],
    });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).filename).toBe('one.md');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).filename).toBe('two.md');
  });

  test('a failure in the middle leaves the rest completed', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md'), asset('three.md')],
    });
    mockFetch
      .mockReturnValueOnce(vaultReply('accepted'))
      .mockReturnValueOnce(serverError())
      .mockReturnValueOnce(vaultReply('accepted'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    await waitFor(() => {
      expect(statuses(result.current.items)).toEqual(['ingested', 'failed', 'ingested']);
    });
  });

  test('a vault that cannot take files keeps that as its own outcome', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(vaultReply('capability_unsupported'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    expect(statuses(result.current.items)).toEqual(['capability_unsupported']);
  });

  test('an unreadable format never reaches the network but still shows up', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('installer.exe'), asset('one.md')],
    });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    expect(statuses(result.current.items)).toEqual(['unsupported_format', 'ingested']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a second pick appends to the run rather than replacing it', async () => {
    getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [asset('one.md')] });
    getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [asset('two.md')] });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });
    await act(async () => {
      await result.current.choose();
    });

    expect(result.current.items.map((item) => item.name)).toEqual(['one.md', 'two.md']);
    expect(result.current.tally).toEqual({ total: 2, ingested: 2, waiting: 0, refused: 0 });
  });

  test('reports itself idle once every document has settled', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(vaultReply('accepted'));
    const { result } = renderHook(() => useSeedRun());

    expect(result.current.isSending).toBe(false);
    await act(async () => {
      await result.current.choose();
    });

    expect(result.current.isSending).toBe(false);
  });
});
