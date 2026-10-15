import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, renderHook, within } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';

import { CorpusConsentRows } from '../CorpusConsentRows';
import { useCorpusConsent } from '../useCorpusConsent';

import { corpusConsent, setTokenGetter, type CorpusConsent } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { settle } from '@/testing/asyncSettle';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));
jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, corpusConsent: { list: jest.fn(), set: jest.fn() } };
});

const list = jest.mocked(corpusConsent.list);
const write = jest.mocked(corpusConsent.set);
const undecided: CorpusConsent = { source: 'journal', granted: false, decided_at: null };
const granted: CorpusConsent = { ...undecided, granted: true, decided_at: '2026-10-14T12:00:00Z' };

function credential(owner: number): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: String(owner), exp: 4102444800 })).toString('base64url')}.signature`;
}

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function surfaces() {
  return render(
    <>
      <View testID="hub">
        <CorpusConsentRows offeredOnly />
      </View>
      <View testID="detail">
        <CorpusConsentRows />
      </View>
    </>,
  );
}

beforeEach(() => {
  setActiveUser(1);
  setTokenGetter(() => credential(1));
  resetAllStores();
  jest.clearAllMocks();
  list.mockResolvedValue([undecided]);
});

test('coexisting hub and detail rows share one pending consent read', async () => {
  const held = deferred<CorpusConsent[]>();
  list.mockReturnValue(held.promise);
  const view = surfaces();
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    held.resolve([undecided]);
  });
  expect(view.getAllByTestId('corpus-consent-switch-journal')).toHaveLength(2);
});

test('a server-confirmed grant synchronizes both surfaces without optimistic consent', async () => {
  const view = surfaces();
  await settle();
  const held = deferred<CorpusConsent>();
  write.mockReturnValue(held.promise);
  fireEvent(
    within(view.getByTestId('hub')).getByTestId('corpus-consent-switch-journal'),
    'valueChange',
    true,
  );
  expect(
    view.getAllByTestId('corpus-consent-switch-journal').map((row) => row.props.value),
  ).toEqual([false, false]);
  await act(async () => {
    held.resolve(granted);
  });
  expect(
    view.getAllByTestId('corpus-consent-switch-journal').map((row) => row.props.value),
  ).toEqual([true, true]);
});

test('a refused grant preserves both confirmed switches', async () => {
  write.mockRejectedValue(new Error('refused'));
  const view = surfaces();
  await settle();
  fireEvent(
    within(view.getByTestId('hub')).getByTestId('corpus-consent-switch-journal'),
    'valueChange',
    true,
  );
  await settle();
  expect(
    view.getAllByTestId('corpus-consent-switch-journal').map((row) => row.props.value),
  ).toEqual([false, false]);
});

test('a retained outgoing decision callback cannot submit under a replacement session', async () => {
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  const oldDecide = hook.result.current.decide;
  act(() => resetAllStores());
  act(() => oldDecide('journal', true));
  expect(write).not.toHaveBeenCalled();
});

test('an older read cannot undo a newly confirmed grant', async () => {
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  const held = deferred<CorpusConsent[]>();
  list.mockReturnValueOnce(held.promise);
  act(() => {
    void hook.result.current.retry();
  });
  write.mockResolvedValueOnce(granted);
  act(() => hook.result.current.decide('journal', true));
  await settle();
  await act(async () => {
    held.resolve([undecided]);
  });
  expect(hook.result.current.decisions).toEqual([granted]);
});

test('two surfaces cannot issue concurrent writes for the same source', async () => {
  const held = deferred<CorpusConsent>();
  write.mockReturnValueOnce(held.promise);
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  act(() => {
    hook.result.current.decide('journal', true);
    hook.result.current.decide('journal', true);
  });
  expect(write).toHaveBeenCalledTimes(1);
  await act(async () => {
    held.resolve(granted);
  });
});

test('a late outgoing read cannot replace the reset session state', async () => {
  const held = deferred<CorpusConsent[]>();
  list.mockReturnValueOnce(held.promise);
  const hook = renderHook(() => useCorpusConsent());
  act(() => resetAllStores());
  await act(async () => {
    held.resolve([granted]);
  });
  expect(hook.result.current.decisions).toBeNull();
});

test('a failed read can be explicitly retried without removing the hub switches', async () => {
  list.mockRejectedValueOnce(new Error('offline'));
  const view = surfaces();
  await settle();
  expect(view.getAllByTestId('corpus-consent-error')).toHaveLength(2);
  fireEvent.press(within(view.getByTestId('hub')).getByTestId('corpus-consent-retry'));
  await settle();
  expect(list).toHaveBeenCalledTimes(2);
  expect(view.getAllByTestId('corpus-consent-switch-journal')).toHaveLength(2);
});

test('a reset outgoing write cannot clear the incoming source pending state', async () => {
  const outgoing = deferred<CorpusConsent>();
  const incoming = deferred<CorpusConsent>();
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  write.mockReturnValueOnce(outgoing.promise).mockReturnValueOnce(incoming.promise);
  act(() => hook.result.current.decide('journal', true));
  act(() => resetAllStores());
  await act(async () => {
    await hook.result.current.retry();
  });
  act(() => hook.result.current.decide('journal', true));
  await act(async () => {
    outgoing.resolve(granted);
  });
  expect(hook.result.current.pending).toEqual(['journal']);
  expect(hook.result.current.decisions).toEqual([undecided]);
  await act(async () => {
    incoming.resolve(granted);
  });
  expect(hook.result.current.pending).toEqual([]);
  expect(hook.result.current.decisions).toEqual([granted]);
});

test('unmounting one surface leaves the surviving surface and request alive', async () => {
  const held = deferred<CorpusConsent[]>();
  list.mockReturnValueOnce(held.promise);
  const hub = renderHook(() => useCorpusConsent());
  const detail = renderHook(() => useCorpusConsent());
  hub.unmount();
  await act(async () => {
    held.resolve([granted]);
  });
  expect(detail.result.current.decisions).toEqual([granted]);
  expect(list).toHaveBeenCalledTimes(1);
});

test('a retained unmounted callback stays quiet while another surface survives', async () => {
  const hub = renderHook(() => useCorpusConsent());
  const detail = renderHook(() => useCorpusConsent());
  await settle();
  const oldDecide = hub.result.current.decide;
  hub.unmount();
  act(() => oldDecide('journal', true));
  expect(write).not.toHaveBeenCalled();
  expect(detail.result.current.decisions).toEqual([undecided]);
});

test('a cancelled withdrawal writes nothing; confirmation synchronizes the other surface', async () => {
  list.mockResolvedValueOnce([granted]);
  const view = surfaces();
  await settle();
  const hub = within(view.getByTestId('hub'));
  fireEvent(hub.getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
  fireEvent.press(hub.getByTestId('corpus-consent-revoke-cancel-journal'));
  expect(write).not.toHaveBeenCalled();
  fireEvent(hub.getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
  write.mockResolvedValueOnce({ ...undecided, decided_at: '2026-10-14T12:01:00Z' });
  fireEvent.press(hub.getByTestId('corpus-consent-revoke-confirm-journal'));
  await settle();
  expect(
    view.getAllByTestId('corpus-consent-switch-journal').map((row) => row.props.value),
  ).toEqual([false, false]);
});

test('a replacement session cannot inherit an outgoing withdrawal question', async () => {
  list.mockResolvedValue([granted]);
  const controller = renderHook(() => useCorpusConsent());
  const view = surfaces();
  await settle();
  const hub = within(view.getByTestId('hub'));
  fireEvent(hub.getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
  expect(hub.getByTestId('corpus-consent-revoke-journal')).toBeTruthy();
  act(() => resetAllStores());
  await act(async () => {
    await controller.result.current.retry();
  });
  expect(hub.queryByTestId('corpus-consent-revoke-journal')).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

test('another surface replacing a confirmed decision retires the old withdrawal question', async () => {
  list.mockResolvedValue([granted]);
  const controller = renderHook(() => useCorpusConsent());
  const view = surfaces();
  await settle();
  const hub = within(view.getByTestId('hub'));
  fireEvent(hub.getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
  write.mockResolvedValueOnce({ ...undecided, decided_at: '2026-10-14T12:01:00Z' });
  act(() => controller.result.current.decide('journal', false));
  await settle();
  expect(hub.queryByTestId('corpus-consent-revoke-journal')).toBeNull();
});

test('a retained confirmation cannot withdraw a later grant', async () => {
  list.mockResolvedValue([granted]);
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  const question = { epoch: hook.result.current.epoch, decision: granted };
  write.mockResolvedValueOnce({ ...undecided, decided_at: '2026-10-14T12:01:00Z' });
  act(() => hook.result.current.decide('journal', false));
  await settle();
  write.mockResolvedValueOnce({ ...granted, decided_at: '2026-10-14T12:02:00Z' });
  act(() => hook.result.current.decide('journal', true));
  await settle();
  act(() => hook.result.current.decide('journal', false, question));
  expect(write).toHaveBeenCalledTimes(2);
  expect(hook.result.current.decisions?.[0]?.granted).toBe(true);
});

test('different sources settle independently without clearing each other pending state', async () => {
  const upload = { ...undecided, source: 'upload' };
  list.mockResolvedValue([undecided, upload]);
  const journalWrite = deferred<CorpusConsent>();
  const uploadWrite = deferred<CorpusConsent>();
  write.mockReturnValueOnce(journalWrite.promise).mockReturnValueOnce(uploadWrite.promise);
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  act(() => {
    hook.result.current.decide('journal', true);
    hook.result.current.decide('upload', true);
  });
  expect(hook.result.current.pending).toEqual(['journal', 'upload']);
  await act(async () => {
    journalWrite.resolve(granted);
  });
  expect(hook.result.current.pending).toEqual(['upload']);
  await act(async () => {
    uploadWrite.resolve({ ...upload, granted: true, decided_at: granted.decided_at });
  });
  expect(hook.result.current.pending).toEqual([]);
  expect(hook.result.current.decisions?.map((row) => row.granted)).toEqual([true, true]);
});

afterEach(() => {
  setActiveUser(null);
  setTokenGetter(null);
});

test('a retained callback cannot revive after a direct account ABA without store reset', async () => {
  setActiveUser(1);
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  const oldDecide = hook.result.current.decide;
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  act(() => oldDecide('journal', true));
  expect(write).not.toHaveBeenCalled();
});

test('an old read cannot install after a direct account ABA without store reset', async () => {
  setActiveUser(1);
  const held = deferred<CorpusConsent[]>();
  list.mockReturnValueOnce(held.promise);
  const hook = renderHook(() => useCorpusConsent());
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  await act(async () => held.resolve([granted]));
  expect(hook.result.current.decisions).toBeNull();
});

test('the shared read pins its initiating credential for client retries', async () => {
  setActiveUser(1);
  setTokenGetter(() => credential(1));
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  expect(list).toHaveBeenCalledWith(credential(1));
  expect(hook.result.current.decisions).toEqual([undecided]);
});

test('a confirmed write pins the credential captured at its invocation', async () => {
  setActiveUser(1);
  setTokenGetter(() => credential(1));
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  write.mockResolvedValueOnce(granted);
  act(() => hook.result.current.decide('journal', true));
  await settle();
  expect(write).toHaveBeenCalledWith('journal', true, credential(1));
  expect(hook.result.current.decisions).toEqual([granted]);
});

test('the newly rendered account can decide after an ABA while its old callback stays invalid', async () => {
  setActiveUser(1);
  const hook = renderHook(() => useCorpusConsent());
  await settle();
  const oldDecide = hook.result.current.decide;
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  hook.rerender({});
  write.mockResolvedValueOnce(granted);
  act(() => oldDecide('journal', true));
  expect(write).not.toHaveBeenCalled();
  act(() => hook.result.current.decide('journal', true));
  await settle();
  expect(write).toHaveBeenCalledTimes(1);
  expect(hook.result.current.decisions).toEqual([granted]);
});

test('a new ABA read starts independently of an outgoing held read', async () => {
  setActiveUser(1);
  const old = deferred<CorpusConsent[]>();
  list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([undecided]);
  const hook = renderHook(() => useCorpusConsent());
  act(() => {
    setActiveUser(2);
    setActiveUser(1);
  });
  hook.rerender({});
  act(() => {
    void hook.result.current.retry();
  });
  await settle();
  expect(list).toHaveBeenCalledTimes(2);
  expect(hook.result.current.decisions).toEqual([undecided]);
  await act(async () => {
    old.resolve([granted]);
  });
  expect(hook.result.current.decisions).toEqual([undecided]);
});

for (const unavailable of ['mismatched', 'missing getter', 'null token'] as const) {
  test(`credential admission prevents a ${unavailable} read from painting private consent`, async () => {
    setActiveUser(2);
    setTokenGetter(
      unavailable === 'missing getter'
        ? null
        : () => (unavailable === 'null token' ? null : credential(1)),
    );
    list.mockResolvedValue([granted]);
    const hook = renderHook(() => useCorpusConsent());
    await settle();
    expect(list).not.toHaveBeenCalled();
    expect(hook.result.current.decisions).toBeNull();
  });

  test(`credential admission prevents a ${unavailable} write from granting consent`, async () => {
    setActiveUser(2);
    setTokenGetter(() => credential(2));
    const hook = renderHook(() => useCorpusConsent());
    await settle();
    expect(hook.result.current.decisions).toEqual([undecided]);
    setTokenGetter(
      unavailable === 'missing getter'
        ? null
        : () => (unavailable === 'null token' ? null : credential(1)),
    );
    write.mockResolvedValue(granted);
    act(() => hook.result.current.decide('journal', true));
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(hook.result.current.decisions).toEqual([undecided]);
  });
}
