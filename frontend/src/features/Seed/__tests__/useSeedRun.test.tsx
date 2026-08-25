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
        fragment_id: status === 'stored' ? 1 : null,
        message: 'ok',
      }),
  });
}

/** A reply the test holds open, so the run can be interfered with mid-flight. */
function heldVaultReply(): { reply: Promise<unknown>; release: () => void } {
  let release = (): void => undefined;
  const reply = new Promise<unknown>((resolve) => {
    release = (): void => {
      resolve({
        ok: true,
        status: 202,
        json: () =>
          Promise.resolve({
            destination: 'vault',
            stored: true,
            vault_status: 'accepted',
            vault_ref: null,
            tags: [],
            corpus_status: null,
            fragment_id: null,
            message: 'ok',
          }),
      });
    };
  });
  return { reply, release };
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
    expect(result.current.tally).toEqual({ total: 2, landed: 2, waiting: 0, refused: 0 });
  });

  test('lands a document in the corpus for an account that has no vault', async () => {
    // The whole point of the import route: one request, and the server decides
    // where it goes. This account never had a vault, so nothing here waits on
    // one and the document is theirs to find in reflections.
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(corpusReply('stored'));
    const { result } = renderHook(() => useSeedRun());

    await act(async () => {
      await result.current.choose();
    });

    expect(statuses(result.current.items)).toEqual(['in_corpus']);
    expect(result.current.tally).toEqual({ total: 1, landed: 1, waiting: 0, refused: 0 });
    expect(mockFetch.mock.calls[0][0]).toBe('http://test/corpus/import');
    expect(result.current.needsConsent).toBe(false);
  });

  test('raises the consent question only once the server has asked it', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset('one.md')] });
    mockFetch.mockReturnValue(corpusReply('consent_required'));
    const { result } = renderHook(() => useSeedRun());

    expect(result.current.needsConsent).toBe(false);
    await act(async () => {
      await result.current.choose();
    });

    expect(statuses(result.current.items)).toEqual(['consent_required']);
    expect(result.current.needsConsent).toBe(true);
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

describe('leaving a run part-way through', () => {
  test('cancelling stops the loop rather than uploading the rest anyway', async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md'), asset('three.md')],
    });
    const { result } = renderHook(() => useSeedRun());
    mockFetch.mockImplementation(() => {
      result.current.cancel();
      return vaultReply('accepted');
    });

    await act(async () => {
      await result.current.choose();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(statuses(result.current.items)).toEqual(['ingested', 'cancelled', 'cancelled']);
  });

  test('unmounting stops the loop, so the screen and the server agree', async () => {
    // The defect this run exists to close: the loop is held by the callback's
    // stack, not by React, so an unmount used to leave it uploading on in the
    // background while the person saw an empty screen.
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md'), asset('three.md')],
    });
    const held = heldVaultReply();
    mockFetch.mockReturnValueOnce(held.reply).mockReturnValue(vaultReply('accepted'));
    const { result, unmount } = renderHook(() => useSeedRun());
    let run: Promise<void> = Promise.resolve();
    act(() => {
      run = result.current.choose();
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    unmount();
    await act(async () => {
      held.release();
      await run;
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('cancelling before anything was ever picked is a no-op', () => {
    const { result } = renderHook(() => useSeedRun());

    act(() => {
      result.current.cancel();
    });

    expect(result.current.items).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a run that was never cancelled still sends every document', async () => {
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
    expect(statuses(result.current.items)).toEqual(['ingested', 'ingested']);
  });

  test('a picker dismissed after a cancelled run leaves the earlier outcomes alone', async () => {
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [asset('one.md'), asset('two.md')],
    });
    getDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    const { result } = renderHook(() => useSeedRun());
    mockFetch.mockImplementation(() => {
      result.current.cancel();
      return vaultReply('accepted');
    });

    await act(async () => {
      await result.current.choose();
    });
    await act(async () => {
      await result.current.choose();
    });

    expect(statuses(result.current.items)).toEqual(['ingested', 'cancelled']);
    expect(result.current.notice).toBe(SEED_CANCELLED_NOTICE);
  });
});

describe('the tier a cancelled run had already committed to', () => {
  test('a tier changed mid-run never reaches a document the run already picked', async () => {
    // The tier travels with the batch by value, so this holds by construction:
    // the run cannot retroactively re-file writing at a tier nobody chose for it.
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [asset('one.md'), asset('two.md')],
    });
    const { result } = renderHook(() => useSeedRun());
    mockFetch.mockImplementation(() => {
      result.current.chooseClassification('intimate');
      return vaultReply('accepted');
    });

    await act(async () => {
      await result.current.choose();
    });

    const tiers = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).classification);
    expect(tiers).toEqual(['personal', 'personal']);
  });
});
