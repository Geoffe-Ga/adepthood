// #3659: a passage chosen before the surface mounted -- a Course quote's Open --
// is brought into view once the field has grown to its text, since a grown
// field never scrolls inside and the passage can sit screens down.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import QuoteSelectionSurface, { SELECTION_FIELD_MIN_HEIGHT } from '../QuoteSelectionSurface';
import { revealWebCaret } from '../webFieldMeasure';

jest.mock('../webFieldMeasure', () => ({
  ...(jest.requireActual('../webFieldMeasure') as Record<string, unknown>),
  revealWebCaret: jest.fn(),
}));

const mockedReveal = revealWebCaret as jest.MockedFunction<typeof revealWebCaret>;

// Code points {2, 6} -- "walk" past the emoji -- start at UTF-16 3.
const BODY = '\u{1F3B8} walk on';
const WALK = { start: 2, end: 6 };
const GROWN = SELECTION_FIELD_MIN_HEIGHT * 10;

function renderSurface(initialSelection?: { start: number; end: number }) {
  return render(
    <QuoteSelectionSurface
      body={BODY}
      onSelectionChange={jest.fn()}
      onConfirm={() => Promise.resolve()}
      onCancel={jest.fn()}
      initialSelection={initialSelection}
    />,
  );
}

/** The field reports the height its text takes, as it does once it has laid out. */
function grow(getByTestId: ReturnType<typeof render>['getByTestId'], height: number): void {
  fireEvent(getByTestId('quote-select-input'), 'contentSizeChange', {
    nativeEvent: { contentSize: { width: 300, height } },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockedReveal.mockReset();
});

describe('QuoteSelectionSurface -- bringing a preselected passage into view (#3659)', () => {
  it('reveals the passage once the field has grown to its text, a frame after', () => {
    const { getByTestId } = renderSurface(WALK);
    expect(mockedReveal).not.toHaveBeenCalled();

    grow(getByTestId, GROWN);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(mockedReveal).toHaveBeenCalledTimes(1);
    expect(mockedReveal.mock.calls[0]?.[1]).toBe(3);
  });

  it('reveals it once, however often the field is measured after', () => {
    const { getByTestId } = renderSurface(WALK);
    grow(getByTestId, GROWN);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    grow(getByTestId, GROWN + 40);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(mockedReveal).toHaveBeenCalledTimes(1);
  });

  it('reveals nothing when no passage was chosen before', () => {
    const { getByTestId } = renderSurface();
    grow(getByTestId, GROWN);
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(mockedReveal).not.toHaveBeenCalled();
  });
});
