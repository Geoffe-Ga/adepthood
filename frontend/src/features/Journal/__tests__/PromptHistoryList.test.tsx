/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import PromptHistoryList from '../PromptHistoryList';
import { usePromptHistory } from '../usePromptHistory';

import type { PromptDetail, PromptListResponse } from '@/api';
import { setActiveUser, getActiveUser } from '@/storage/userScope';

const ACCOUNT_A = 'x.eyJzdWIiOiIxIiwiZXhwIjo0MDAwMDAwMDAwfQ.y';
const ACCOUNT_B = 'x.eyJzdWIiOiIyIiwiZXhwIjo0MDAwMDAwMDAwfQ.y';
let mockToken = ACCOUNT_A;
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: mockToken }) }));
beforeEach(() => {
  mockToken = ACCOUNT_A;
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
});

function answered(week: number, overrides: Partial<PromptDetail> = {}): PromptDetail {
  return {
    week_number: week,
    question: `Question for week ${week}?`,
    has_responded: true,
    response: `What I wrote in week ${week}.`,
    timestamp: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function page(items: PromptDetail[], hasMore = false): PromptListResponse {
  return { items, total: items.length, has_more: hasMore };
}

type Fetch = (
  _params?: { limit?: number; offset?: number },
  _token?: string,
) => Promise<PromptListResponse>;

function mount(fetchHistory: Fetch, visible = true): ReturnType<typeof render> {
  return render(
    <PromptHistoryList
      visible={visible}
      onWrite={jest.fn()}
      fetchHistory={fetchHistory as never}
    />,
  );
}

describe('PromptHistoryList', () => {
  it('lists every past prompt with the answer the person wrote', async () => {
    const fetchHistory = jest.fn(async () => page([answered(3), answered(2)]));
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-row-3')).toBeTruthy());
    expect(utils.getByText('Question for week 3?')).toBeTruthy();
    expect(utils.getByText('What I wrote in week 3.')).toBeTruthy();
    expect(utils.getByTestId('prompt-history-row-2')).toBeTruthy();
  });

  it('does not fetch until it is opened', () => {
    const fetchHistory = jest.fn(async () => page([]));
    mount(fetchHistory as unknown as Fetch, false);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it('offers more only while the server says there is more', async () => {
    const fetchHistory = jest.fn(async () => page([answered(3)], false));
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-row-3')).toBeTruthy());
    expect(utils.queryByTestId('prompt-history-more')).toBeNull();
  });

  it('appends the next page at the offset the first page ended on', async () => {
    const fetchHistory = jest.fn(async (params?: { limit?: number; offset?: number }) =>
      (params?.offset ?? 0) === 0 ? page([answered(3)], true) : page([answered(2)], false),
    );
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-more')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('prompt-history-more'));
    });
    await waitFor(() => expect(utils.getByTestId('prompt-history-row-2')).toBeTruthy());
    expect(utils.getByTestId('prompt-history-row-3')).toBeTruthy();
    const second = fetchHistory.mock.calls[1];
    if (second === undefined) throw new Error('the second page was never requested');
    expect((second[0] as { offset?: number }).offset).toBe(1);
  });

  it('says so plainly when nothing has been answered yet', async () => {
    const fetchHistory = jest.fn(async () => page([]));
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-empty')).toBeTruthy());
  });

  it('reports a load failure instead of showing an empty history', async () => {
    const fetchHistory = jest.fn(async () => {
      throw new Error('history down');
    });
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-error')).toBeTruthy());
    expect(utils.queryByTestId('prompt-history-empty')).toBeNull();
  });

  it('keeps what already loaded, and the retry, when a later page fails', async () => {
    const fetchHistory = jest.fn(async (params?: { limit?: number; offset?: number }) => {
      if ((params?.offset ?? 0) === 0) return page([answered(3)], true);
      throw new Error('history down');
    });
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-more')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('prompt-history-more'));
    });
    await waitFor(() => expect(utils.getByTestId('prompt-history-error')).toBeTruthy());
    // A transient failure on page two must not throw away page one, nor the
    // only control that can ask for page two again.
    expect(utils.getByTestId('prompt-history-row-3')).toBeTruthy();
    expect(utils.getByTestId('prompt-history-more')).toBeTruthy();
  });

  it('clears a page failure once a retry succeeds', async () => {
    let failNext = true;
    const fetchHistory = jest.fn(async (params?: { limit?: number; offset?: number }) => {
      if ((params?.offset ?? 0) === 0) return page([answered(3)], true);
      if (failNext) {
        failNext = false;
        throw new Error('history down');
      }
      return page([answered(2)], false);
    });
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-more')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('prompt-history-more'));
    });
    await waitFor(() => expect(utils.getByTestId('prompt-history-error')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('prompt-history-more'));
    });
    await waitFor(() => expect(utils.getByTestId('prompt-history-row-2')).toBeTruthy());
    expect(utils.queryByTestId('prompt-history-error')).toBeNull();
  });

  it('renders a prompt whose stored response is missing without crashing', async () => {
    const fetchHistory = jest.fn(async () => page([answered(4, { response: null })]));
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-row-4')).toBeTruthy());
    expect(utils.queryByTestId('prompt-history-response-4')).toBeNull();
  });
});

