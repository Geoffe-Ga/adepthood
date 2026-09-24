import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import type { ScaledSize } from 'react-native';

import AdminFeedbackScreen from '../AdminFeedbackScreen';

import { detail, OPERATOR_NOTE, REPORTER_PROSE, summary } from './fixtures';

import {
  ApiError,
  type FeedbackTriageDetailT,
  type FeedbackTriageSummaryT,
  type Page,
} from '@/api';
import { breakpoints, touchTarget } from '@/design/tokens';

const mockCapabilities = jest.fn<() => Promise<{ feedback_triage: boolean }>>();
const mockList = jest.fn<() => Promise<Page<FeedbackTriageSummaryT>>>();
const mockDetail = jest.fn<() => Promise<FeedbackTriageDetailT>>();
const mockTransition = jest.fn<() => Promise<FeedbackTriageDetailT>>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    adminFeedback: {
      capabilities: () => mockCapabilities(),
      list: () => mockList(),
      detail: () => mockDetail(),
      transition: (...args: unknown[]) => (mockTransition as (...a: unknown[]) => unknown)(...args),
    },
  };
});

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'operator-token' }),
}));

const PHONE: ScaledSize = { width: 375, height: 812, scale: 2, fontScale: 1 };
const DESKTOP: ScaledSize = { width: breakpoints.lg, height: 900, scale: 1, fontScale: 1 };
const HTTP_FORBIDDEN = 403;

function page(items: FeedbackTriageSummaryT[]): Page<FeedbackTriageSummaryT> {
  return { items, total: items.length, limit: 25, offset: 0, has_more: false };
}

function atWidth(size: ScaledSize): void {
  const rn = require('react-native') as { useWindowDimensions: () => ScaledSize };
  jest.spyOn(rn, 'useWindowDimensions').mockReturnValue(size);
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockCapabilities.mockReset();
  mockList.mockReset();
  mockDetail.mockReset();
  mockTransition.mockReset();
  mockList.mockResolvedValue(page([summary()]));
  mockDetail.mockResolvedValue(detail());
  atWidth(PHONE);
});

describe('AdminFeedbackScreen — the server decides who sees it', () => {
  it('shows the non-operator state on a 403 and never asks for the list', async () => {
    mockCapabilities.mockRejectedValue(new ApiError(HTTP_FORBIDDEN, 'admin_required'));
    const screen = render(<AdminFeedbackScreen />);

    await waitFor(() => expect(screen.getByTestId('admin-feedback-not-admin')).toBeTruthy());
    expect(screen.queryByTestId('inbox-list')).toBeNull();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('draws nothing admin-only while the answer is pending', () => {
    mockCapabilities.mockReturnValue(new Promise(() => undefined));
    const screen = render(<AdminFeedbackScreen />);

    expect(screen.getByTestId('admin-feedback-unknown')).toBeTruthy();
    expect(screen.queryByTestId('inbox-list')).toBeNull();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('shows the inbox once the server confirms an operator', async () => {
    mockCapabilities.mockResolvedValue({ feedback_triage: true });
    const screen = render(<AdminFeedbackScreen />);

    await waitFor(() => expect(screen.getByTestId('inbox-row-FB-23456789')).toBeTruthy());
    expect(mockList).toHaveBeenCalled();
  });
});

describe('AdminFeedbackScreen — layout', () => {
  beforeEach(() => {
    mockCapabilities.mockResolvedValue({ feedback_triage: true });
  });

  it('stacks on a phone: the list, then the report in its place', async () => {
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('admin-feedback-stacked')).toBeTruthy());
    expect(screen.queryByTestId('admin-feedback-split')).toBeNull();

    fireEvent.press(screen.getByTestId('inbox-row-FB-23456789'));

    await waitFor(() => expect(screen.getByTestId('detail-pane')).toBeTruthy());
    expect(screen.queryByTestId('inbox-list')).toBeNull();
    fireEvent.press(screen.getByTestId('detail-back'));
    expect(screen.getByTestId('inbox-list')).toBeTruthy();
  });

  it('splits at the large breakpoint: the list and the report side by side', async () => {
    atWidth(DESKTOP);
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('admin-feedback-split')).toBeTruthy());

    fireEvent.press(screen.getByTestId('inbox-row-FB-23456789'));

    await waitFor(() => expect(screen.getByTestId('detail-pane')).toBeTruthy());
    expect(screen.getByTestId('inbox-list')).toBeTruthy();
    expect(screen.queryByTestId('detail-back')).toBeNull();
  });
});

