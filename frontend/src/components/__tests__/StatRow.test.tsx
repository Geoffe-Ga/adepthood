/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import { StatList, StatRow } from '../StatRow';

describe('StatRow', () => {
  it('renders the label and the figure as separate lines of text', () => {
    const { getByText } = render(<StatRow label="Total sessions" value="24" />);

    expect(getByText('Total sessions')).toBeTruthy();
    expect(getByText('24')).toBeTruthy();
  });

  it('addresses the figure separately from the row when asked', () => {
    // A spec asserting a total should fail when the number is wrong, not when
    // the label beside it is reworded -- which needs a testID on the value.
    const { getByTestId } = render(
      <StatRow label="Total time" value="7h 40m" testID="row" valueTestID="row-value" />,
    );

    expect(getByTestId('row-value')).toHaveTextContent('7h 40m');
    expect(getByTestId('row')).toHaveTextContent(/Total time/);
  });

  it('groups rows under one container', () => {
    const { getByTestId } = render(
      <StatList testID="stats">
        <StatRow label="Total sessions" value="2" />
      </StatList>,
    );

    expect(getByTestId('stats')).toHaveTextContent(/Total sessions/);
  });
});
