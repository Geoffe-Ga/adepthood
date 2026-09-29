import { act } from '@testing-library/react-native';

/**
 * Let every already-resolved promise land, commit what it rendered, and return.
 *
 * Use it in place of `waitFor` / `findBy*` when the only thing a test is
 * waiting for is work its own mocks have already resolved: an API mock built
 * with `mockResolvedValue`, the store update that awaits it, and the re-render
 * that follows. Then assert synchronously with `getBy*`.
 *
 * Why not `waitFor`: it polls against a wall-clock deadline (RNTL's
 * `asyncUtilTimeout`). The work it waits for costs nothing but CPU, so on a
 * loaded machine the render alone can outlast the deadline and a correct
 * screen fails. This has no deadline -- it finishes when the work is done,
 * however slowly the machine does it.
 *
 * Why it is deterministic: a top-level async `act` does not resolve until it
 * has crossed a real macrotask with nothing left to commit. React 19 schedules
 * that turn through Node's `timers.setImmediate` (`enqueueTask` in
 * react.development.js), which Jest never fakes. The microtask queue drains
 * completely before any macrotask runs, so every finite chain of
 * already-resolved promises -- however many hops deep -- has run by then, and
 * React keeps flushing until the updates they queued are committed. It holds
 * under fake timers too, and never advances the fake clock.
 * `src/testing/__tests__/asyncSettle.test.tsx` pins that behaviour, so a React
 * upgrade that changes it fails there first rather than in a screen suite.
 *
 * What it does NOT cover: work behind a timer, a network round trip, or a
 * promise the test resolves later. Keep awaiting the observable element for
 * those.
 */
export async function settle(): Promise<void> {
  await act(async () => {});
}
