/* eslint-env jest */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { Modal, StyleSheet } from 'react-native';

// jest.mock below is hoisted above this import, so the sheet sees the mocked client.
import PracticeDetailSheet, { CLOSE_DETAIL_LABEL } from '../PracticeDetailSheet';

import type { PracticeItem, UserPractice } from '@/api';
import { touchTarget } from '@/design/tokens';
import * as reducedMotion from '@/hooks/useReducedMotion';

// The first render pulls in the whole detail view; under parallel-worker load its
// cold start can pass Jest's 5s default (the PracticeCatalogScreen precedent).
jest.setTimeout(15000);

const samplePractice = (overrides: Partial<PracticeItem> = {}): PracticeItem => ({
  id: 1,
  stage_number: 1,
  name: 'Breath Awareness',
  description: 'Focus on the breath.',
  instructions: 'Sit and breathe.',
  default_duration_minutes: 10,
  approved: true,
  mode: 'meditation_timer',
  mode_config: { mode: 'meditation_timer', duration_minutes: 10 },
  ...overrides,
});

const mockPracticesGet = jest.fn<(id: number) => Promise<PracticeItem>>();
const mockUserPracticesList = jest.fn<() => Promise<UserPractice[]>>();

jest.mock('@/api', () => ({
  practices: { get: (...args: [number]) => mockPracticesGet(...args) },
  userPractices: { list: () => mockUserPracticesList() },
}));

interface SheetHarness {
  practiceId: number | null;
  restoreFocusTo?: React.RefObject<{ focus: () => void } | null>;
}

function renderSheet({ practiceId, restoreFocusTo = { current: null } }: SheetHarness) {
  const onClose = jest.fn<() => void>();
  const element = (id: number | null) => (
    <PracticeDetailSheet
      practiceId={id}
      onClose={onClose}
      onAssigned={jest.fn()}
      onCustomizeCopy={jest.fn()}
      restoreFocusTo={restoreFocusTo}
    />
  );
  const view = render(element(practiceId));
  return { ...view, onClose, rerenderWith: (id: number | null) => view.rerender(element(id)) };
}

interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  parent: TestNode | null;
}

/** The Modal that hosts the overlay card: its nearest Modal ancestor. */
function overlayModal(card: TestNode): TestNode {
  let node: TestNode | null = card;
  while (node !== null && node.type !== Modal) node = node.parent;
  if (node === null) throw new Error('practice-detail-overlay has no Modal ancestor');
  return node;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('PracticeDetailSheet', () => {
  beforeEach(() => {
    mockPracticesGet.mockReset();
    mockPracticesGet.mockResolvedValue(samplePractice());
    mockUserPracticesList.mockReset();
    mockUserPracticesList.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders nothing while closed', () => {
    const { queryByTestId } = renderSheet({ practiceId: null });
    expect(queryByTestId('practice-detail-overlay')).toBeNull();
  });

  it('is a modal surface with a labelled corner X at least a touch target wide', async () => {
    const { getByTestId, onClose } = renderSheet({ practiceId: 1 });
    await flush();

    expect(getByTestId('practice-detail-overlay').props.accessibilityViewIsModal).toBe(true);
    const close = getByTestId('practice-detail-overlay-close');
    expect(close.props.accessibilityLabel).toBe(CLOSE_DETAIL_LABEL);
    expect(close.props.accessibilityRole).toBe('button');
    const flat = StyleSheet.flatten(close.props.style);
    expect(flat.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(flat.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    // The heading keeps its role inside the sheet frame.
    const name = within(getByTestId('practice-detail-overlay')).getByTestId('practice-detail-name');
    expect(name.props.accessibilityRole).toBe('header');
    // The sheet frame, not the route's scaffold, holds the loaded view.
    expect(getByTestId('practice-detail-sheet-scroll')).toBeTruthy();

    fireEvent.press(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the scrim out of the accessibility tree and the tab order', async () => {
    const { getByTestId, onClose } = renderSheet({ practiceId: 1 });
    await flush();
    const scrim = getByTestId('practice-detail-overlay-scrim', { includeHiddenElements: true });
    expect(scrim.props['aria-hidden']).toBe(true);
    expect(scrim.props.focusable).toBe(false);
    fireEvent.press(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('slides in when motion is allowed and appears without animation under reduced motion', async () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const moving = renderSheet({ practiceId: 1 });
    await flush();
    expect(overlayModal(moving.getByTestId('practice-detail-overlay')).props.animationType).toBe(
      'slide',
    );
    moving.unmount();

    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const still = renderSheet({ practiceId: 1 });
    await flush();
    expect(overlayModal(still.getByTestId('practice-detail-overlay')).props.animationType).toBe(
      'none',
    );
  });

  it('shows the loading state inside the card before the practice resolves', () => {
    mockPracticesGet.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = renderSheet({ practiceId: 1 });
    expect(
      within(getByTestId('practice-detail-overlay')).getByTestId('practice-detail-loading'),
    ).toBeTruthy();
  });

  it('shows a load failure inside the card with its retry', async () => {
    mockPracticesGet.mockRejectedValueOnce(new Error('offline'));
    const { getByTestId } = renderSheet({ practiceId: 1 });
    await flush();
    const overlay = within(getByTestId('practice-detail-overlay'));
    expect(overlay.getByTestId('practice-detail-error')).toBeTruthy();

    await act(async () => {
      fireEvent.press(overlay.getByTestId('practice-detail-retry'));
    });
    expect(overlay.getByTestId('practice-detail-name')).toBeTruthy();
    expect(mockPracticesGet).toHaveBeenCalledTimes(2);
  });

  it('hands focus back to the opener exactly once when it closes', async () => {
    const focus = jest.fn<() => void>();
    const { rerenderWith } = renderSheet({ practiceId: 1, restoreFocusTo: { current: { focus } } });
    await flush();
    expect(focus).not.toHaveBeenCalled();

    rerenderWith(null);
    expect(focus).toHaveBeenCalledTimes(1);

    rerenderWith(null);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('starts every open fresh, keyed on the practice', async () => {
    mockPracticesGet.mockImplementation((id) =>
      Promise.resolve(samplePractice({ id, name: id === 2 ? 'Body Scan' : 'Breath Awareness' })),
    );
    const { getByTestId, queryByTestId, rerenderWith } = renderSheet({ practiceId: 1 });
    await flush();
    expect(getByTestId('practice-detail-name')).toHaveTextContent('Breath Awareness');
    fireEvent.press(getByTestId('practice-detail-use-for-stage'));
    expect(getByTestId('practice-detail-stage-picker')).toBeTruthy();

    rerenderWith(2);
    await flush();
    expect(getByTestId('practice-detail-name')).toHaveTextContent('Body Scan');
    expect(mockPracticesGet).toHaveBeenLastCalledWith(2);
    // The picker opened for the last practice does not carry over to this one.
    expect(queryByTestId('practice-detail-stage-picker')).toBeNull();
  });
});
