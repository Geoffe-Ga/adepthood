import { beforeEach, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { usePracticeHabitLink } from '../usePracticeHabitLink';

import type { UserPractice } from '@/api';
import { setActiveUser } from '@/storage/userScope';

let mockCurrentToken: string | undefined;
const mockLinkHabit =
  jest.fn<
    (_adoptionId: number, _habitId: number | null, _token?: string) => Promise<UserPractice>
  >();
jest.mock('@/api', () => ({
  captureSessionToken: () => mockCurrentToken,
  userPractices: {
    linkHabit: (...args: [number, number | null, string?]) => mockLinkHabit(...args),
  },
}));

const practice = { id: 7, habit_id: 3 } as UserPractice;
beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  mockCurrentToken = tokenFor(1);
});
function deferred() {
  let resolve!: (_next: UserPractice) => void;
  const promise = new Promise<UserPractice>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('keeps the old link until confirmation and applies the returned row', async () => {
  const d = deferred();
  mockLinkHabit.mockReturnValueOnce(d.promise);
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.save(9);
  });
  expect(onUpdated).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(true);
  await act(async () => {
    d.resolve({ ...practice, habit_id: 9 });
    expect(await saved).toBe(true);
  });
  expect(mockLinkHabit).toHaveBeenCalledWith(7, 9, tokenFor(1));
  expect(onUpdated).toHaveBeenCalledWith({ ...practice, habit_id: 9 });
});
it('clears with null and preserves the old link on failure', async () => {
  mockLinkHabit.mockRejectedValueOnce(new Error('offline'));
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  await act(async () => {
    expect(await result.current.save(null)).toBe(false);
  });
  expect(mockLinkHabit).toHaveBeenCalledWith(7, null, tokenFor(1));
  expect(onUpdated).not.toHaveBeenCalled();
  expect(result.current.error).toContain("couldn't save");
});
it('ignores an old owner response before another React render', async () => {
  const d = deferred();
  mockLinkHabit.mockReturnValueOnce(d.promise);
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.save(9);
  });
  setActiveUser(2);
  await act(async () => {
    d.resolve({ ...practice, habit_id: 9 });
    expect(await saved).toBe(false);
  });
  expect(onUpdated).not.toHaveBeenCalled();
});
it('ignores a response after the active adoption changes', async () => {
  const d = deferred();
  mockLinkHabit.mockReturnValueOnce(d.promise);
  const onUpdated = jest.fn();
  const { result, rerender } = renderHook(
    ({ row }: { row: UserPractice }) => usePracticeHabitLink({ userPractice: row, onUpdated }),
    { initialProps: { row: practice } },
  );
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.save(9);
  });
  rerender({ row: { ...practice, id: 8 } });
  await act(async () => {
    d.resolve({ ...practice, habit_id: 9 });
    expect(await saved).toBe(false);
  });
  expect(onUpdated).not.toHaveBeenCalled();
});
it('coalesces taps and refuses anonymous writes', async () => {
  const d = deferred();
  mockLinkHabit.mockReturnValueOnce(d.promise);
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.save(9);
  });
  await act(async () => {
    expect(await result.current.save(10)).toBe(false);
    d.resolve({ ...practice, habit_id: 9 });
    await saved;
  });
  expect(mockLinkHabit).toHaveBeenCalledTimes(1);
  setActiveUser(null);
  await act(async () => {
    expect(await result.current.save(null)).toBe(false);
  });
  expect(mockLinkHabit).toHaveBeenCalledTimes(1);
});

it('does not revive an old result after leaving and returning to the same owner', async () => {
  const d = deferred();
  mockLinkHabit.mockReturnValueOnce(d.promise);
  const onUpdated = jest.fn();
  const { result, rerender } = renderHook(() =>
    usePracticeHabitLink({ userPractice: practice, onUpdated }),
  );
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.save(9);
  });
  setActiveUser(2);
  rerender(undefined);
  setActiveUser(1);
  rerender(undefined);
  await act(async () => {
    d.resolve({ ...practice, habit_id: 9 });
    expect(await saved).toBe(false);
  });
  expect(onUpdated).not.toHaveBeenCalled();
});

it('rejects a stale owner save closure before the next render', async () => {
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  setActiveUser(2);
  await act(async () => {
    expect(await result.current.save(9)).toBe(false);
  });
  expect(mockLinkHabit).not.toHaveBeenCalled();
});

it('does not revive a pending result after an owner round trip without a React render', async () => {
  const d = deferred();
  mockLinkHabit.mockReturnValueOnce(d.promise);
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.save(9);
  });
  setActiveUser(2);
  setActiveUser(1);
  await act(async () => {
    d.resolve({ ...practice, habit_id: 9 });
    expect(await saved).toBe(false);
  });
  expect(onUpdated).not.toHaveBeenCalled();
});

it('refuses a stale save closure after an owner round trip without a React render', async () => {
  const onUpdated = jest.fn();
  const { result } = renderHook(() => usePracticeHabitLink({ userPractice: practice, onUpdated }));
  setActiveUser(2);
  setActiveUser(1);
  await act(async () => {
    expect(await result.current.save(9)).toBe(false);
  });
  expect(mockLinkHabit).not.toHaveBeenCalled();
});

function tokenFor(owner: number): string {
  return `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4102444800 }))}.signature`;
}
it('refuses a namespace that has advanced before its matching credential commits', async () => {
  setActiveUser(2);
  const { result } = renderHook(() =>
    usePracticeHabitLink({ userPractice: practice, onUpdated: jest.fn() }),
  );
  await act(async () => {
    expect(await result.current.save(9)).toBe(false);
  });
  expect(mockLinkHabit).not.toHaveBeenCalled();
});
it('does not write an authenticated link when no credential is available', async () => {
  mockCurrentToken = undefined;
  const { result } = renderHook(() =>
    usePracticeHabitLink({ userPractice: practice, onUpdated: jest.fn() }),
  );
  await act(async () => {
    expect(await result.current.save(9)).toBe(false);
  });
  expect(mockLinkHabit).not.toHaveBeenCalled();
});
it('pins the matching credential captured when a deliberate link write starts', async () => {
  const captured = tokenFor(1);
  mockCurrentToken = captured;
  mockLinkHabit.mockResolvedValueOnce({ ...practice, habit_id: 9 });
  const { result } = renderHook(() =>
    usePracticeHabitLink({ userPractice: practice, onUpdated: jest.fn() }),
  );
  await act(async () => {
    expect(await result.current.save(9)).toBe(true);
  });
  expect(mockLinkHabit).toHaveBeenCalledWith(7, 9, captured);
});
