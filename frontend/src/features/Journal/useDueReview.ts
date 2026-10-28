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
import {
  useCallback,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';

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
): Promise<{ review: DueReview; dismissed: boolean } | null> {
  try {
    const { due } = await reflections.due(token);
    if (due == null || !isCurrent()) return null;
    const dismissed = await loadReflectionDismissed(due.scope_key);
    if (!isCurrent()) return null;
    const titles = await resolveStageTitles([due]);
    return { review: { scope: due, stageTitle: titles.get(due.scope_key) ?? null }, dismissed };
  } catch {
    return null;
  }
}

interface ReviewAnswer {
  epoch: number;
  review: DueReview | null;
  dismissed: boolean;
}

function useReviewChoices(
  current: ReviewAnswer | null,
  epoch: number,
  isCurrent: () => boolean,
  setAnswer: Dispatch<SetStateAction<ReviewAnswer | null>>,
  revision: RefObject<number>,
) {
  const change = useCallback(
    async (dismissed: boolean) => {
      const review = current?.review;
      if (review == null || !isCurrent()) return;
      revision.current += 1;
      const startedAt = revision.current;
      // A decline is immediate; a restore is shown only once it is durable.
      if (dismissed) setAnswer({ epoch, review, dismissed: true });
      try {
        await saveReflectionDismissed(review.scope.scope_key, dismissed);
        if (isCurrent() && startedAt === revision.current) setAnswer({ epoch, review, dismissed });
      } catch {
        if (isCurrent() && startedAt === revision.current) setAnswer(current);
      }
    },
    [current, epoch, isCurrent, setAnswer, revision],
  );
  return {
    dismiss: () => {
      void change(true);
    },
    restore: () => change(false),
  };
}

function reviewViews(current: ReviewAnswer | null) {
  return {
    review: current?.dismissed === false ? current.review : null,
    setAsideReview: current?.dismissed === true ? current.review : null,
  };
}

export function useDueReview() {
  const { token } = useAuth();
  const { owner, epoch, isCurrent } = useAccountScope();
  // Auth adopts the namespace before committing its token to React.
  const credentialOwner = token ? parseUserId(decodeJwtPayload(token)?.sub) : null;
  const authenticated = owner !== null && credentialOwner === owner;
  const revision = useRef(0);
  const [answer, setAnswer] = useState<ReviewAnswer | null>(null);
  const current = authenticated && answer?.epoch === epoch ? answer : null;
  const status: DueReviewStatus = current === null ? 'loading' : 'settled';

  useFocusEffect(
    useCallback(() => {
      if (!authenticated || token === null) return;
      let active = true;
      const startedAt = revision.current;
      void resolveDueReview(isCurrent, token).then((resolved) => {
        if (!active || !isCurrent() || startedAt !== revision.current) return;
        setAnswer({
          epoch,
          review: resolved?.review ?? null,
          dismissed: resolved?.dismissed ?? false,
        });
      });
      return () => {
        active = false;
      };
    }, [epoch, isCurrent, token, authenticated]),
  );

  const choices = useReviewChoices(current, epoch, isCurrent, setAnswer, revision);
  return { status, ...reviewViews(current), ...choices };
}
