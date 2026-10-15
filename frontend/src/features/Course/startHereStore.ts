import { create } from 'zustand';

import { captureCourseSession, type CourseSession } from './courseSession';

import { course, type CourseProgress, type SiteResource } from '@/api';
import { reportDiagnostic } from '@/observability/diagnostics';
import { getActiveUser, getActiveUserGeneration } from '@/storage/userScope';
import { registerStoreReset } from '@/store/registry';

export interface StartHereSnapshot {
  resources: SiteResource[];
  progress: CourseProgress;
}

export type StartHereStatus = 'idle' | 'loading' | 'ready' | 'error';

interface StartHereState {
  resources: SiteResource[];
  progress: CourseProgress | null;
  status: StartHereStatus;
  /** Reset is monotonic even when the same account signs in again. */
  epoch: number;
  load: (_force?: boolean) => Promise<StartHereSnapshot | null>;
  reset: () => void;
}

let sequence = 0;
let owner = getActiveUser();
let ownerGeneration = getActiveUserGeneration();
let inFlight: Promise<StartHereSnapshot | null> | null = null;

async function readResources(
  request: number,
  session: CourseSession,
): Promise<StartHereSnapshot | null> {
  const current = () => sequence === request && session.current();
  try {
    const [resources, progress] = await Promise.all([
      course.siteResources(session.token),
      course.startHereProgress(session.token),
    ]);
    if (!current()) return null;
    const snapshot = { resources: [...resources].sort((a, b) => a.order - b.order), progress };
    useStartHereStore.setState({ ...snapshot, status: 'ready' });
    return snapshot;
  } catch {
    if (current()) {
      useStartHereStore.setState({ status: 'error' });
      reportDiagnostic('course_load_failed');
    }
    return null;
  } finally {
    if (sequence === request) inFlight = null;
  }
}

function load(force = false): Promise<StartHereSnapshot | null> {
  if (owner !== getActiveUser() || ownerGeneration !== getActiveUserGeneration())
    useStartHereStore.getState().reset();
  const session = captureCourseSession();
  if (!session) {
    sequence += 1;
    inFlight = null;
    useStartHereStore.setState({ status: 'error' });
    return Promise.resolve(null);
  }
  if (!force && inFlight) return inFlight;
  const state = useStartHereStore.getState();
  if (!force && state.status === 'ready' && state.progress) {
    return Promise.resolve({ resources: state.resources, progress: state.progress });
  }
  const request = ++sequence;
  useStartHereStore.setState({ status: 'loading' });
  inFlight = readResources(request, session);
  return inFlight;
}

export const useStartHereStore = create<StartHereState>((set) => ({
  resources: [],
  progress: null,
  status: 'idle',
  epoch: 0,
  load,
  reset: () => {
    sequence += 1;
    owner = getActiveUser();
    ownerGeneration = getActiveUserGeneration();
    inFlight = null;
    set((state) => ({ resources: [], progress: null, status: 'idle', epoch: state.epoch + 1 }));
  },
}));

registerStoreReset(() => useStartHereStore.getState().reset());
