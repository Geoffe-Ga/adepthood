import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React, { createRef } from 'react';
import type { View } from 'react-native';

import EarlyReviewCard from '../EarlyReviewCard';

import { setActiveUser } from '@/storage/userScope';

function renderCard() {
  return render(
    <EarlyReviewCard
      actionRef={createRef<View>()}
      enabled={false}
      onToggle={jest.fn()}
      onChoose={jest.fn()}
      refreshKey={0}
    />,
  );
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
  setActiveUser(1);
});

describe('declining the early-review card', () => {
  it('stays set aside after remount and returns only when explicitly restored', async () => {
    const first = renderCard();
    await first.findByTestId('journal-review-early');
    fireEvent.press(first.getByTestId('journal-review-early-dismiss'));
    await first.findByTestId('journal-review-early-restore');
    expect(first.queryByTestId('journal-review-early-card')).toBeNull();
    first.unmount();

    const next = renderCard();
    await next.findByTestId('journal-review-early-restore');
    expect(next.queryByTestId('journal-review-early-card')).toBeNull();
    fireEvent.press(next.getByTestId('journal-review-early-restore'));
    await next.findByTestId('journal-review-early-card');
    next.unmount();
    expect(await renderCard().findByTestId('journal-review-early')).toBeTruthy();
  });

  it('keeps a decline with its account on a still-mounted screen', async () => {
    const screen = renderCard();
    await screen.findByTestId('journal-review-early');
    fireEvent.press(screen.getByTestId('journal-review-early-dismiss'));
    await screen.findByTestId('journal-review-early-restore');
    act(() => setActiveUser(2));
    expect(await screen.findByTestId('journal-review-early-card')).toBeTruthy();
    act(() => setActiveUser(1));
    expect(await screen.findByTestId('journal-review-early-restore')).toBeTruthy();
  });

  it('keeps the invitation available when a decline cannot be saved', async () => {
    const screen = renderCard();
    await screen.findByTestId('journal-review-early');
    const write = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    fireEvent.press(screen.getByTestId('journal-review-early-dismiss'));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(screen.getByTestId('journal-review-early-card')).toBeTruthy();
    expect(screen.queryByTestId('journal-review-early-restore')).toBeNull();
    expect(warn).toHaveBeenCalledWith('storage_write_failed', { storage: 'reflection_dismissal' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('disk full');
  });
});
