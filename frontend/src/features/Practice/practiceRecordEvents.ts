import { useSyncExternalStore } from 'react';

import { isAuthScopeCurrent, type AuthScope } from '@/api/sessionToken';

let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => revision;

/** Carries no private payload; only a confirmed save in the live account may notify. */
export function notifyPracticeRecordSaved(scope: AuthScope): void {
  if (scope.owner === null || !isAuthScopeCurrent(scope)) return;
  revision += 1;
  listeners.forEach((listener) => listener());
}
export const usePracticeRecordRevision = (): number =>
  useSyncExternalStore(subscribe, snapshot, snapshot);
