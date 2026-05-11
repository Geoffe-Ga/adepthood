import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { TarotConfig } from '../../engine/types';
import TarotForm from '../forms/TarotForm';

const base: TarotConfig = {
  mode: 'tarot',
  deck: 'major_arcana',
  per_card_minutes: 5,
  hide_timer_during_meditation: true,
};

describe('TarotForm', () => {
  it('renders the per-card minutes', () => {
    const { getByTestId } = render(<TarotForm value={base} onChange={jest.fn()} />);
    expect(getByTestId('tarot-per-card').props.value).toBe('5');
  });

  it('updates per-card minutes', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TarotForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('tarot-per-card'), '7');
    expect(onChange).toHaveBeenCalledWith({ ...base, per_card_minutes: 7 });
  });

  it('toggles hide_timer_during_meditation', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TarotForm value={base} onChange={onChange} />);
    fireEvent(getByTestId('tarot-hide-timer'), 'valueChange', false);
    expect(onChange).toHaveBeenCalledWith({ ...base, hide_timer_during_meditation: false });
  });

  it('falls back to the default when per-card minutes is cleared', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(<TarotForm value={base} onChange={onChange} />);
    fireEvent.changeText(getByTestId('tarot-per-card'), '');
    expect(onChange).toHaveBeenCalledWith({ ...base, per_card_minutes: 5 });
  });
});
