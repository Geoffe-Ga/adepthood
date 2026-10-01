import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import AdminFeedbackScreen from '../AdminFeedbackScreen';
import * as copy from '../copy';

import { detail, summary } from './fixtures';

import {
  ApiError,
  type FeedbackInboxFilters,
  type FeedbackTriageDetailT,
  type FeedbackTriageSummaryT,
  type Page,
} from '@/api';
import { settle } from '@/testing/asyncSettle';

type Detail = Promise<FeedbackTriageDetailT>;
const mockCapabilities = jest.fn<() => Promise<{ feedback_triage: boolean }>>();
const mockList =
  jest.fn<
    (
      _f: FeedbackInboxFilters,
      _w: { limit: number; offset: number },
    ) => Promise<Page<FeedbackTriageSummaryT>>
  >();
const mockDetail = jest.fn<() => Detail>();
const mockLink = jest.fn<(_id: string, _target: string) => Detail>();
const mockUnlink = jest.fn<(_id: string) => Detail>();
const mockNote = jest.fn<(_id: string, _body: string) => Detail>();
const mockTransition = jest.fn<(_id: string, _status: string) => Detail>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    adminFeedback: {
      capabilities: () => mockCapabilities(),
      list: (filters: FeedbackInboxFilters, window: { limit: number; offset: number }) =>
        mockList(filters, window),
      detail: () => mockDetail(),
      linkDuplicate: (id: string, target: string) => mockLink(id, target),
      unlinkDuplicate: (id: string) => mockUnlink(id),
      addNote: (id: string, body: string) => mockNote(id, body),
      transition: (id: string, status: string) => mockTransition(id, status),
    },
  };
});
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: 'operator-token' }) }));

const HTTP_SERVER_ERROR = 500;
const HTTP_CONFLICT = 409;
const ROW = 'inbox-row-FB-23456789';
const NEXT_ROW = 'inbox-row-FB-34567892';

/** The inbox rows' testIDs in render order, so an append is told from a prepend. */
function inboxOrder(screen: ReturnType<typeof render>): string[] {
  return screen.getAllByTestId(/^inbox-row-/).map((row) => String(row.props.testID));
}

/** The offset of every list request so far, in the order they were asked. */
function requestedOffsets(): number[] {
  return mockList.mock.calls.map(([, window]) => window.offset);
}

function page(items: FeedbackTriageSummaryT[], hasMore = false): Page<FeedbackTriageSummaryT> {
  return { items, total: items.length, limit: 25, offset: 0, has_more: hasMore };
}

async function openReport(): Promise<ReturnType<typeof render>> {
  const screen = render(<AdminFeedbackScreen />);
  await settle();
  expect(screen.getByTestId(ROW)).toBeTruthy();
  fireEvent.press(screen.getByTestId(ROW));
  await settle();
  expect(screen.getByTestId('triage-actions')).toBeTruthy();
  return screen;
}

beforeEach(() => {
  for (const mock of [
    mockCapabilities,
    mockList,
    mockDetail,
    mockLink,
    mockUnlink,
    mockNote,
    mockTransition,
  ]) {
    mock.mockReset();
  }
  mockCapabilities.mockResolvedValue({ feedback_triage: true });
  mockList.mockResolvedValue(page([summary()]));
  mockDetail.mockResolvedValue(detail());
});

