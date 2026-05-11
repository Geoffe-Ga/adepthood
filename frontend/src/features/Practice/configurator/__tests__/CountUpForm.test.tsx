import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { CountUpConfig } from '../../engine/types';
import CountUpForm from '../forms/CountUpForm';

const base: CountUpConfig = { mode: 'count_up' };

describe('CountUpForm', () => {
  it('renders an empty field when no soft cap is set', () => {
    const { getByTestId } = render(<CountUpForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('count-up-soft-cap').props.value).toBe('');
  });

  it('emits a numeric soft cap on change', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<CountUpForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('count-up-soft-cap'), '15');
    expect(onChange).toHaveBeenCalledWith({ mode: 'count_up', soft_cap_minutes: 15 });
  });

  it('clears the soft cap when the field is emptied', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <CountUpForm value={{ mode: 'count_up', soft_cap_minutes: 20 }} onChange={onChange} />,
    );
    fireEvent.changeText(getByTestId('count-up-soft-cap'), '');
    expect(onChange).toHaveBeenCalledWith({ mode: 'count_up', soft_cap_minutes: null });
  });
});
