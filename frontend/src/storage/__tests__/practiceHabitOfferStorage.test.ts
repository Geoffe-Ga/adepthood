import { beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadPracticeHabitOfferAnswered,
  savePracticeHabitOfferAnswered,
} from '../practiceHabitOfferStorage';
import { setActiveUser } from '../userScope';
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  setActiveUser(1);
});
it('remembers an answer per adoption and owner across reloads', async () => {
  expect(await loadPracticeHabitOfferAnswered(7)).toBe(false);
  expect(await savePracticeHabitOfferAnswered(7)).toBe(true);
  expect(await loadPracticeHabitOfferAnswered(7)).toBe(true);
  expect(await loadPracticeHabitOfferAnswered(8)).toBe(false);
  setActiveUser(2);
  expect(await loadPracticeHabitOfferAnswered(7)).toBe(false);
  setActiveUser(1);
  expect(await loadPracticeHabitOfferAnswered(7)).toBe(true);
});
it('keeps a captured answer in the previous owner namespace', async () => {
  const owner = 1;
  setActiveUser(2);
  await savePracticeHabitOfferAnswered(7, owner);
  expect(await loadPracticeHabitOfferAnswered(7)).toBe(false);
  setActiveUser(1);
  expect(await loadPracticeHabitOfferAnswered(7)).toBe(true);
});
it('does not offer or write while anonymous', async () => {
  setActiveUser(null);
  expect(await loadPracticeHabitOfferAnswered(7)).toBeNull();
  expect(await savePracticeHabitOfferAnswered(7)).toBe(false);
  expect(await AsyncStorage.getAllKeys()).toEqual([]);
});
it('treats a failed or malformed read as unknown, keeping an unconfirmed offer quiet', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
  expect(await loadPracticeHabitOfferAnswered(7)).toBeNull();
  await AsyncStorage.setItem('@adepthood/practice_habit_offer_answered/7#u1', 'broken');
  expect(await loadPracticeHabitOfferAnswered(7)).toBeNull();
});
it('reports a failed save without claiming durable suppression', async () => {
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('full'));
  expect(await savePracticeHabitOfferAnswered(7)).toBe(false);
});
