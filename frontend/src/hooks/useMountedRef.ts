/**
 * Strict-mode + unmount safety: a ref that reads `true` while mounted and flips
 * to `false` on unmount, so async callbacks can guard `setState` after the
 * component is gone. The ref identity is stable across re-renders.
 *
 * The mount effect re-arms the ref on every mount, including StrictMode's
 * simulated unmount/remount, so a hand-rolled copy that only clears the ref in a
 * cleanup strands every guarded callback after that remount. This is the single
 * shared implementation; import it rather than re-rolling the idiom.
 */
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

export function useMountedRef(): MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}
