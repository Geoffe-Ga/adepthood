import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React, { useState } from 'react';

import { EnergyTextInput } from '../EnergyTextInput';

const Harness = ({ initial, onCommit }: { initial: number; onCommit?: (_n: number) => void }) => {
  const [value, setValue] = useState(initial);
  return (
    <EnergyTextInput
      testID="energy-input"
      value={value}
      onCommit={(next) => {
        setValue(next);
        onCommit?.(next);
      }}
    />
  );
};

describe('EnergyTextInput', () => {
  it('renders the initial value as a string', () => {
    const { getByTestId } = render(<Harness initial={5} />);
    expect(getByTestId('energy-input').props.value).toBe('5');
  });

  it('exposes mid-edit states (empty, lone minus) without dropping keystrokes', () => {
    const onCommit = jest.fn();
    const { getByTestId } = render(<Harness initial={5} onCommit={onCommit} />);
    const input = getByTestId('energy-input');
    fireEvent.changeText(input, '');
    expect(input.props.value).toBe('');
    fireEvent.changeText(input, '-');
    expect(input.props.value).toBe('-');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits valid integers in the [-10, 10] window', () => {
    const onCommit = jest.fn();
    const { getByTestId } = render(<Harness initial={5} onCommit={onCommit} />);
    const input = getByTestId('energy-input');
    fireEvent.changeText(input, '-3');
    expect(onCommit).toHaveBeenLastCalledWith(-3);
    fireEvent.changeText(input, '10');
    expect(onCommit).toHaveBeenLastCalledWith(10);
    fireEvent.changeText(input, '0');
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it('keeps invalid text visible but does not commit it', () => {
    const onCommit = jest.fn();
    const { getByTestId } = render(<Harness initial={5} onCommit={onCommit} />);
    const input = getByTestId('energy-input');
    fireEvent.changeText(input, '99');
    expect(input.props.value).toBe('99');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.changeText(input, 'foo');
    expect(input.props.value).toBe('foo');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('reverts the buffer on blur when the text is invalid', () => {
    const { getByTestId } = render(<Harness initial={5} />);
    const input = getByTestId('energy-input');
    fireEvent.changeText(input, '99');
    expect(input.props.value).toBe('99');
    fireEvent(input, 'blur');
    expect(input.props.value).toBe('5');
  });

  it('does not revert the buffer on blur when the text parses cleanly', () => {
    const { getByTestId } = render(<Harness initial={5} />);
    const input = getByTestId('energy-input');
    fireEvent.changeText(input, '7');
    fireEvent(input, 'blur');
    expect(input.props.value).toBe('7');
  });

  it('syncs the buffer when the external value changes', () => {
    const Wrapper = ({ value }: { value: number }) => (
      <EnergyTextInput testID="energy-input" value={value} onCommit={() => undefined} />
    );
    const { getByTestId, rerender } = render(<Wrapper value={5} />);
    expect(getByTestId('energy-input').props.value).toBe('5');
    rerender(<Wrapper value={-2} />);
    expect(getByTestId('energy-input').props.value).toBe('-2');
  });
});
