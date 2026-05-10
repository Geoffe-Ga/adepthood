import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';

import Toast, { type ToastConfig } from './Toast';

interface ToastContextValue {
  showToast: (config: ToastConfig) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_GAP_MS = 400;

interface ToastQueue {
  showToast: (_config: ToastConfig) => void;
  handleDismiss: () => void;
  currentToast: ToastConfig | null;
}

/**
 * Single hook owning the queue, the dismiss timer, and the
 * ``isShowing`` flag (BUG-FE-UI-105 / BUG-FE-UI-106).  Pulling the
 * mechanics out of the provider keeps the component body inside the
 * 50-line lint budget while still letting the test suite drive the
 * race directly via ``ToastProvider``.
 */
function useToastQueue(): ToastQueue {
  const [currentToast, setCurrentToast] = useState<ToastConfig | null>(null);
  const queueRef = useRef<ToastConfig[]>([]);
  const isShowingRef = useRef(false);
  const gapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNext = useCallback(() => {
    const next = queueRef.current.shift();
    isShowingRef.current = next !== undefined;
    setCurrentToast(next ?? null);
  }, []);

  const handleDismiss = useCallback(() => {
    // BUG-FE-UI-105: flip the showing flag NOW so a ``showToast`` arriving
    // inside the gap window enqueues onto ``queueRef`` (single source of
    // truth) instead of racing with the timed ``showNext`` callback.
    isShowingRef.current = false;
    setCurrentToast(null);
    if (gapTimerRef.current !== null) clearTimeout(gapTimerRef.current);
    gapTimerRef.current = setTimeout(() => {
      gapTimerRef.current = null;
      showNext();
    }, TOAST_GAP_MS);
  }, [showNext]);

  const showToast = useCallback(
    (config: ToastConfig) => {
      queueRef.current.push(config);
      // Synchronous fast-path only when nothing is showing AND no gap
      // timer is pending; otherwise the queued callback will pick it up.
      if (!isShowingRef.current && gapTimerRef.current === null) showNext();
    },
    [showNext],
  );

  // BUG-FE-UI-106: clear the gap timer on unmount so detached providers
  // never call ``setCurrentToast`` on a torn-down tree.
  useEffect(
    () => () => {
      if (gapTimerRef.current !== null) {
        clearTimeout(gapTimerRef.current);
        gapTimerRef.current = null;
      }
    },
    [],
  );

  return { showToast, handleDismiss, currentToast };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { showToast, handleDismiss, currentToast } = useToastQueue();

  // BUG-FRONTEND-INFRA-004: a fresh ``{ showToast }`` on every render would
  // force every consumer of ``useToast`` to re-render too. ``showToast`` is
  // already stable via useCallback, so the memoized object wrapper is the
  // complete fix.
  const contextValue = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <View style={styles.overlay} pointerEvents="none" testID="toast-overlay">
        {currentToast ? <Toast {...currentToast} onDismiss={handleDismiss} /> : null}
      </View>
    </ToastContext.Provider>
  );
}

const NOOP_CONTEXT: ToastContextValue = {
  showToast: () => {
    // no-op: ToastProvider not mounted
  },
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  return context ?? NOOP_CONTEXT;
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    zIndex: 9999,
  },
});
