/**
 * `useActivePractice` — single-source-of-truth for the user's currently
 * active practice in a stage.
 *
 * Extracted from the pre-ritual-11 `usePracticeListState` + `usePracticeSelect`
 * blob in `PracticeScreen.tsx` so the screen composition (ritual-11) can be
 * read top-to-bottom without state-machine plumbing inline.
 *
 * Responsibilities:
 *   - Fetch the stage's catalogue and the user's `UserPractice` rows.
 *   - Resolve the active row for the given stage and derive `effectiveName`
 *     and `effectiveConfig` (server-supplied when present, otherwise merge
 *     `mode_config_override ?? practice.mode_config`).
 *   - Expose `selectPractice` which writes via `userPractices.create`.
 *   - Expose `updateActivePractice` so a customise/replace mutation in a
 *     child component (e.g. `RitualConfiguratorSheet`, `PracticeSwitcherSheet`)
 *     can refresh the active row without forcing a full `refresh()`.
 *
 * Returns `effectiveConfig: null` when the user has no active practice yet —
 * `PracticeScreen` switches on this to render the selector instead of the
 * mode views.
 */
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { practices, userPractices } from '@/api';
import type { PracticeItem, UserPractice } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import type { ModeConfig } from '@/features/Practice/engine/types';

const LOAD_FALLBACK =
  "We couldn't load your practices. Check your connection, then tap Retry to try again.";
const SELECT_FALLBACK =
  "We couldn't save your practice selection. Check your connection and try again.";

export interface UseActivePracticeResult {
  availablePractices: PracticeItem[];
  activeUserPractice: UserPractice | null;
  practice: PracticeItem | null;
  effectiveName: string | null;
  effectiveConfig: ModeConfig | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Create/replace the active practice for the stage. */
  selectPractice: (_practiceId: number) => Promise<void>;
  /** Replace the in-memory active `UserPractice` after a child mutation. */
  updateActivePractice: (_next: UserPractice) => void;
}

interface State {
  availablePractices: PracticeItem[];
  activeUserPractice: UserPractice | null;
  isLoading: boolean;
  error: string | null;
}

const INITIAL_STATE: State = {
  availablePractices: [],
  activeUserPractice: null,
  isLoading: true,
  error: null,
};

function resolveEffective(
  practice: PracticeItem | null,
  active: UserPractice | null,
): { name: string | null; config: ModeConfig | null } {
  if (!active || !practice) return { name: null, config: null };
  const name = active.effective_name ?? active.custom_name ?? practice.name;
  const config =
    active.effective_config ?? active.mode_config_override ?? practice.mode_config ?? null;
  return { name, config };
}

function useMountedRef(): MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

function useRefreshAction(
  stageNumber: number,
  setState: Dispatch<SetStateAction<State>>,
  mountedRef: RefObject<boolean>,
): () => Promise<void> {
  return useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const [practiceList, userPracticeList] = await Promise.all([
        practices.listAll(stageNumber),
        userPractices.list(),
      ]);
      if (!mountedRef.current) return;
      // Strict `=== null` matches the backend contract: a closed row gets
      // an ISO date string in `end_date`, an open row gets JSON `null`.
      // The OpenAPI schema is `string | null`, so an empty string would be
      // a schema violation — flag it loudly if a future migration ever
      // emits one rather than silently filtering past it.
      const active =
        userPracticeList.find((up) => up.stage_number === stageNumber && up.end_date === null) ??
        null;
      setState({
        availablePractices: practiceList,
        activeUserPractice: active,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: formatApiError(err, { fallback: LOAD_FALLBACK }),
      }));
    }
  }, [stageNumber, setState, mountedRef]);
}

function useSelectAction(
  stageNumber: number,
  setState: Dispatch<SetStateAction<State>>,
  mountedRef: RefObject<boolean>,
): (_id: number) => Promise<void> {
  const submittingRef = useRef(false);
  return useCallback(
    async (practiceId: number) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        const created = await userPractices.create({
          practice_id: practiceId,
          stage_number: stageNumber,
        });
        if (!mountedRef.current) return;
        setState((prev) => ({ ...prev, activeUserPractice: created, error: null }));
      } catch (err) {
        if (!mountedRef.current) return;
        setState((prev) => ({
          ...prev,
          error: formatApiError(err, { fallback: SELECT_FALLBACK }),
        }));
      } finally {
        submittingRef.current = false;
      }
    },
    [stageNumber, setState, mountedRef],
  );
}

export function useActivePractice(stageNumber: number): UseActivePracticeResult {
  const [state, setState] = useState<State>(INITIAL_STATE);
  const mountedRef = useMountedRef();
  const refresh = useRefreshAction(stageNumber, setState, mountedRef);
  const selectPractice = useSelectAction(stageNumber, setState, mountedRef);
  const updateActivePractice = useCallback(
    (next: UserPractice) => {
      setState((prev) => ({ ...prev, activeUserPractice: next, error: null }));
    },
    [setState],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const practice = useMemo(() => {
    const active = state.activeUserPractice;
    if (!active) return null;
    return state.availablePractices.find((p) => p.id === active.practice_id) ?? null;
  }, [state.activeUserPractice, state.availablePractices]);
  const { name: effectiveName, config: effectiveConfig } = useMemo(
    () => resolveEffective(practice, state.activeUserPractice),
    [practice, state.activeUserPractice],
  );
  return {
    availablePractices: state.availablePractices,
    activeUserPractice: state.activeUserPractice,
    practice,
    effectiveName,
    effectiveConfig,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
    selectPractice,
    updateActivePractice,
  };
}
