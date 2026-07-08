/**
 * Strict-mode + unmount safety: a ref that reads `true` while mounted and flips
 * to `false` on unmount, so async callbacks can guard `setState` after the
 * component is gone. The ref identity is stable across re-renders.
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