it('offers a plain entry from a past question without replacing its stored response', async () => {
  const onWrite = jest.fn();
  const item = answered(3, { default_title: 'An earlier question' });
  const view = render(
    <PromptHistoryList visible onWrite={onWrite} fetchHistory={async () => page([item])} />,
  );
  const write = await view.findByTestId('prompt-history-write-3');
  expect(write.props.accessibilityLabel).toBe(
    'Write about this: start a new entry from the week 3 prompt',
  );
  fireEvent.press(write);
  expect(onWrite).toHaveBeenCalledWith(item);
  expect(view.getByText('What I wrote in week 3.')).toBeTruthy();
});

it('can retry the first page without leaving Prompts', async () => {
  const fetchHistory = jest
    .fn<Fetch>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(page([answered(2)]));
  const view = mount(fetchHistory);
  fireEvent.press(await view.findByTestId('prompt-history-retry'));
  expect(await view.findByTestId('prompt-history-row-2')).toBeTruthy();
});

it('keeps a late history response in its original account when the active owner changes', async () => {
  const previousOwner = getActiveUser();
  let finish!: (_page: PromptListResponse) => void;
  const fetchHistory = jest
    .fn<Fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(page([answered(2, { question: 'The incoming account question' })]));
  setActiveUser(1);
  try {
    const { result, rerender } = renderHook(() => usePromptHistory(true, fetchHistory));
    await act(async () => setActiveUser(2));
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    mockToken = ACCOUNT_B;
    rerender({});
    await waitFor(() =>
      expect(result.current.items[0]?.question).toBe('The incoming account question'),
    );
    await act(async () =>
      finish(page([answered(1, { question: 'The outgoing account question' })])),
    );
    expect(result.current.items.map((item: PromptDetail) => item.question)).toEqual([
      'The incoming account question',
    ]);
  } finally {
    await act(async () => setActiveUser(previousOwner));
  }
});

it('renders historical Markdown as readable text while keeping the original question for writing', async () => {
  const item = answered(3, { question: '**What matters?**', response: '- A *quiet* morning.' });
  const onWrite = jest.fn();
  const view = render(
    <PromptHistoryList visible onWrite={onWrite} fetchHistory={async () => page([item])} />,
  );
  expect(await view.findByText('What matters?')).toBeTruthy();
  expect(view.getByText('A quiet morning.')).toBeTruthy();
  fireEvent.press(view.getByTestId('prompt-history-write-3'));
  expect(onWrite).toHaveBeenCalledWith(item);
});
