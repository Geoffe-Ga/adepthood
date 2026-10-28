import { useCallback, useEffect, useRef, useState } from 'react';

import { reportDiagnostic } from '@/observability/diagnostics';
import {
  loadReflectionDismissed,
  saveReflectionDismissed,
} from '@/storage/reflectionDismissalStorage';
import { useAccountScope } from '@/storage/useActiveUser';

/** A local invitation identity, distinct from the calendar's cN:scope keys. */
export const EARLY_REVIEW_DISMISSAL_KEY = 'early-review-invitation';

/** The early-review invitation stays set aside until this account restores it. */
export function useEarlyReviewDismissal(refreshKey = 0) {
  const { epoch, isCurrent } = useAccountScope();
  const [answer, setAnswer] = useState<{ epoch: number; dismissed: boolean } | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    let active = true;
    const startedAt = revision.current;
    void loadReflectionDismissed(EARLY_REVIEW_DISMISSAL_KEY).then((dismissed) => {
      if (active && isCurrent() && startedAt === revision.current) setAnswer({ epoch, dismissed });
    });
    return () => {
      active = false;
    };
  }, [epoch, isCurrent, refreshKey]);

  const change = useCallback(
    async (dismissed: boolean): Promise<boolean> => {
      if (!isCurrent()) return false;
      revision.current += 1;
      const startedAt = revision.current;
      try {
        // Save before removing the control: a failed write leaves the invitation
        // available, and the shared storage queue preserves rapid change ordering.
        await saveReflectionDismissed(EARLY_REVIEW_DISMISSAL_KEY, dismissed);
        if (!isCurrent() || startedAt !== revision.current) return false;
        setAnswer({ epoch, dismissed });
        return true;
      } catch {
        reportDiagnostic('storage_write_failed', { storage: 'reflection_dismissal' });
        return false;
      }
    },
    [epoch, isCurrent],
  );

  return { dismissed: answer?.epoch === epoch ? answer.dismissed : null, change };
}