describe('DetailPane — three sources, kept apart', () => {
  async function openReport(): Promise<ReturnType<typeof render>> {
    mockCapabilities.mockResolvedValue({ feedback_triage: true });
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('inbox-row-FB-23456789')).toBeTruthy());
    fireEvent.press(screen.getByTestId('inbox-row-FB-23456789'));
    await waitFor(() => expect(screen.getByTestId('evidence-reporter-said')).toBeTruthy());
    return screen;
  }

  it('puts reporter prose only under "Reporter said" and notes only under "Operator added"', async () => {
    const screen = await openReport();
    const said = within(screen.getByTestId('evidence-reporter-said'));
    const attached = within(screen.getByTestId('evidence-app-attached'));
    const added = within(screen.getByTestId('evidence-operator-added'));

    expect(said.getByText(REPORTER_PROSE)).toBeTruthy();
    expect(said.queryByText(OPERATOR_NOTE)).toBeNull();
    expect(added.getByText(OPERATOR_NOTE)).toBeTruthy();
    expect(added.queryByText(REPORTER_PROSE)).toBeNull();
    expect(attached.queryByText(REPORTER_PROSE)).toBeNull();
    expect(attached.queryByText(OPERATOR_NOTE)).toBeNull();
    expect(attached.getByText('journal.shelf')).toBeTruthy();
  });

  it('announces each section as a header', async () => {
    const screen = await openReport();
    for (const title of ['Reporter said', 'App attached', 'Operator added']) {
      expect(screen.getByRole('header', { name: title })).toBeTruthy();
    }
  });

  it('labels its controls and keeps every target at the touch minimum', async () => {
    const screen = await openReport();
    expect(screen.getByLabelText('New private note')).toBeTruthy();
    expect(screen.getByLabelText('Canonical report reference, e.g. FB-7K3M9Q2B')).toBeTruthy();
    for (const testID of [
      'triage-transition-planned',
      'triage-transition-closed',
      'draft-note-7',
    ]) {
      const node = screen.getByTestId(testID);
      const flat = [node.props.style].flat(Infinity) as { minHeight?: number }[];
      const minHeight = Math.max(...flat.map((style) => style?.minHeight ?? 0));
      expect(minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
  });

  it('offers exactly the transitions the server allows, and sends the chosen one', async () => {
    mockTransition.mockResolvedValue(
      detail({
        operator_added: { ...detail().operator_added, status: 'planned' },
        allowed_transitions: ['closed'],
      }),
    );
    const screen = await openReport();
    expect(screen.queryByTestId('triage-transition-new')).toBeNull();
    expect(screen.queryByTestId('triage-transition-triaged')).toBeNull();

    fireEvent.press(screen.getByTestId('triage-transition-planned'));

    await waitFor(() => expect(mockTransition).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('triage-transition-planned')).toBeNull());
    expect(mockTransition).toHaveBeenCalledWith('FB-23456789', 'planned', 'operator-token');
  });
});

describe("DetailPane — the draft is the operator's own words", () => {
  it("shows the reporter's words for reference beside empty operator fields", async () => {
    mockCapabilities.mockResolvedValue({ feedback_triage: true });
    const screen = render(<AdminFeedbackScreen />);
    await waitFor(() => expect(screen.getByTestId('inbox-row-FB-23456789')).toBeTruthy());
    fireEvent.press(screen.getByTestId('inbox-row-FB-23456789'));
    await waitFor(() => expect(screen.getByTestId('draft-panel')).toBeTruthy());

    expect(
      within(screen.getByTestId('evidence-reporter-said')).getByText(REPORTER_PROSE),
    ).toBeTruthy();
    const title = screen.getByTestId('draft-operator-title');
    const body = screen.getByTestId('draft-operator-summary');
    expect(title.props.value).toBe('');
    expect(body.props.value).toBe('');
    expect(within(screen.getByTestId('draft-panel')).queryByText(REPORTER_PROSE)).toBeNull();
  });
});
