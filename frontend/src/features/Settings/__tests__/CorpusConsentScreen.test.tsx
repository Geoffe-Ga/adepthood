/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import {
  CORPUS_CONSENT_CONSEQUENCE_REMOVAL,
  CORPUS_CONSENT_CONSEQUENCE_SENDING,
  CORPUS_CONSENT_INTIMATE_LINE,
  CORPUS_REVOKE_CONFIRM_LABEL,
} from '../corpusConsentCopy';
import CorpusConsentScreen from '../CorpusConsentScreen';

import { corpusConsent, type CorpusConsent } from '@/api';

/**
 * The screen that lets somebody turn the corpus on, and — the part that needs
 * the tests — off.
 *
 * Granting is one tap because the consequence is stated above it and is
 * reversible. Withdrawing is not one tap, because it deletes writing-derived
 * copies in the same breath: the confirmation exists so nobody discovers what
 * a switch did after it did it.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, corpusConsent: { list: jest.fn(), set: jest.fn() } };
});

const mockList = corpusConsent.list as jest.MockedFunction<typeof corpusConsent.list>;
const mockSet = corpusConsent.set as jest.MockedFunction<typeof corpusConsent.set>;

const UNDECIDED: CorpusConsent = { source: 'journal', granted: false, decided_at: null };
const GRANTED: CorpusConsent = {
  source: 'journal',
  granted: true,
  decided_at: '2026-08-18T09:00:00Z',
};
const REVOKED: CorpusConsent = {
  source: 'journal',
  granted: false,
  decided_at: '2026-08-19T09:00:00Z',
};
const UPLOAD_UNDECIDED: CorpusConsent = { source: 'upload', granted: false, decided_at: null };

function listReturns(...sources: CorpusConsent[]): void {
  mockList.mockResolvedValue(sources);
}

async function renderLoaded(...sources: CorpusConsent[]) {
  listReturns(...sources);
  const view = render(<CorpusConsentScreen />);
  await waitFor(() => expect(mockList).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CorpusConsentScreen — the offer', () => {
  test('renders on the warm screen scaffold', async () => {
    const { getByTestId } = await renderLoaded(UNDECIDED);

    expect(getByTestId('corpus-consent-screen')).toBeTruthy();
  });

  test('states both consequences, and the Intimate guarantee, before any switch', async () => {
    const { getByText } = await renderLoaded(UNDECIDED);

    expect(getByText(CORPUS_CONSENT_CONSEQUENCE_SENDING)).toBeTruthy();
    expect(getByText(CORPUS_CONSENT_CONSEQUENCE_REMOVAL)).toBeTruthy();
    expect(getByText(CORPUS_CONSENT_INTIMATE_LINE)).toBeTruthy();
  });

  test('shows a source nobody has been asked about as off, and asks nothing of the server', async () => {
    const { getByTestId } = await renderLoaded(UNDECIDED);

    expect(getByTestId('corpus-consent-switch-journal').props.value).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });

  test('offers no switch for a source nothing sorts yet, and says why', async () => {
    const { queryByTestId, getByTestId } = await renderLoaded(UNDECIDED, UPLOAD_UNDECIDED);

    expect(queryByTestId('corpus-consent-switch-upload')).toBeNull();
    expect(getByTestId('corpus-consent-note-upload')).toBeTruthy();
  });
});

describe('CorpusConsentScreen — agreeing', () => {
  test('records the decision for the source whose switch was moved', async () => {
    const { getByTestId } = await renderLoaded(UNDECIDED);
    mockSet.mockResolvedValueOnce(GRANTED);

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', true);

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('journal', true));
  });

  test('shows the state the server reported back, not the one that was tapped', async () => {
    const { getByTestId } = await renderLoaded(UNDECIDED);
    mockSet.mockResolvedValueOnce(GRANTED);

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', true);

    await waitFor(() =>
      expect(getByTestId('corpus-consent-switch-journal').props.value).toBe(true),
    );
    expect(getByTestId('corpus-consent-status-journal').props.children).toMatch(/2026/);
  });

  test('leaves the switch where the server left it when the write fails', async () => {
    const { getByTestId } = await renderLoaded(UNDECIDED);
    mockSet.mockRejectedValueOnce(new Error('network down'));

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', true);

    await waitFor(() => expect(getByTestId('corpus-consent-error')).toBeTruthy());
    expect(getByTestId('corpus-consent-switch-journal').props.value).toBe(false);
  });
});

describe('CorpusConsentScreen — withdrawing', () => {
  test('does not withdraw on the tap; it asks first, naming the deletion', async () => {
    const { getByTestId, getByText } = await renderLoaded(GRANTED);

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', false);

    expect(mockSet).not.toHaveBeenCalled();
    expect(getByTestId('corpus-consent-revoke-journal')).toBeTruthy();
    expect(getByText(CORPUS_REVOKE_CONFIRM_LABEL)).toBeTruthy();
  });

  test('keeps the source on, and deletes nothing, when the question is declined', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded(GRANTED);

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
    fireEvent.press(getByTestId('corpus-consent-revoke-cancel-journal'));

    expect(mockSet).not.toHaveBeenCalled();
    expect(queryByTestId('corpus-consent-revoke-journal')).toBeNull();
    expect(getByTestId('corpus-consent-switch-journal').props.value).toBe(true);
  });

  test('withdraws once the person confirms, and reports what is left', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded(GRANTED);
    mockSet.mockResolvedValueOnce(REVOKED);

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
    fireEvent.press(getByTestId('corpus-consent-revoke-confirm-journal'));

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('journal', false));
    await waitFor(() =>
      expect(getByTestId('corpus-consent-switch-journal').props.value).toBe(false),
    );
    expect(queryByTestId('corpus-consent-revoke-journal')).toBeNull();
  });

  test('keeps the source on when the withdrawal fails, rather than showing it gone', async () => {
    const { getByTestId } = await renderLoaded(GRANTED);
    mockSet.mockRejectedValueOnce(new Error('network down'));

    fireEvent(getByTestId('corpus-consent-switch-journal'), 'valueChange', false);
    fireEvent.press(getByTestId('corpus-consent-revoke-confirm-journal'));

    await waitFor(() => expect(getByTestId('corpus-consent-error')).toBeTruthy());
    expect(getByTestId('corpus-consent-switch-journal').props.value).toBe(true);
  });
});

describe('CorpusConsentScreen — when the server cannot be reached', () => {
  test('says so instead of rendering an empty page of switches', async () => {
    mockList.mockRejectedValueOnce(new Error('network down'));

    const { getByTestId, queryByTestId } = render(<CorpusConsentScreen />);

    await waitFor(() => expect(getByTestId('corpus-consent-error')).toBeTruthy());
    expect(queryByTestId('corpus-consent-switch-journal')).toBeNull();
  });
});
