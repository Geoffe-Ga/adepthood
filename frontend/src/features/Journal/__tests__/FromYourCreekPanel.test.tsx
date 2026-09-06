/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';

import FromYourCreekPanel from '../FromYourCreekPanel';

import type { RelatedEddy, RelatedPraxis } from '@/api';
import { INTERACTIVE_TEXT_MIN, ink, surface } from '@/design/tokens';

const PRAXIS: RelatedPraxis = {
  title: 'Morning pages',
  praxis_type: 'practice',
  status: 'released',
  excerpt: 'Three quiet pages before the day begins.',
};

const EDDY: RelatedEddy = {
  title: 'Returning to water',
  description: 'Images of rivers and rain gather around this thread.',
  fragment_count: 12,
  formed: '2026-03-04',
};

describe('FromYourCreekPanel', () => {
  it('renders nothing for empty results, preserving the journal layout', () => {
    const { toJSON, queryByTestId } = render(<FromYourCreekPanel praxis={[]} eddies={[]} />);

    expect(toJSON()).toBeNull();
    expect(queryByTestId('from-your-creek')).toBeNull();
  });

  it('offers both praxis and eddies behind an accessible collapsed header', () => {
    const view = render(<FromYourCreekPanel praxis={[PRAXIS]} eddies={[EDDY]} />);
    const toggle = view.getByTestId('from-your-creek-toggle');

    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(toggle.props.accessibilityLabel).toBe('Expand related pages from your creek');
    expect(view.queryByText(PRAXIS.title)).toBeNull();
    expect(view.queryByText(EDDY.title)).toBeNull();

    fireEvent.press(toggle);

    expect(view.getByTestId('from-your-creek-toggle').props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(view.getByTestId('from-your-creek-toggle').props.accessibilityLabel).toBe(
      'Collapse related pages from your creek',
    );
    expect(view.getByText(PRAXIS.title)).toBeTruthy();
    expect(view.getByText('practice · set down')).toBeTruthy();
    expect(view.getByText(PRAXIS.excerpt)).toBeTruthy();
    expect(view.getByText(EDDY.title)).toBeTruthy();
    expect(view.getByText(EDDY.description)).toBeTruthy();
    expect(view.getByText('12 fragments since March')).toBeTruthy();
    const bodyStyle = StyleSheet.flatten(view.getByTestId('from-your-creek-body').props.style);
    expect(bodyStyle.maxHeight).toBeLessThan(Dimensions.get('window').height);
    expect(
      view.getByLabelText(
        'Morning pages. practice, set down. Three quiet pages before the day begins.',
      ),
    ).toBeTruthy();
    expect(
      view.getByLabelText(
        'Returning to water. Images of rivers and rain gather around this thread. 12 fragments since March.',
      ),
    ).toBeTruthy();
  });

  it('renders a praxis-only response without inventing an eddy section', () => {
    const view = render(<FromYourCreekPanel praxis={[PRAXIS]} eddies={[]} />);

    fireEvent.press(view.getByTestId('from-your-creek-toggle'));

    expect(view.getByText('Praxis')).toBeTruthy();
    expect(view.queryByText('Eddies')).toBeNull();
    expect(view.getByText(PRAXIS.title)).toBeTruthy();
  });

  it('renders an eddy-only response and uses singular fragment copy', () => {
    const view = render(
      <FromYourCreekPanel praxis={[]} eddies={[{ ...EDDY, fragment_count: 1 }]} />,
    );

    fireEvent.press(view.getByTestId('from-your-creek-toggle'));

    expect(view.queryByText('Praxis')).toBeNull();
    expect(view.getByText('Eddies')).toBeTruthy();
    expect(view.getByText('1 fragment since March')).toBeTruthy();
  });

  it('uses accessible token colours and the interactive type floor on its trigger', () => {
    const { getByTestId } = render(<FromYourCreekPanel praxis={[PRAXIS]} eddies={[]} />);
    const bandStyle = StyleSheet.flatten(getByTestId('from-your-creek').props.style);
    const labelStyle = StyleSheet.flatten(getByTestId('from-your-creek-title').props.style);

    expect(bandStyle.backgroundColor).toBe(surface.raised);
    expect(labelStyle.color).toBe(ink.primary);
    expect(labelStyle.fontSize).toBeGreaterThanOrEqual(INTERACTIVE_TEXT_MIN);
  });
});
