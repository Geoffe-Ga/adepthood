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
import { useAuth } from '@/context/AuthContext';
import {
  loadReflectionDismissed,
  saveReflectionDismissed,
} from '@/storage/reflectionDismissalStorage';
import { useAccountScope } from '@/storage/useActiveUser';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/** A due review plus the stage title its program name needs (null for non-stage scopes). */
export interface DueReview {
  scope: ReviewScope;
  stageTitle: string | null;
}

/** ``loading`` until the first due lookup settles, one way or the other. */
export type DueReviewStatus = 'loading' | 'settled';

/**
 * The due review for today, or null. Never rejects.
 *
 * ``isCurrent`` is checked after each await, so a lookup whose account was
 * replaced mid-flight reads nothing further in the new account's scope.
 */
async function resolveDueReview(
  isCurrent: () => boolean,
  token: string,
): Promise<DueReview | null> {
  try {
    const { due } = await reflections.due(token);
    if (due == null || !isCurrent()) return null;
    if (await loadReflectionDismissed(due.scope_key)) return null;
    if (!isCurrent()) return null;
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
  const { token } = useAuth();
  const { owner, epoch, isCurrent } = useAccountScope();
  // Auth adopts the durable namespace before committing its token to React.
  // That transition must not start an old credential's read in the new scope.
  const credentialOwner = token ? parseUserId(decodeJwtPayload(token)?.sub) : null;
  const authenticated = owner !== null && credentialOwner === owner;
  const [answer, setAnswer] = useState<{ epoch: number; review: DueReview | null } | null>(null);
  const status: DueReviewStatus = authenticated && answer?.epoch === epoch ? 'settled' : 'loading';
  const review = authenticated && answer?.epoch === epoch ? answer.review : null;

  useFocusEffect(
    useCallback(() => {
      if (!authenticated || token === null || owner === null) return;
      let active = true;
      void resolveDueReview(isCurrent, token).then((resolved) => {
        if (!active || !isCurrent()) return;
        // Null is written too: a review that has since closed must go away.
        setAnswer({ epoch, review: resolved });
      });
      return () => {
        active = false;
      };
    }, [owner, epoch, isCurrent, token, authenticated]),
  );

  const dismiss = useCallback(() => {
    if (review == null || !isCurrent()) return;
    // Only this scope is set aside; the morning-pages tip keeps its own say.
    void saveReflectionDismissed(review.scope.scope_key, true);
    setAnswer({ epoch, review: null });
  }, [review, epoch, isCurrent]);

  return { status, review, dismiss };
}
