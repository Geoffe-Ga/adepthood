import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import Toast, { type ToastConfig } from './Toast';

interface ToastContextValue {
  showToast: (config: ToastConfig) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_GAP_MS = 400;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [currentToast, setCurrentToast] = useState<ToastConfig | null>(null);
  const queueRef = useRef<ToastConfig[]>([]);
  const isShowingRef = useRef(false);

  const showNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (next) {
      isShowingRef.current = true;
      setCurrentToast(next);
    } else {
      isShowingRef.current = false;
      setCurrentToast(null);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setCurrentToast(null);
    setTimeout(showNext, TOAST_GAP_MS);
  }, [showNext]);

  const showToast = useCallback(
    (config: ToastConfig) => {
      queueRef.current.push(config);
      if (!isShowingRef.current) {
        showNext();
      }
    },
    [showNext],
  );

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
