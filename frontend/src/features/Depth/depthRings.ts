/**
 * The client-side ring vocabulary (#3073): one name per optional depth, and the
 * single question every Journal surface asks before offering a way into one —
 * "has this user left that ring on?".
 *
 * Mirrors ``DepthRing`` in ``backend/src/domain/depth_preferences.py``. The
 * server is authoritative for what it generates and lists (invitations, the
 * contraction reflection); this hook gates the offers that are composed on the
 * client, such as the finished-writing-session note.
 */
import {
  useDepthPreferencesStore,
  type DepthPreferencesStoreState,
} from '@/store/useDepthPreferencesStore';

export type DepthRing = 'habits' | 'practices' | 'course' | 'sangha';

export const DEPTH_RINGS: readonly DepthRing[] = ['habits', 'practices', 'course', 'sangha'];

type RingFlag = 'enable_habits' | 'enable_practices' | 'enable_course' | 'enable_sangha';

/** The depth-preferences store flag that records each ring's toggle. */
export const RING_FLAG: Readonly<Record<DepthRing, RingFlag>> = {
  habits: 'enable_habits',
  practices: 'enable_practices',
  course: 'enable_course',
  sangha: 'enable_sangha',
};

/** Whether ``ring`` is enabled, subscribed narrowly so only its own toggle re-renders. */
export function useRingEnabled(ring: DepthRing): boolean {
  const flag = RING_FLAG[ring];
  return useDepthPreferencesStore((state: DepthPreferencesStoreState) => state[flag]);
}