describe('triage flows', () => {
  it('links a duplicate by the reference typed, trimmed', async () => {
    const linked = detail({
      operator_added: { ...detail().operator_added, duplicate_of: 'FB-34567892' },
    });
    mockLink.mockResolvedValue(linked);
    const screen = await openReport();

    fireEvent.changeText(screen.getByTestId('triage-duplicate-target'), '  FB-34567892 ');
    fireEvent.press(screen.getByTestId('triage-link-duplicate'));

    await settle();
    expect(mockLink).toHaveBeenCalledWith('FB-23456789', 'FB-34567892');
    await settle();
    expect(screen.getByTestId('triage-unlink-duplicate')).toBeTruthy();
  });

  it('clears a duplicate link', async () => {
    mockDetail.mockResolvedValue(
      detail({ operator_added: { ...detail().operator_added, duplicate_of: 'FB-34567892' } }),
    );
    mockUnlink.mockResolvedValue(detail());
    const screen = await openReport();

    fireEvent.press(screen.getByTestId('triage-unlink-duplicate'));

    await settle();
    expect(mockUnlink).toHaveBeenCalledWith('FB-23456789');
    await settle();
    expect(screen.queryByTestId('triage-unlink-duplicate')).toBeNull();
  });

  it('adds a note and empties the composer', async () => {
    mockNote.mockResolvedValue(detail());
    const screen = await openReport();

    fireEvent.changeText(screen.getByTestId('triage-note-body'), 'Reproduced.');
    fireEvent.press(screen.getByTestId('triage-add-note'));

    await settle();
    expect(mockNote).toHaveBeenCalledWith('FB-23456789', 'Reproduced.');
    expect(screen.getByTestId('triage-note-body').props.value).toBe('');
  });

  it('keeps the typed note when saving it fails', async () => {
    mockNote.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = await openReport();

    fireEvent.changeText(screen.getByTestId('triage-note-body'), 'a long careful note');
    fireEvent.press(screen.getByTestId('triage-add-note'));

    await settle();
    expect(mockNote).toHaveBeenCalled();
    await settle();
    expect(
      screen.getByText('That change was not saved. Refresh the report and try again.'),
    ).toBeTruthy();
    expect(screen.getByTestId('triage-note-body').props.value).toBe('a long careful note');
  });

  it('refreshes the inbox from the top after a change lands', async () => {
    mockTransition.mockResolvedValue(
      detail({ operator_added: { ...detail().operator_added, status: 'planned' } }),
    );
    mockList
      .mockResolvedValueOnce(page([summary({ status: 'triaged' })]))
      .mockResolvedValueOnce(page([summary({ status: 'planned' })]));
    const screen = await openReport();
    const listedBefore = mockList.mock.calls.length;

    fireEvent.press(screen.getByTestId('triage-transition-planned'));

    await settle();
    expect(mockList.mock.calls.length).toBe(listedBefore + 1);
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 25, offset: 0 });
  });

  it('refreshes the inbox from the top even after paging forward', async () => {
    // Guard (passes before #2996): the post-change refresh is ``reload``, never
    // ``retry`` -- once the list has paged past the first page, only a re-read
    // from offset 0 that replaces the list tells the two apart.
    mockTransition.mockResolvedValue(
      detail({ operator_added: { ...detail().operator_added, status: 'planned' } }),
    );
    mockList
      .mockResolvedValueOnce(page([summary()], true))
      .mockResolvedValueOnce(page([summary({ public_id: 'FB-34567892' })]))
      .mockResolvedValueOnce(page([summary({ status: 'planned' })]));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('inbox-load-more'));
    await settle();
    expect(inboxOrder(screen)).toEqual([ROW, NEXT_ROW]);
    fireEvent.press(screen.getByTestId(ROW));
    await settle();

    fireEvent.press(screen.getByTestId('triage-transition-planned'));

    await settle();
    expect(requestedOffsets()).toEqual([0, 25, 0]);
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 25, offset: 0 });
    fireEvent.press(screen.getByTestId('detail-back'));
    expect(inboxOrder(screen)).toEqual([ROW]);
  });

  it('says a refused change was not saved', async () => {
    mockNote.mockRejectedValue(new ApiError(HTTP_CONFLICT, 'feedback_transition_not_allowed'));
    const screen = await openReport();

    fireEvent.changeText(screen.getByTestId('triage-note-body'), 'x');
    fireEvent.press(screen.getByTestId('triage-add-note'));

    await settle();
    expect(
      screen.getByText('That change was not saved. Refresh the report and try again.'),
    ).toBeTruthy();
  });

  it('offers a retry when the report will not load', async () => {
    mockDetail.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    expect(screen.getByTestId(ROW)).toBeTruthy();
    fireEvent.press(screen.getByTestId(ROW));
    await settle();
    expect(screen.getByTestId('detail-retry')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-retry'));

    await settle();
    expect(screen.getByTestId('evidence-reporter-said')).toBeTruthy();
  });
});

