import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { EnergyCostReturnEditor } from '../EnergyCostReturnEditor';

describe('EnergyCostReturnEditor', () => {
  it('renders the Cost/Return/Net headers, computed net, and validation note', () => {
    const { getByText } = render(
      <EnergyCostReturnEditor
        cost={3}
        energyReturn={7}
        onCommitCost={jest.fn()}
        onCommitReturn={jest.fn()}
      />,
    );
    getByText('Cost');
    getByText('Return');
    getByText('Net');
    getByText('4');
    getByText('Enter a whole number from -10 to 10.');
  });

  it('renders a negative net when cost exceeds return', () => {
    const { getByText } = render(
      <EnergyCostReturnEditor
        cost={8}
        energyReturn={2}
        onCommitCost={jest.fn()}
        onCommitReturn={jest.fn()}
      />,
    );
    getByText('-6');
  });

  it('commits parsed cost and return values through the two inputs', () => {
    const onCommitCost = jest.fn();
    const onCommitReturn = jest.fn();
    const { getByTestId } = render(
      <EnergyCostReturnEditor
        cost={1}
        energyReturn={2}
        onCommitCost={onCommitCost}
        onCommitReturn={onCommitReturn}
        costTestID="cost-input"
        returnTestID="return-input"
      />,
    );
    fireEvent.changeText(getByTestId('cost-input'), '6');
    fireEvent.changeText(getByTestId('return-input'), '9');
    expect(onCommitCost).toHaveBeenCalledWith(6);
    expect(onCommitReturn).toHaveBeenCalledWith(9);
  });
});
