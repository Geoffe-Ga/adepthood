/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import ResonanceRefillDialog from '../ResonanceRefillDialog';

/**
 * A resonance pass with no personal key and no credits is refused before
 * anything is spent (#3096). The refill dialog is that refusal's surface, so it
 * names both ways forward and says the writer was not charged.
 */
function renderDialog(reason: 'wallet_exhausted' | 'key_required') {
  return render(
    <ResonanceRefillDialog
      visible
      monthlyResetDate={null}
      monthlyCap={null}
      reason={reason}
      onAddKey={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
}

describe('ResonanceRefillDialog — a refused pass says how to proceed', () => {
  it('an empty wallet offers credits or a key, and says nothing was charged', () => {
    const { getByText } = renderDialog('wallet_exhausted');

    expect(getByText(/BotMason balance has run out/u)).toBeTruthy();
    expect(getByText(/credits/iu)).toBeTruthy();
    expect(getByText(/nothing was charged/iu)).toBeTruthy();
  });

  it('a missing key says nothing was charged', () => {
    const { getByText } = renderDialog('key_required');

    expect(getByText(/needs an API key of your own/u)).toBeTruthy();
    expect(getByText(/nothing was charged/iu)).toBeTruthy();
  });
});
