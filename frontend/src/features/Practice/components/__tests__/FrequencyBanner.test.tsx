/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { FrequencyResponse } from '@/api';

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

  it('renders a skeleton while the fetch is in flight', () => {
    mockUseFrequency.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId, queryByTestId } = render(<FrequencyBanner onSwitch={jest.fn()} />);
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
    const { getByTestId } = render(<FrequencyBanner onSwitch={jest.fn()} />);
    fireEvent.press(getByTestId('frequency-banner-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the server banner_text verbatim — never assembles the copy itself', () => {
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner onSwitch={jest.fn()} />);
    const body = getByTestId('frequency-banner-text');
    expect(body.props.children).toBe(samplePayload.banner_text);
  });

  it('shows the aspect chip + colour swatch sourced from the server colour field', () => {
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner onSwitch={jest.fn()} />);
    expect(getByTestId('frequency-banner-aspect').props.children).toBe('Mind');
    // The container's backgroundColor should track the Orange swatch.
    const content = getByTestId('frequency-banner-content');
    const flatStyle = Array.isArray(content.props.style)
      ? Object.assign({}, ...content.props.style)
      : content.props.style;
    expect(flatStyle.backgroundColor).toBe('#f29f67');
  });

  it('falls back to the neutral swatch when the server sends an unknown colour', () => {
    mockUseFrequency.mockReturnValue({
      data: { ...samplePayload, color: 'Magenta' },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner onSwitch={jest.fn()} />);
    const content = getByTestId('frequency-banner-content');
    const flatStyle = Array.isArray(content.props.style)
      ? Object.assign({}, ...content.props.style)
      : content.props.style;
    // Clear Light fallback (#ffffff) keeps the banner legible.
    expect(flatStyle.backgroundColor).toBe('#ffffff');
  });

  it('invokes the onSwitch callback when the banner body is tapped', () => {
    const onSwitch = jest.fn();
    mockUseFrequency.mockReturnValue({
      data: samplePayload,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const { getByTestId } = render(<FrequencyBanner onSwitch={onSwitch} />);
    fireEvent.press(getByTestId('frequency-banner-content'));
    expect(onSwitch).toHaveBeenCalledTimes(1);
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
    const { getByTestId, queryByTestId } = render(
      <FrequencyBanner data={samplePayload} onSwitch={jest.fn()} />,
    );
    expect(getByTestId('frequency-banner-text').props.children).toBe(samplePayload.banner_text);
    // The hook's loading state must not bleed into the rendered output.
    expect(queryByTestId('frequency-banner-skeleton')).toBeNull();
  });
});
