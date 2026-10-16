/**
 * ``useNotificationCount`` (#3142) — how many items wait in the Notification
 * Center: the Return card (0/1), the invitations still on offer in rings the
 * writer kept, the stage prompts not set aside, and the voice band (0/1).
 *
 * A count of items, nothing more (NORTH-STAR §3): no badge, no streak, no
 * colour. The stat tiles are counters, not items, and never count.
 *
 * The hook reads each source with the same hook its section uses, so a card the
 * section would hide is never counted, and it re-reads them whenever the screen
 * holding it regains focus — a card dismissed inside the Notification Center is
 * gone from the count when the writer comes back.
 */
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef, useState } from 'react';

import {
  useStagePromptPlace,
  useStagePrompts,
  visibleStagePromptCount,
} from './StagePromptSection';
import { useVoiceReadinessState } from './VoiceReadinessBand';

import { useEnabledRings, useRingEnabled } from '@/features/Depth/depthRings';
import { visibleInvitations } from '@/features/Invitations/InvitationStack';
import { useInvitations } from '@/features/Invitations/useInvitations';
import { returnSurfaceVisible } from '@/features/Return/ReturnStack';
import { useMettaReturn } from '@/features/Return/useMettaReturn';

/** What each source contributes to the count. */
export interface NotificationTally {
  /** A Return card is showing (the offer, a running arc, or a resting habit). */
  returnDue: boolean;
  /** Invitations on offer in rings the writer kept. */
  invitations: number;
  /** Stage prompt cards not set aside. */
  stagePrompts: number;
  /** The voice-readiness band is showing. */
  voiceBand: boolean;
}

/** The items waiting, summed: each card is one, however it got there. */
export function countNotifications(tally: NotificationTally): number {
  return Number(tally.returnDue) + tally.invitations + tally.stagePrompts + Number(tally.voiceBand);
}

/**
 * A number that moves each time the screen regains focus, and not on the first
 * focus — the sources already read once on mount, and a second read straight
 * after it would only double the requests.
 */
export function useFocusRefreshKey(): number {
  const [key, setKey] = useState(0);
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) setKey((k) => k + 1);
      focusedBefore.current = true;
    }, []),
  );
  return key;
}

/** The number of items waiting in the Notification Center. */
export function useNotificationCount(): number {
  const refreshKey = useFocusRefreshKey();
  // Return is a way back into habits: a declined habits ring neither loads it
  // nor counts it, exactly as ``DepthGate`` keeps it off the home (#3073).
  const habitsOn = useRingEnabled('habits');
  const returnState = useMettaReturn({ enabled: habitsOn, refreshKey });
  const { invitations } = useInvitations(refreshKey);
  const rings = useEnabledRings();
  const { week, stage } = useStagePromptPlace();
  const band = useStagePrompts(stage, week);
  const { band: voice } = useVoiceReadinessState(refreshKey);
  return countNotifications({
    returnDue: habitsOn && returnSurfaceVisible(returnState),
    invitations: visibleInvitations(invitations, rings).length,
    stagePrompts: visibleStagePromptCount(band),
    voiceBand: voice !== null,
  });
}
