import { beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import OfferAction from '../PracticeHabitAction';
import PracticeHabitOffer from '../PracticeHabitOffer';

import { setActiveUser } from '@/storage/userScope';

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  setActiveUser(1);
});
it('declines once and stays quiet after remount, while another adoption gets its own choice', async () => {
  const onLink = jest.fn();
  const screen = render(<PracticeHabitOffer adoptionId={7} onLink={onLink} />);
  await waitFor(() => expect(screen.getByText('Link a habit')).toBeTruthy());
  fireEvent.press(screen.getByText('Maybe later'));
  await waitFor(() => expect(screen.queryByText('Link a habit')).toBeNull());
  expect(onLink).not.toHaveBeenCalled();
  screen.unmount();
  const again = render(<PracticeHabitOffer adoptionId={7} onLink={onLink} />);
  await waitFor(async () =>
    expect(await AsyncStorage.getItem('@adepthood/practice_habit_offer_answered/7#u1')).toBe(
      'true',
    ),
  );
  expect(again.queryByText('Link a habit')).toBeNull();
  again.unmount();
  const other = render(<PracticeHabitOffer adoptionId={8} onLink={onLink} />);
  await waitFor(() => expect(other.getByText('Link a habit')).toBeTruthy());
});
it('opens the picker once, remembers the answer and hides the invitation', async () => {
  const onLink = jest.fn();
  const screen = render(<PracticeHabitOffer adoptionId={7} onLink={onLink} />);
  await waitFor(() => expect(screen.getByText('Link a habit')).toBeTruthy());
  fireEvent.press(screen.getByText('Link a habit'));
  expect(onLink).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Maybe later')).toBeNull();
  await waitFor(async () =>
    expect(await AsyncStorage.getItem('@adepthood/practice_habit_offer_answered/7#u1')).toBe(
      'true',
    ),
  );
});
it('does not show an invitation when its stored answer cannot be confirmed', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('offline storage'));
  const screen = render(<PracticeHabitOffer adoptionId={7} onLink={jest.fn()} />);
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  expect(screen.queryByText('Link a habit')).toBeNull();
});

it('refuses an old offer press after an owner round trip without a React render', async () => {
  const onLink = jest.fn();
  const screen = render(<PracticeHabitOffer adoptionId={7} onLink={onLink} />);
  await waitFor(() => expect(screen.getByText('Link a habit')).toBeTruthy());
  setActiveUser(2);
  setActiveUser(1);
  fireEvent.press(screen.getByText('Link a habit'));
  expect(onLink).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem('@adepthood/practice_habit_offer_answered/7#u1')).toBeNull();
});

it('a retained invitation callback stays quiet after its mounted surface is gone', async () => {
  const onLink = jest.fn();
  const view = render(<PracticeHabitOffer adoptionId={7} onLink={onLink} />);
  await waitFor(() => expect(view.getByTestId('practice-habit-offer-link')).toBeTruthy());
  const retained = view.UNSAFE_getAllByType(OfferAction)[0]?.props.onPress;
  expect(retained).toEqual(expect.any(Function));
  view.unmount();
  await act(async () => {
    retained();
  });
  expect(onLink).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem('@adepthood/practice_habit_offer_answered/7#u1')).toBeNull();
});
