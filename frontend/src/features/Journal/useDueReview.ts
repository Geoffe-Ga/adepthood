/**
 * ``useDueReview`` — which review, if any, is the shelf's call to write today.
 *
 * Re-read every time the shelf regains focus, so a shelf left open across
 * midnight never offers yesterday's review (issue #2867). Resolves null when
 * nothing is due, when the writer set this scope aside, or on any failure:
 * the shelf then offers the daily page instead, and never sees an error.
 *
 * ``status`` stays ``loading`` until the FIRST answer lands, so the caller can
 * show no card at all rather than flash the daily page and swap it for the
 * review a moment later — a tap in that window would open the wrong page.
 */
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useState } from 'react';

import { resolveStageTitles, type ReviewScope } from './reviewScopes';

import { reflections } from '@/api';
import {
  loadReflectionDismissed,
  saveReflectionDismissed,
} from '@/storage/reflectionDismissalStorage';

/** A due review plus the stage title its program name needs (null for non-stage scopes). */
export interface DueReview {
  scope: ReviewScope;
  stageTitle: string | null;
}

/** ``loading`` until the first due lookup settles, one way or the other. */
export type DueReviewStatus = 'loading' | 'settled';

/** The due review for today, or null. Never rejects. */
async function resolveDueReview(): Promise<DueReview | null> {
  try {
    const { due } = await reflections.due();
    if (due == null) return null;
    if (await loadReflectionDismissed(due.scope_key)) return null;
    const titles = await resolveStageTitles([due]);
    return { scope: due, stageTitle: titles.get(due.scope_key) ?? null };
  } catch {
    return null;
  }
}

export function useDueReview(): {
  status: DueReviewStatus;
  review: DueReview | null;
  dismiss: () => void;
} {
  const [status, setStatus] = useState<DueReviewStatus>('loading');
  const [review, setReview] = useState<DueReview | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void resolveDueReview().then((resolved) => {
        if (!active) return;
        // Null is written too: a review that has since closed must go away.
        setReview(resolved);
        setStatus('settled');
      });
      return () => {
        active = false;
      };
    }, []),
  );

  const dismiss = useCallback(() => {
    if (review == null) return;
    // Only this scope is set aside; the morning-pages tip keeps its own say.
    void saveReflectionDismissed(review.scope.scope_key, true);
    setReview(null);
  }, [review]);

  return { status, review, dismiss };
}
