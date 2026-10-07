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
import type { InvitationTargetTypeT } from '@/api';
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

/**
 * The ring that owns each invitation target. Mirrors ``RING_FOR_TARGET`` in
 * ``backend/src/domain/invitations.py``; typed over the API's target-type enum
 * so a new target type does not compile until it names its ring.
 */
export const RING_FOR_TARGET: Readonly<Record<InvitationTargetTypeT, DepthRing>> = {
  habit: 'habits',
  practice: 'practices',
  course: 'course',
  sangha: 'sangha',
  embodied_community: 'sangha',
};

/**
 * Which rings are on right now, one narrow subscription per ring. For a
 * surface that lists items across rings and must drop a declined ring's items
 * live, without waiting for its next fetch.
 */
export function useEnabledRings(): Readonly<Record<DepthRing, boolean>> {
  return {
    habits: useRingEnabled('habits'),
    practices: useRingEnabled('practices'),
    course: useRingEnabled('course'),
    sangha: useRingEnabled('sangha'),
  };
}
