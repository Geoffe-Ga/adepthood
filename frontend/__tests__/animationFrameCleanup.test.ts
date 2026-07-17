import { describe, it, expect } from '@jest/globals';

/**
 * Guards the animation-frame straggler cleanup installed by `jest.setup.js`.
 *
 * The React Native Jest preset polyfills `requestAnimationFrame` as
 * `setTimeout(cb, 0)`, so a frame scheduled during one test but never flushed
 * fires on the next tick — after the test finished. Left uncancelled, that
 * straggler runs between suites (or, worst case, after the Jest environment is
 * torn down, raising the "environment torn down" ReferenceError that fails a
 * whole suite with zero test failures). The setup's `afterEach` must cancel
 * every outstanding frame so it can never execute past its own test.
 */
describe('requestAnimationFrame teardown cleanup', () => {
  let strayFrameFired = false;

  it('schedules a frame that is never flushed within the test', () => {
    requestAnimationFrame(() => {
      strayFrameFired = true;
    });
    // The frame is queued but not yet run; nothing has fired inside this test.
    expect(strayFrameFired).toBe(false);
  });

  it('cancelled the straggler so it cannot fire on a later macrotask', async () => {
    // Yield to the macrotask queue. Without the setup's afterEach
    // cancellation, the previous test's setTimeout(0)-backed frame is still
    // pending and runs here — before this 1ms timer — flipping the flag.
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    expect(strayFrameFired).toBe(false);
  });
});
