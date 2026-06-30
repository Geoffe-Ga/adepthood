import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ScreenHeader } from '../ScreenHeader';

describe('ScreenHeader', () => {
  it('renders the eyebrow (uppercased), a header-role title, and a lead', () => {
    const { getByText } = render(
      <ScreenHeader eyebrow="Aptitude Program" title="The Course" lead="A guided path." />,
    );
    expect(getByText('APTITUDE PROGRAM')).toBeTruthy();
    const title = getByText('The Course');
    expect(title.props.accessibilityRole).toBe('header');
    expect(getByText('A guided path.')).toBeTruthy();
  });

  it('renders an optional action slot', () => {
    const { getByText } = render(<ScreenHeader title="Today" action={<Text>Action</Text>} />);
    expect(getByText('Action')).toBeTruthy();
  });

  it('omits the eyebrow + lead when not provided', () => {
    const { queryByText, getByText } = render(<ScreenHeader title="Map" />);
    expect(getByText('Map')).toBeTruthy();
    expect(queryByText('APTITUDE PROGRAM')).toBeNull();
  });
});