describe('the inbox list', () => {
  it('filters by status', async () => {
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    expect(screen.getByTestId(ROW)).toBeTruthy();

    fireEvent.press(screen.getByTestId('inbox-filter-planned'));

    await settle();
    expect(mockList).toHaveBeenLastCalledWith({ status: 'planned' }, { limit: 25, offset: 0 });
  });

  it('pages forward and appends', async () => {
    mockList
      .mockResolvedValueOnce(page([summary()], true))
      .mockResolvedValueOnce(page([summary({ public_id: 'FB-34567892' })]));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    expect(screen.getByTestId('inbox-load-more')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inbox-load-more'));

    await settle();
    expect(screen.getByTestId('inbox-row-FB-34567892')).toBeTruthy();
    expect(screen.getByTestId(ROW)).toBeTruthy();
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 25, offset: 25 });
  });

  it('says when nothing matches', async () => {
    mockList.mockResolvedValue(page([]));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    expect(screen.getByText('No reports match this filter.')).toBeTruthy();
  });

  it('offers a retry when the list will not load', async () => {
    mockList.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    expect(screen.getByTestId('inbox-retry')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inbox-retry'));

    await settle();
    expect(screen.getByTestId(ROW)).toBeTruthy();
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(requestedOffsets()).toEqual([0, 0]);
  });

  it('retries a failed Load more at the same offset and keeps the rows shown', async () => {
    mockList
      .mockResolvedValueOnce(page([summary()], true))
      .mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'))
      .mockResolvedValueOnce(page([summary({ public_id: 'FB-34567892' })]));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('inbox-load-more'));
    await settle();
    expect(screen.getByText(copy.LOAD_FAILED)).toBeTruthy();
    expect(screen.getByTestId('inbox-retry')).toBeTruthy();
    expect(inboxOrder(screen)).toEqual([ROW]);

    fireEvent.press(screen.getByTestId('inbox-retry'));

    await settle();
    expect(mockList).toHaveBeenCalledTimes(3);
    expect(requestedOffsets()).toEqual([0, 25, 25]);
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 25, offset: 25 });
    expect(inboxOrder(screen)).toEqual([ROW, NEXT_ROW]);
    expect(screen.queryByTestId('inbox-retry')).toBeNull();
  });

  it('never skips a page when Load more is pressed after a failure', async () => {
    mockList
      .mockResolvedValueOnce(page([summary()], true))
      .mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'))
      .mockResolvedValueOnce(page([summary({ public_id: 'FB-34567892' })]));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('inbox-load-more'));
    await settle();
    expect(screen.getByTestId('inbox-retry')).toBeTruthy();
    expect(screen.getByTestId('inbox-load-more')).toBeTruthy();
    expect(inboxOrder(screen)).toEqual([ROW]);

    fireEvent.press(screen.getByTestId('inbox-load-more'));

    await settle();
    expect(mockList).toHaveBeenCalledTimes(3);
    expect(requestedOffsets()).toEqual([0, 25, 25]);
    expect(inboxOrder(screen)).toEqual([ROW, NEXT_ROW]);
  });

  it('keeps the active filter when retrying', async () => {
    mockList
      .mockResolvedValueOnce(page([summary()]))
      .mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'))
      .mockResolvedValueOnce(page([summary({ status: 'planned' })], true))
      .mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'))
      .mockResolvedValueOnce(page([summary({ public_id: 'FB-34567892', status: 'planned' })]));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('inbox-filter-planned'));
    await settle();
    fireEvent.press(screen.getByTestId('inbox-retry'));
    await settle();
    expect(mockList).toHaveBeenNthCalledWith(3, { status: 'planned' }, { limit: 25, offset: 0 });

    fireEvent.press(screen.getByTestId('inbox-load-more'));
    await settle();
    fireEvent.press(screen.getByTestId('inbox-retry'));

    await settle();
    expect(mockList).toHaveBeenCalledTimes(5);
    expect(requestedOffsets()).toEqual([0, 0, 0, 25, 25]);
    expect(mockList).toHaveBeenLastCalledWith({ status: 'planned' }, { limit: 25, offset: 25 });
    expect(inboxOrder(screen)).toEqual([ROW, NEXT_ROW]);
  });
});

describe('when access cannot be confirmed', () => {
  it('says so and asks again on request', async () => {
    mockCapabilities.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = render(<AdminFeedbackScreen />);
    await settle();
    expect(screen.getByTestId('admin-feedback-unavailable')).toBeTruthy();
    expect(mockList).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('admin-feedback-recheck'));

    await settle();
    expect(screen.getByTestId(ROW)).toBeTruthy();
  });
});
