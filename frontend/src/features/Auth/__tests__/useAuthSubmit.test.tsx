import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import type { RequiredField } from '../requiredFieldValidation';
import { useAuthSubmit } from '../useAuthSubmit';

import { FIELD_VALIDATION_MESSAGE } from '@/api/errorMessages';
import { ApiError } from '@/api/index';

const FALLBACK = 'We could not complete that. Try again in a moment.';
const EMAIL = 'email';
const PASSWORD = 'password'; // pragma: allowlist secret -- a field label, not a credential
const BLANK_EMAIL: readonly RequiredField[] = [{ label: EMAIL, submitted: '' }];

function makeDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (_e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (_e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAuthSubmit', () => {
  it('starts with submitting false and error null', () => {
    const fn = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK, required: [] }));

    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets submitting true mid-flight and clears it and any prior error on success', async () => {
    const deferred = makeDeferred();
    const fn = jest.fn(() => deferred.promise);
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK, required: [] }));

    act(() => {
      result.current.setError('boom');
    });
    expect(result.current.error).toBe('boom');

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run();
    });
    expect(result.current.submitting).toBe(true);

    await act(async () => {
      deferred.resolve();
      await runPromise;
    });

    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets error to the exact fallback string on rejection and resets submitting', async () => {
    const deferred = makeDeferred();
    const fn = jest.fn(() => deferred.promise);
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK, required: [] }));

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run();
    });

    await act(async () => {
      deferred.reject(new Error('network down'));
      await runPromise;
    });

    expect(result.current.error).toBe(FALLBACK);
    expect(result.current.submitting).toBe(false);
  });

  it('ignores a second run while one is already in flight', async () => {
    const deferred = makeDeferred();
    const fn = jest.fn(() => deferred.promise);
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK, required: [] }));

    let firstRun!: Promise<void>;
    let secondRun!: Promise<void>;
    act(() => {
      firstRun = result.current.run();
      secondRun = result.current.run();
    });

    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve();
      await firstRun;
      await secondRun;
    });

    const secondDeferred = makeDeferred();
    fn.mockReturnValueOnce(secondDeferred.promise);

    let thirdRun!: Promise<void>;
    act(() => {
      thirdRun = result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondDeferred.resolve();
      await thirdRun;
    });
  });

  it('keeps a stable run identity and always invokes the latest fn passed in', async () => {
    const firstFn = jest.fn(() => Promise.resolve());
    const secondFn = jest.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(
      ({ fn }: { fn: () => Promise<void> }) =>
        useAuthSubmit(fn, { fallback: FALLBACK, required: [] }),
      { initialProps: { fn: firstFn } },
    );

    const firstRun = result.current.run;
    rerender({ fn: secondFn });
    expect(Object.is(firstRun, result.current.run)).toBe(true);

    await act(async () => {
      await result.current.run();
    });

    expect(secondFn).toHaveBeenCalledTimes(1);
    expect(firstFn).not.toHaveBeenCalled();
  });
});

describe('useAuthSubmit required-field guard', () => {
  it('never invokes fn and never sets submitting when a required field is blank', async () => {
    const fn = jest.fn(() => Promise.resolve());
    const seenSubmitting: boolean[] = [];
    const { result } = renderHook(() => {
      const submit = useAuthSubmit(fn, { fallback: FALLBACK, required: BLANK_EMAIL });
      seenSubmitting.push(submit.submitting);
      return submit;
    });

    await act(async () => {
      await result.current.run();
    });

    expect(fn).not.toHaveBeenCalled();
    expect(seenSubmitting).not.toContain(true);
    expect(result.current.error).toBe('Enter your email to continue.');
    expect([...result.current.missing]).toEqual([EMAIL]);
  });

  it('names every blank field at once', async () => {
    const fn = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useAuthSubmit(fn, {
        fallback: FALLBACK,
        required: [
          { label: EMAIL, submitted: '' },
          { label: PASSWORD, submitted: '' },
        ],
      }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe('Enter your email and password to continue.');
    expect([...result.current.missing]).toEqual([EMAIL, PASSWORD]);
  });

  it('keeps the required message across a repeated submit', async () => {
    const fn = jest.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useAuthSubmit(fn, { fallback: FALLBACK, required: BLANK_EMAIL }),
    );

    await act(async () => {
      await result.current.run();
    });
    const firstMessage = result.current.error;
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe(firstMessage);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clears the guard message once the offending field is filled, and submits after', async () => {
    const fn = jest.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(
      ({ email }: { email: string }) =>
        useAuthSubmit(fn, { fallback: FALLBACK, required: [{ label: EMAIL, submitted: email }] }),
      { initialProps: { email: '' } },
    );

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).not.toBeNull();

    act(() => {
      rerender({ email: 'user@test.com' });
    });

    expect(result.current.error).toBeNull();
    expect([...result.current.missing]).toEqual([]);

    await act(async () => {
      await result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('leaves a server error alone when a field is edited', async () => {
    const fn = jest.fn(() => Promise.reject(new Error('server said no')));
    const { result, rerender } = renderHook(
      ({ email }: { email: string }) =>
        useAuthSubmit(fn, { fallback: FALLBACK, required: [{ label: EMAIL, submitted: email }] }),
      { initialProps: { email: 'user@test.com' } },
    );

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe(FALLBACK);

    act(() => {
      rerender({ email: 'user2@test.com' });
    });

    expect(result.current.error).toBe(FALLBACK);
  });

  it('renders field-validation copy for a 422 rather than the screen fallback', async () => {
    const fn = jest.fn(() =>
      Promise.reject(
        new ApiError(
          422,
          'value is not a valid email address: An email address must have an @-sign.',
        ),
      ),
    );
    const { result } = renderHook(() => useAuthSubmit(fn, { fallback: FALLBACK, required: [] }));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe(FIELD_VALIDATION_MESSAGE);
    expect(result.current.error).not.toBe(FALLBACK);
  });

  it('lets a screen override the default 422 copy with its own', async () => {
    const OWN_COPY = 'That reset link no longer matches what we have on file.';
    const fn = jest.fn(() => Promise.reject(new ApiError(422, 'some_unmapped_code')));
    const { result } = renderHook(() =>
      useAuthSubmit(fn, { fallback: FALLBACK, required: [], statusOverrides: { 422: OWN_COPY } }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe(OWN_COPY);
  });
});
