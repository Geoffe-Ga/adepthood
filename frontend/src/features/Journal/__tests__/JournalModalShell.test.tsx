/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import JournalModalShell from '../JournalModalShell';

// Flattens an RN style prop (array or object) into a plain lookup object.
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style) as Record<string, unknown>;
  }
  return (style ?? {}) as Record<string, unknown>;
}

function renderShell(overrides: Record<string, unknown> = {}) {
  const props = {
    visible: true,
    onDismiss: jest.fn(),
    scrimTestID: 'shell-scrim',
    scrimLabel: 'Dismiss',
    children: <Text>Shell content</Text>,
    ...overrides,
  };
  return { ...render(<JournalModalShell {...props} />), props };
}

describe('JournalModalShell', () => {
  it('renders its children when visible', () => {
    const { getByText } = renderShell();
    expect(getByText('Shell content')).toBeTruthy();
  });

  it('fires onDismiss once when the scrim is pressed', () => {
    const { getByTestId, props } = renderShell();
    fireEvent.press(getByTestId('shell-scrim'));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not fire onDismiss when the card is pressed', () => {
    const { getByTestId, props } = renderShell({ cardTestID: 'shell-card' });
    fireEvent.press(getByTestId('shell-card'));
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it('carries the passed scrimTestID and accessibilityLabel on the scrim', () => {
    const { getByTestId } = renderShell({ scrimTestID: 'custom-scrim', scrimLabel: 'Close this' });
    const scrim = getByTestId('custom-scrim');
    expect(scrim.props.accessibilityLabel).toBe('Close this');
  });

  it('omits modalTestID and cardTestID when they are not provided', () => {
    const { queryByTestId } = renderShell();
    expect(queryByTestId('shell-modal')).toBeNull();
    expect(queryByTestId('shell-card')).toBeNull();
  });

  it('exposes modalTestID and cardTestID when they are provided', () => {
    const { queryByTestId } = renderShell({ modalTestID: 'shell-modal', cardTestID: 'shell-card' });
    expect(queryByTestId('shell-modal')).toBeTruthy();
    expect(queryByTestId('shell-card')).toBeTruthy();
  });

  it('merges the passed cardStyle onto the card', () => {
    const { getByTestId } = renderShell({
      cardTestID: 'shell-card',
      cardStyle: { maxHeight: 321 },
    });
    const card = getByTestId('shell-card');
    expect(flattenStyle(card.props.style).maxHeight).toBe(321);
  });
});
