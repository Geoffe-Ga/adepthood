import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import AdminFeedbackScreen from '../AdminFeedbackScreen';

import { detail, summary } from './fixtures';

import {
  ApiError,
  type FeedbackInboxFilters,
  type FeedbackTriageDetailT,
  type FeedbackTriageSummaryT,
  type Page,
} from '@/api';

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
    },
  };
});
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: 'operator-token' }) }));

const HTTP_SERVER_ERROR = 500;
const HTTP_CONFLICT = 409;
const ROW = 'inbox-row-FB-23456789';

function page(items: FeedbackTriageSummaryT[], hasMore = false): Page<FeedbackTriageSummaryT> {
  return { items, total: items.length, limit: 25, offset: 0, has_more: hasMore };
}

async function openReport(): Promise<ReturnType<typeof render>> {
  const screen = render(<AdminFeedbackScreen />);
  await waitFor(() => expect(screen.getByTestId(ROW)).toBeTruthy());
  fireEvent.press(screen.getByTestId(ROW));
  await waitFor(() => expect(screen.getByTestId('triage-actions')).toBeTruthy());
  return screen;
}

beforeEach(() => {
  for (const mock of [mockCapabilities, mockList, mockDetail, mockLink, mockUnlink, mockNote]) {
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

    await waitFor(() => expect(mockLink).toHaveBeenCalledWith('FB-23456789', 'FB-34567892'));
    await waitFor(() => expect(screen.getByTestId('triage-unlink-duplicate')).toBeTruthy());
  });

  it('clears a duplicate link', async () => {
    mockDetail.mockResolvedValue(
      detail({ operator_added: { ...detail().operator_added, duplicate_of: 'FB-34567892' } }),
    );
    mockUnlink.mockResolvedValue(detail());
    const screen = await openReport();

    fireEvent.press(screen.getByTestId('triage-unlink-duplicate'));

    await waitFor(() => expect(mockUnlink).toHaveBeenCalledWith('FB-23456789'));
    await waitFor(() => expect(screen.queryByTestId('triage-unlink-duplicate')).toBeNull());
  });

  it('adds a note and empties the composer', async () => {
    mockNote.mockResolvedValue(detail());
    const screen = await openReport();

    fireEvent.changeText(screen.getByTestId('triage-note-body'), 'Reproduced.');
    fireEvent.press(screen.getByTestId('triage-add-note'));

    await waitFor(() => expect(mockNote).toHaveBeenCalledWith('FB-23456789', 'Reproduced.'));
    expect(screen.getByTestId('triage-note-body').props.value).toBe('');
  });

  it('says a refused change was not saved', async () => {
    mockNote.mockRejectedValue(new ApiError(HTTP_CONFLICT, 'feedback_transition_not_allowed'));
    const screen = await openReport();

    fireEvent.changeText(screen.getByTestId('triage-note-body'), 'x');
    fireEvent.press(screen.getByTestId('triage-add-note'));

    await waitFor(() =>
      expect(
        screen.getByText('That change was not saved. Refresh the report and try again.'),
      ).toBeTruthy(),
    );
  });

  it('offers a retry when the report will not load', async () => {
    mockDetail.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId(ROW)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ROW));
    await waitFor(() => expect(screen.getByTestId('detail-retry')).toBeTruthy());

    fireEvent.press(screen.getByTestId('detail-retry'));

    await waitFor(() => expect(screen.getByTestId('evidence-reporter-said')).toBeTruthy());
  });
});

describe('the inbox list', () => {
  it('filters by status', async () => {
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId(ROW)).toBeTruthy());

    fireEvent.press(screen.getByTestId('inbox-filter-planned'));

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith({ status: 'planned' }, { limit: 25, offset: 0 }),
    );
  });

  it('pages forward and appends', async () => {
    mockList
      .mockResolvedValueOnce(page([summary()], true))
      .mockResolvedValueOnce(page([summary({ public_id: 'FB-34567892' })]));
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('inbox-load-more')).toBeTruthy());

    fireEvent.press(screen.getByTestId('inbox-load-more'));

    await waitFor(() => expect(screen.getByTestId('inbox-row-FB-34567892')).toBeTruthy());
    expect(screen.getByTestId(ROW)).toBeTruthy();
    expect(mockList).toHaveBeenLastCalledWith({}, { limit: 25, offset: 25 });
  });

  it('says when nothing matches', async () => {
    mockList.mockResolvedValue(page([]));
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByText('No reports match this filter.')).toBeTruthy());
  });

  it('offers a retry when the list will not load', async () => {
    mockList.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('inbox-retry')).toBeTruthy());

    fireEvent.press(screen.getByTestId('inbox-retry'));

    await waitFor(() => expect(screen.getByTestId(ROW)).toBeTruthy());
  });
});

describe('when access cannot be confirmed', () => {
  it('says so and asks again on request', async () => {
    mockCapabilities.mockRejectedValueOnce(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('admin-feedback-unavailable')).toBeTruthy());
    expect(mockList).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('admin-feedback-recheck'));

    await waitFor(() => expect(screen.getByTestId(ROW)).toBeTruthy());
  });
});
