/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { keepAsPractice, planKeepAsPractice } from '../keepAsPractice';
import SaveAsPracticeStep from '../SaveAsPracticeStep';

jest.mock('../keepAsPractice', () => ({
  planKeepAsPractice: jest.fn(),
  keepAsPractice: jest.fn(),
}));

const plan = planKeepAsPractice as jest.Mock;
const keep = keepAsPractice as jest.Mock;

const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const WRITING = { endedAt: new Date('2026-09-08T09:20:00.000Z'), elapsedMs: TWENTY_MINUTES_MS };
const OPEN_PLAN = { practiceId: 41, displaces: null, waitingAt: null };

const onKept = jest.fn();
const onCancel = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  plan.mockImplementation(() => Promise.resolve(OPEN_PLAN));
  keep.mockImplementation(() => Promise.resolve({ kept: true, sessionLogged: true }));
});

/** Render and wait for the asynchronous lookup to settle into a summary. */
async function renderStep() {
  const view = render(<SaveAsPracticeStep writing={WRITING} onKept={onKept} onCancel={onCancel} />);
  await waitFor(() => expect(view.queryByTestId('save-as-practice-summary')).not.toBeNull());
  return view;
}

/** The sentence the step is showing above its actions. */
function summaryText(view: Awaited<ReturnType<typeof renderStep>>): string {
  return view.getByTestId('save-as-practice-summary').props.children as string;
}

describe('SaveAsPracticeStep — describing before doing', () => {
  it('says what keeping it would do, and writes nothing while it says so', async () => {
    const view = await renderStep();

    expect(summaryText(view)).toMatch(/counted/i);
    expect(view.getByTestId('save-as-practice-confirm')).toBeTruthy();
    expect(view.getByTestId('save-as-practice-cancel')).toBeTruthy();
    expect(keep).not.toHaveBeenCalled();
  });

  it('names the practice Green is holding, and offers to keep it instead', async () => {
    plan.mockImplementation(() => Promise.resolve({ ...OPEN_PLAN, displaces: 'Loving-kindness' }));

    const view = await renderStep();

    expect(summaryText(view)).toContain('Loving-kindness');
    expect(view.getByTestId('save-as-practice-cancel').props.accessibilityLabel).toBeTruthy();
  });

  it('says the session is not counted when the writer has not reached Green', async () => {
    plan.mockImplementation(() => Promise.resolve({ ...OPEN_PLAN, waitingAt: 'Beige' }));

    const view = await renderStep();

    expect(summaryText(view)).toContain('Beige');
    expect(summaryText(view)).toMatch(/not counted/i);
  });

  it('leaves the practices alone when the writer takes the way out', async () => {
    const view = await renderStep();

    fireEvent.press(view.getByTestId('save-as-practice-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(keep).not.toHaveBeenCalled();
    expect(onKept).not.toHaveBeenCalled();
  });

  it('offers no confirm at all when the lookup could not answer', async () => {
    plan.mockImplementation(() => Promise.resolve(null));

    const view = render(
      <SaveAsPracticeStep writing={WRITING} onKept={onKept} onCancel={onCancel} />,
    );

    await waitFor(() => expect(view.queryByTestId('save-as-practice-notice')).not.toBeNull());
    expect(view.queryByTestId('save-as-practice-confirm')).toBeNull();
    expect(keep).not.toHaveBeenCalled();
  });
});

describe('SaveAsPracticeStep — the write', () => {
  it('keeps the practice with the session that has just finished', async () => {
    const view = await renderStep();

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-practice-kept')).not.toBeNull());
    expect(keep).toHaveBeenCalledWith(OPEN_PLAN, WRITING);
    expect(view.getByTestId('save-as-practice-kept').props.children).toMatch(/this session/i);
    expect(onKept).toHaveBeenCalledTimes(1);
  });

  it('does not claim a session it was told was not logged', async () => {
    keep.mockImplementation(() => Promise.resolve({ kept: true, sessionLogged: false }));
    const view = await renderStep();

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-practice-kept')).not.toBeNull());
    expect(view.getByTestId('save-as-practice-kept').props.children).not.toMatch(/this session/i);
    expect(onKept).toHaveBeenCalledTimes(1);
  });

  it('leaves the offer open, unsettled, when nothing was kept', async () => {
    keep.mockImplementation(() => Promise.resolve({ kept: false, sessionLogged: false }));
    const view = await renderStep();

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    await waitFor(() => expect(view.queryByTestId('save-as-practice-notice')).not.toBeNull());
    expect(onKept).not.toHaveBeenCalled();
    expect(view.queryByTestId('save-as-practice-confirm')).not.toBeNull();
  });

  it('cannot be asked to write twice while the first write is in flight', async () => {
    let release = (_outcome: { kept: boolean; sessionLogged: boolean }): void => {};
    keep.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release;
        }),
    );
    const view = await renderStep();

    fireEvent.press(view.getByTestId('save-as-practice-confirm'));
    fireEvent.press(view.getByTestId('save-as-practice-confirm'));

    expect(keep).toHaveBeenCalledTimes(1);
    release({ kept: true, sessionLogged: true });
    await waitFor(() => expect(view.queryByTestId('save-as-practice-kept')).not.toBeNull());
  });
});
