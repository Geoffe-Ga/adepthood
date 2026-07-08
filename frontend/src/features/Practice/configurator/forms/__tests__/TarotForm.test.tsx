import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import type { TarotConfig } from '../../../engine/types';
import TarotForm from '../TarotForm';

function tarotConfig(): TarotConfig {
  return {
    mode: 'tarot',
    deck: 'major_arcana',
    per_card_minutes: 5,
    hide_timer_during_meditation: true,
  };
}

describe('TarotForm hide-timer toggle', () => {
  it('emits hide_timer_during_meditation: false on toggle-off', () => {
    const onChange = jest.fn();
    const config = tarotConfig();
    const { getByTestId } = render(<TarotForm value={config} onChange={onChange} />);

    fireEvent(getByTestId('tarot-hide-timer'), 'valueChange', false);

    expect(onChange).toHaveBeenCalledWith({ ...config, hide_timer_during_meditation: false });
  });

  it('renders the toggle as true when hide_timer_during_meditation is undefined', () => {
    const { getByTestId } = render(
      <TarotForm
        value={{ mode: 'tarot', deck: 'major_arcana', per_card_minutes: 5 }}
        onChange={jest.fn()}
      />,
    );

    expect(getByTestId('tarot-hide-timer').props.value).toBe(true);
  });
});

describe('TarotForm per-card minutes', () => {
  it('updates per-card minutes from typed text', () => {
    const onChange = jest.fn();
    const config = tarotConfig();
    const { getByTestId } = render(<TarotForm value={config} onChange={onChange} />);

    fireEvent.changeText(getByTestId('tarot-per-card'), '7');

    expect(onChange).toHaveBeenCalledWith({ ...config, per_card_minutes: 7 });
  });

  it('falls back to the default minutes when the field is cleared', () => {
    const onChange = jest.fn();
    const config = tarotConfig();
    const { getByTestId } = render(<TarotForm value={config} onChange={onChange} />);

    fireEvent.changeText(getByTestId('tarot-per-card'), '');

    expect(onChange).toHaveBeenCalledWith({ ...config, per_card_minutes: 5 });
  });
});
