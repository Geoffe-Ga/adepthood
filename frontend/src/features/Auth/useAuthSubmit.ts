import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { missingRequiredFields, requiredFieldMessage } from './requiredFieldValidation';
import type { RequiredField } from './requiredFieldValidation';

import { FIELD_VALIDATION_MESSAGE, formatApiError } from '@/api/errorMessages';

/**
 * Shared submit state-machine for the Auth screens.
 *
 * Every auth form is the same shape: an ``error``/``submitting`` pair wrapped
 * around one async call whose failures map through ``formatApiError``. This hook
 * owns that try/catch/finally so Login/Signup/Forgot/Reset/Reauth don't each
 * re-derive it. ``run`` keeps a stable identity (config is stashed in a ref and
 * re-read every call, mirroring ``useOptimisticMutation``) and an in-flight guard
 * makes a synchronous second ``run()`` a no-op until the first settles.
 *
 * ``required`` is deliberately **not** optional. A convention that each screen
 * should remember to check its own fields has already failed twice in this
 * codebase -- the re-auth sheet shipped with no check at all, and the signup
 * form calls two validators and still never looks at the email -- so the check
 * is a type error to omit rather than a review note to miss. A screen with
 * nothing to declare writes ``required: []`` and says in a comment what guards
 * it instead; that is reviewable, an absent option is not.
 *
 * The hook also carries the auth-wide 422 classification. Each screen's
 * ``fallback`` is read by ``formatApiError`` *before* the per-status default, so
 * a screen whose fallback mentions the network would dress a server's
 * "that field is wrong" as a dead connection. Passing the 422 copy as a status
 * override puts it back ahead of the fallback for every auth surface at once,
 * without reordering the shared chain for the twenty non-auth consumers.
 */

/** Copy the auth screens apply to a status their own fallback would out-phrase. */
const AUTH_STATUS_COPY: Readonly<Record<number, string>> = Object.freeze({
  422: FIELD_VALIDATION_MESSAGE,
});

/** Shared identity for "nothing is missing", so a repeat clear re-renders nothing. */
const NO_MISSING_FIELDS: ReadonlySet<string> = new Set<string>();

interface AuthSubmit {
  submitting: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  run: () => Promise<void>;
  /** Labels of the fields the guard refused to send, for per-field affordances. */
  missing: ReadonlySet<string>;
}

interface AuthSubmitOptions {
  /** Copy for a failure no code or status classifies. */
  fallback: string;
  /** Fields this submit refuses to send empty; ``[]`` when something else guards them. */
  required: readonly RequiredField[];
  /** Per-status copy of this screen's own, applied over the auth-wide defaults. */
  statusOverrides?: Partial<Record<number, string>>;
}

interface AuthSubmitConfig extends AuthSubmitOptions {
  fn: () => Promise<void>;
}

/**
 * Copy for a failed call, with the auth-wide status classification applied over
 * a screen's own fallback -- and under a screen's own override, which is spread
 * last so a surface with better words for a status still wins.
 */
function authErrorMessage(err: unknown, cfg: AuthSubmitConfig): string {
  return formatApiError(err, {
    fallback: cfg.fallback,
    statusOverrides: { ...AUTH_STATUS_COPY, ...cfg.statusOverrides },
  });
}

/**
 * Retract a guard message once the user addresses a field it named.
 *
 * The trigger is a field the guard flagged now holding a value -- not a change
 * of any kind to any field. Those are different events, and only one of them is
 * good news. An earlier version keyed on "which fields are currently blank",
 * which moves in both directions: clearing a filled field to retype it read as
 * an edit worth retracting on, so the banner and the field hints vanished at the
 * moment the form became *more* invalid, not less.
 *
 * ``guardedRef`` holds the exact labels the guard flagged, or ``null`` when the
 * banner belongs to someone else -- a server's answer, or a screen's own
 * verdict. Retraction is impossible in that state, by construction rather than
 * by a rule someone has to remember.
 */
function useRetractOnEdit(
  required: readonly RequiredField[],
  guardedRef: RefObject<ReadonlySet<string> | null>,
  setMissing: Dispatch<SetStateAction<ReadonlySet<string>>>,
  setError: Dispatch<SetStateAction<string | null>>,
): void {
  const flagged = guardedRef.current;
  const addressed =
    flagged !== null &&
    required.some((field) => flagged.has(field.label) && field.submitted.length > 0);
  useEffect(() => {
    if (!addressed) return;
    guardedRef.current = null;
    setMissing(NO_MISSING_FIELDS);
    setError(null);
  }, [addressed, guardedRef, setMissing, setError]);
}

export function useAuthSubmit(
  fn: () => Promise<void>,
  { fallback, required, statusOverrides }: AuthSubmitOptions,
): AuthSubmit {
  const [error, setErrorState] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [missing, setMissing] = useState<ReadonlySet<string>>(NO_MISSING_FIELDS);

  const cfgRef = useRef<AuthSubmitConfig>({ fn, fallback, required, statusOverrides });
  cfgRef.current = { fn, fallback, required, statusOverrides };

  const inFlightRef = useRef(false);
  // The labels the guard flagged, or null when the banner holds anything else.
  // Non-null is the only state in which a retraction is possible at all.
  const guardedRef = useRef<ReadonlySet<string> | null>(null);

  // A caller writing the banner itself -- ``useSignupForm``'s password verdict,
  // ``ResetPasswordScreen``'s pair check -- takes the banner back from the
  // guard. The per-field flags go with it: they exist to explain the guard's
  // message, and a control still announcing "Required" under a message about
  // something else is telling a screen-reader user a field is empty when they
  // have already filled it.
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((value) => {
    guardedRef.current = null;
    setMissing(NO_MISSING_FIELDS);
    setErrorState(value);
  }, []);

  const run = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      return;
    }
    const cfg = cfgRef.current;
    const blocked = missingRequiredFields(cfg.required);
    if (blocked.length > 0) {
      // Before the in-flight flag and before ``setSubmitting``: a refused submit
      // never flickers a busy button, and a repeat press re-sets the identical
      // string, which React bails out of rather than re-rendering.
      const flagged: ReadonlySet<string> = new Set(blocked);
      guardedRef.current = flagged;
      setMissing(flagged);
      setErrorState(requiredFieldMessage(blocked));
      return;
    }
    guardedRef.current = null;
    setMissing(NO_MISSING_FIELDS);
    inFlightRef.current = true;
    setErrorState(null);
    setSubmitting(true);
    try {
      await cfg.fn();
    } catch (err: unknown) {
      // BUG-FRONTEND-INFRA-016: formatApiError maps timeouts and backend codes to user copy.
      setErrorState(authErrorMessage(err, cfg));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  useRetractOnEdit(required, guardedRef, setMissing, setErrorState);

  return { submitting, error, setError, run, missing };
}
