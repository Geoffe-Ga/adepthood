/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockPressIn = jest.fn();
const mockPressOut = jest.fn();
jest.mock('@/hooks/usePressScale', () => ({
  usePressScale: () => ({ scale: 1, onPressIn: mockPressIn, onPressOut: mockPressOut }),
}));

import { RETURN_OFFER_HEADING, RETURN_OFFER_BODY } from '../returnCopy';
import ReturnOfferCard from '../ReturnOfferCard';

import { touchTarget } from '@/design/tokens';

/** Smallest of the flattened minHeight/minWidth on a pressable, for 44dp checks. */
function styleSheetMin(node: { props: { style: unknown } }): number {
  const { StyleSheet } = require('react-native');
  const flat = StyleSheet.flatten(node.props.style) as { minHeight?: number; minWidth?: number };
  return Math.min(flat.minHeight ?? 0, flat.minWidth ?? 0);
}

const noop = () => undefined;

describe('ReturnOfferCard', () => {
  it('renders the offer heading and body from returnCopy', () => {
    const { getByTestId, getByText } = render(<ReturnOfferCard onAccept={noop} onDismiss={noop} />);
    expect(getByTestId('return-offer-card')).toBeTruthy();
    expect(getByText(RETURN_OFFER_HEADING)).toBeTruthy();
    expect(getByText(RETURN_OFFER_BODY)).toBeTruthy();
  });

  it('accept press calls onAccept exactly once', () => {
    const onAccept = jest.fn();
    const { getByTestId } = render(<ReturnOfferCard onAccept={onAccept} onDismiss={noop} />);
    fireEvent.press(getByTestId('return-offer-accept'));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('decline press calls onDismiss exactly once', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(<ReturnOfferCard onAccept={noop} onDismiss={onDismiss} />);
    fireEvent.press(getByTestId('return-offer-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('both affordances have accessibilityRole button and non-empty labels', () => {
    const { getByTestId } = render(<ReturnOfferCard onAccept={noop} onDismiss={noop} />);
    const accept = getByTestId('return-offer-accept');
    const decline = getByTestId('return-offer-dismiss');

    expect(accept.props.accessibilityRole).toBe('button');
    expect(decline.props.accessibilityRole).toBe('button');

    const acceptLabel: string = accept.props.accessibilityLabel;
    const declineLabel: string = decline.props.accessibilityLabel;
    expect(acceptLabel).toBeTruthy();
    expect(acceptLabel.length).toBeGreaterThan(0);
    expect(declineLabel).toBeTruthy();
    expect(declineLabel.length).toBeGreaterThan(0);
  });

  it('both affordances meet the 44dp minimum touch target', () => {
    const { getByTestId } = render(<ReturnOfferCard onAccept={noop} onDismiss={noop} />);
    expect(styleSheetMin(getByTestId('return-offer-accept'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
    expect(styleSheetMin(getByTestId('return-offer-dismiss'))).toBeGreaterThanOrEqual(
      touchTarget.minimum,
    );
  });
});
