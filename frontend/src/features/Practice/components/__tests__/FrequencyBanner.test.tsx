/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { FrequencyResponse } from '@/api';
import { COLOR_PALETTE } from '@/features/Practice/data/colorPalette';

const samplePayload: FrequencyResponse = {
  stage_number: 5,
  color: 'Orange',
  aspect: 'Mind',
  practice_name: 'Concentration on the breath',
  practice_id: 17,
  user_practice_id: 42,
  banner_text:
    'You are in the Orange frequency of APTITUDE. That means you are working on Mind. ' +
    'Your practice is Concentration on the breath but you are encouraged to replace it ' +
    'if another tradition has a practice that deals with Mind that calls to you more.',
};

const mockUseFrequency = jest.fn();

jest.mock('../../hooks/useFrequency', () => ({
  useFrequency: () => mockUseFrequency(),
}));

const { FrequencyBanner } = require('../FrequencyBanner');

describe('FrequencyBanner', () => {
  beforeEach(() => {
    mockUseFrequency.mockReset();
  });

  const flatBackground = (node: { props: { style: unknown } }): string => {
    const style = Array.isArray(node.props.style)
      ? Object.assign({}, ...(node.props.style as object[]))
      : (node.props.style as { backgroundColor?: string });
    return style.backgroundColor as string;
  };

  it('renders a skeleton while the fetch is in flight', () => {
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId, queryByTestId } = render(<FrequencyBanner />);
    expect(getByTestId('frequency-banner-skeleton')).toBeTruthy();
    expect(queryByTestId('frequency-banner-content')).toBeNull();
  });

  it('renders an inline error with a retry button that calls refetch', () => {
    const refetch = jest.fn();
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('offline'),
      refetch,
    });
    const { getByTestId } = render(<FrequencyBanner />);
    fireEvent.press(getByTestId('frequency-banner-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders a slim colour/aspect chip — no paragraph, no switch hint', () => {
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId, queryByTestId, queryByText } = render(<FrequencyBanner />);
    expect(getByTestId('frequency-banner-color').props.children).toBe('Orange');
    expect(getByTestId('frequency-banner-aspect').props.children).toBe('Mind');
    expect(queryByTestId('frequency-banner-text')).toBeNull();
    expect(queryByText('Tap to replace this practice')).toBeNull();
  });

  it('colours the swatch dot from the server colour field', () => {
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner />);
    // Track the palette constant rather than a hardcoded hex so a designer
    // tweak to the Orange swatch doesn't break this assertion.
    expect(flatBackground(getByTestId('frequency-chip-dot'))).toBe(COLOR_PALETTE.Orange.bg);
  });

  it('falls back to the neutral swatch when the server sends an unknown colour', () => {
    mockUseFrequency.mockReturnValue({
      data: { ...samplePayload, color: 'Magenta' },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner />);
    expect(flatBackground(getByTestId('frequency-chip-dot'))).toBe(COLOR_PALETTE['Clear Light'].bg);
  });

  it('is display-only — the chip is not a button', () => {
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner />);
    expect(getByTestId('frequency-banner-content').props.accessibilityRole).toBe('text');
  });

  it('refetches when refreshSignal changes after mount, but not on the initial value', () => {
    const refetch = jest.fn();
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch,
    });
    const { rerender } = render(<FrequencyBanner refreshSignal={0} />);
    // The initial signal value is recorded without fetching (the hook already
    // loaded on mount); only a subsequent change triggers a refetch.
    expect(refetch).not.toHaveBeenCalled();
    rerender(<FrequencyBanner refreshSignal={1} />);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ignores refreshSignal when data is injected (no network for storybook / tests)', () => {
    const refetch = jest.fn();
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch,
    });
    const { rerender } = render(<FrequencyBanner data={samplePayload} refreshSignal={0} />);
    rerender(<FrequencyBanner data={samplePayload} refreshSignal={1} />);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('accepts an injected data prop for storybook / testing — overrides the hook', () => {
    // When `data` is passed explicitly it wins, mirroring the dependency
    // injection escape hatch used by the mode views.
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId, queryByTestId } = render(<FrequencyBanner data={samplePayload} />);
    expect(getByTestId('frequency-banner-color').props.children).toBe('Orange');
    // The hook's loading state must not bleed into the rendered output.
    expect(queryByTestId('frequency-banner-skeleton')).toBeNull();
  });
});
