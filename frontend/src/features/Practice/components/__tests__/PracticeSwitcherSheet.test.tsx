/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { PracticeItem, UserPractice } from '@/api';

const samplePractices: PracticeItem[] = [
  {
    id: 1,
    stage_number: 5,
    name: 'Concentration on the breath',
    description: 'Anchor attention in the breath cycle.',
    instructions: '',
    default_duration_minutes: 10,
    submitted_by_user_id: null,
    approved: true,
  },
  {
    id: 2,
    stage_number: 5,
    name: 'Mantra repetition',
    description: 'Repeat a chosen phrase to settle the mind.',
    instructions: '',
    default_duration_minutes: 12,
    submitted_by_user_id: null,
    approved: true,
  },
  {
    id: 3,
    stage_number: 5,
    name: 'Body-mind scan',
    description: 'Sweep attention from crown to soles.',
    instructions: '',
    default_duration_minutes: 15,
    submitted_by_user_id: null,
    approved: true,
  },
];

const createdUserPractice: UserPractice = {
  id: 999,
  user_id: 1,
  practice_id: 2,
  stage_number: 5,
  start_date: '2026-05-11',
  end_date: null,
};

const mockPracticesList = jest.fn() as jest.MockedFunction<
  (stageNumber: number) => Promise<PracticeItem[]>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    listAll: (...args: unknown[]) =>
      (mockPracticesList as unknown as (...a: unknown[]) => Promise<PracticeItem[]>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
  },
}));

const { PracticeSwitcherSheet } = require('../PracticeSwitcherSheet');

interface RenderOptions {
  visible?: boolean;
  stageNumber?: number;
  currentPracticeId?: number | null;
  onClose?: () => void;
  onReplaced?: (_practice: UserPractice) => void;
  // `undefined` is meaningful (it should hide the CTA), so the helper has
  // to distinguish "not provided" from "explicitly undefined". We use the
  // `'onSubmitOwn' in opts` check below to preserve that distinction.
  onSubmitOwn?: () => void;
}

function renderSheet(opts: RenderOptions = {}) {
  const onSubmitOwn = 'onSubmitOwn' in opts ? opts.onSubmitOwn : jest.fn();
  return render(
    <PracticeSwitcherSheet
      visible={opts.visible ?? true}
      stageNumber={opts.stageNumber ?? 5}
      currentPracticeId={opts.currentPracticeId ?? 1}
      onClose={opts.onClose ?? jest.fn()}
      onReplaced={opts.onReplaced ?? jest.fn()}
      onSubmitOwn={onSubmitOwn}
    />,
  );
}

describe('PracticeSwitcherSheet', () => {
  beforeEach(() => {
    mockPracticesList.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('renders nothing until visible is true (no list fetch fires)', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const { queryByTestId } = renderSheet({ visible: false });
    expect(queryByTestId('practice-switcher-sheet')).toBeNull();
    // Give a tick for any errant useEffect to fire.
    await waitFor(() => {
      expect(mockPracticesList).not.toHaveBeenCalled();
    });
  });

  it('fetches the stage practices and lists every returned row', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const { findByTestId, getByText } = renderSheet({ stageNumber: 5 });
    await findByTestId('practice-switcher-row-1');
    expect(getByText('Concentration on the breath')).toBeTruthy();
    expect(getByText('Mantra repetition')).toBeTruthy();
    expect(getByText('Body-mind scan')).toBeTruthy();
    expect(mockPracticesList).toHaveBeenCalledWith(5);
  });

  it('marks the currently selected practice with a check', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const { findByTestId, queryByTestId } = renderSheet({ currentPracticeId: 2 });
    await findByTestId('practice-switcher-row-2');
    expect(queryByTestId('practice-switcher-check-2')).toBeTruthy();
    expect(queryByTestId('practice-switcher-check-1')).toBeNull();
    expect(queryByTestId('practice-switcher-check-3')).toBeNull();
  });

  it('posts a new selection and fires onReplaced with the server response', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    mockUserPracticesCreate.mockResolvedValue(createdUserPractice);
    const onReplaced = jest.fn();
    const onClose = jest.fn();
    const { findByTestId } = renderSheet({ onReplaced, onClose, currentPracticeId: 1 });
    const row = await findByTestId('practice-switcher-row-2');
    fireEvent.press(row);
    await waitFor(() => {
      expect(mockUserPracticesCreate).toHaveBeenCalledWith({
        practice_id: 2,
        stage_number: 5,
      });
    });
    await waitFor(() => {
      expect(onReplaced).toHaveBeenCalledWith(createdUserPractice);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tapping the already-selected row closes the sheet without writing', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const onReplaced = jest.fn();
    const onClose = jest.fn();
    const { findByTestId } = renderSheet({ onReplaced, onClose, currentPracticeId: 1 });
    const row = await findByTestId('practice-switcher-row-1');
    fireEvent.press(row);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it('renders an inline error if the list fetch fails, with a retry that re-runs it', async () => {
    mockPracticesList.mockRejectedValueOnce(new Error('offline'));
    const { findByTestId } = renderSheet();
    const retry = await findByTestId('practice-switcher-retry');
    mockPracticesList.mockResolvedValueOnce(samplePractices);
    fireEvent.press(retry);
    await waitFor(() => {
      expect(mockPracticesList).toHaveBeenCalledTimes(2);
    });
  });

  it('surfaces a "Submit my own" CTA that calls onSubmitOwn and closes the sheet', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const onSubmitOwn = jest.fn();
    const onClose = jest.fn();
    const { findByTestId } = renderSheet({ onSubmitOwn, onClose });
    const cta = await findByTestId('practice-switcher-submit-own');
    fireEvent.press(cta);
    expect(onSubmitOwn).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the submit-own CTA when no onSubmitOwn callback is wired', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const { findByTestId, queryByTestId } = renderSheet({ onSubmitOwn: undefined });
    await findByTestId('practice-switcher-row-1');
    expect(queryByTestId('practice-switcher-submit-own')).toBeNull();
  });

  it('reports a create failure via onError without closing the sheet', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    mockUserPracticesCreate.mockRejectedValueOnce(new Error('write failed'));
    const onClose = jest.fn();
    const onReplaced = jest.fn();
    const { findByTestId } = renderSheet({ onClose, onReplaced, currentPracticeId: 1 });
    const row = await findByTestId('practice-switcher-row-2');
    fireEvent.press(row);
    const errorBanner = await findByTestId('practice-switcher-error');
    expect(errorBanner).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it('surfaces the specific backend reason (e.g. stage_locked) over the generic fallback', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    // Reject with an ApiError-shaped object so formatApiError maps the
    // ``detail`` code to its user-facing copy instead of the generic
    // "check your connection" fallback.
    mockUserPracticesCreate.mockRejectedValueOnce({ status: 403, detail: 'stage_locked' });
    const { findByTestId, getByText } = renderSheet({ currentPracticeId: 1 });
    const row = await findByTestId('practice-switcher-row-2');
    fireEvent.press(row);
    await findByTestId('practice-switcher-error');
    expect(getByText(/unlock(ed)? this stage/i)).toBeTruthy();
  });

  it('the close affordance fires onClose', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const onClose = jest.fn();
    const { findByTestId } = renderSheet({ onClose });
    const close = await findByTestId('practice-switcher-close');
    fireEvent.press(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tapping the backdrop fires onClose (tap-to-dismiss gesture)', async () => {
    mockPracticesList.mockResolvedValue(samplePractices);
    const onClose = jest.fn();
    const { findByTestId } = renderSheet({ onClose });
    const backdrop = await findByTestId('practice-switcher-backdrop');
    fireEvent.press(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
