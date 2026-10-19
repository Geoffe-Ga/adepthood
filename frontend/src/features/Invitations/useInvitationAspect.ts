import { useEffect, useState } from 'react';

import type { Invitation } from '@/api';
import { stages } from '@/api';
import { useStageStore } from '@/store/useStageStore';

type AspectByStage = Readonly<Record<number, string | undefined>>;

/**
 * Global, visit-free curriculum vocabulary is identical for every account.
 * Share one in-flight/settled read across a stack of invitation cards; a
 * failure clears the lease so a later mount may retry while this card keeps its
 * honest generic fallback.
 */
let correspondenceLease: Promise<AspectByStage> | null = null;

function servedAspects(): Promise<AspectByStage> {
  if (correspondenceLease === null) {
    correspondenceLease = stages
      .correspondence()
      .then((rows) => Object.fromEntries(rows.map((row) => [row.stage_number, row.aspect])))
      .catch(() => {
        correspondenceLease = null;
        return {};
      });
  }
  return correspondenceLease;
}

/** Test isolation for the module-level, global-vocabulary lease. */
export function resetInvitationAspectCacheForTests(): void {
  correspondenceLease = null;
}

/**
 * Resolve a course invitation's Aspect without turning a Journal visit into a
 * Course/Map visit. The already-loaded stage store wins. On a cold Journal
 * route, the visit-free correspondence endpoint supplies only vocabulary.
 */
export function useInvitationAspect(invitation: Invitation): string | undefined {
  const stageNumber = invitation.target_type === 'course' ? invitation.target_id : null;
  const stored = useStageStore((state) =>
    stageNumber === null ? undefined : state.stagesByNumber[stageNumber]?.aspect,
  );
  const [served, setServed] = useState<string | undefined>();

  useEffect(() => {
    setServed(undefined);
    if (stageNumber === null || stored?.trim()) return undefined;
    let active = true;
    void servedAspects().then((aspects) => {
      if (active) setServed(aspects[stageNumber]);
    });
    return () => {
      active = false;
    };
  }, [stageNumber, stored]);

  return stored?.trim() ? stored : served;
}
