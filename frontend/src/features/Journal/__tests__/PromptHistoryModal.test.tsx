/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import PromptHistoryModal from '../PromptHistoryModal';

import type { PromptDetail, PromptListResponse } from '@/api';

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
    <PromptHistoryModal
      visible={visible}
      onDismiss={jest.fn()}
      fetchHistory={fetchHistory as never}
    />,
  );
}

describe('PromptHistoryModal', () => {
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

  it('renders a prompt whose stored response is missing without crashing', async () => {
    const fetchHistory = jest.fn(async () => page([answered(4, { response: null })]));
    const utils = mount(fetchHistory as unknown as Fetch);
    await waitFor(() => expect(utils.getByTestId('prompt-history-row-4')).toBeTruthy());
    expect(utils.queryByTestId('prompt-history-response-4')).toBeNull();
  });
});
