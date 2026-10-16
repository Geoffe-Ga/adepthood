/**
 * Which of the user's habits a timer logs to (#3154).
 *
 * Two sources feed a habit from a timer: the journal's writing timer (its one
 * link, mirrored in ``useWritingHabitLinkStore``) and every adopted practice
 * whose ``habit_id`` is set (#3151). The server's guard
 * (``domain/habit_links.linked_habit_ids``) takes the same union, so the
 * editor and the guard agree about which habits may only count minutes or
 * sessions.
 *
 * Reading is best effort. Until both answers land, or if either fails, a
 * habit reads as unlinked and keeps every unit: the backend guard still
 * refuses a non-timer unit with a 422, which the habit actions surface.
 */
import { useEffect, useMemo, useState } from 'react';

import { userPractices } from '../../../api';
import { useAuth } from '../../../context/AuthContext';
import { useWritingHabitLinkStore } from '../../../store/useWritingHabitLinkStore';

/** No practice is linked, or none is known yet. Shared so the memo stays stable. */
const NO_PRACTICE_LINKS: readonly number[] = [];

/** The habit ids the caller's adopted practices log to. */
const loadPracticeHabitIds = async (token?: string): Promise<number[]> => {
  const rows = await userPractices.list(token);
  return rows.flatMap((row) => (row.habit_id == null ? [] : [row.habit_id]));
};

export const useLinkedHabitIds = (): ReadonlySet<number> => {
  const { token } = useAuth();
  const writingHabitId = useWritingHabitLinkStore((state) => state.habitId);
  const hydrateWritingLink = useWritingHabitLinkStore((state) => state.hydrate);
  const [practiceHabitIds, setPracticeHabitIds] = useState<readonly number[]>(NO_PRACTICE_LINKS);

  useEffect(() => {
    void hydrateWritingLink(token ?? undefined);
  }, [hydrateWritingLink, token]);

  useEffect(() => {
    // An answer that lands after the token changed (or the editor closed)
    // belongs to a request this view no longer stands behind.
    let current = true;
    loadPracticeHabitIds(token ?? undefined)
      .then((ids) => {
        if (current) setPracticeHabitIds(ids);
      })
      .catch(() => {
        if (current) setPracticeHabitIds(NO_PRACTICE_LINKS);
      });
    return () => {
      current = false;
    };
  }, [token]);

  return useMemo(() => {
    const ids = new Set(practiceHabitIds);
    if (writingHabitId !== null) ids.add(writingHabitId);
    return ids;
  }, [practiceHabitIds, writingHabitId]);
};
