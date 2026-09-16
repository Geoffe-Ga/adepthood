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
 * Retract a guard message once the user addresses the field it named.
 *
 * Keyed on which fields are *currently* blank, so editing an offending field
 * clears the banner and editing anything else leaves it alone, and gated on
 * ``guardedRef`` so it can only ever retract a message the guard itself wrote.
 */
function useRetractOnEdit(
  required: readonly RequiredField[],
  guardedRef: RefObject<boolean>,
  setMissing: Dispatch<SetStateAction<ReadonlySet<string>>>,
  setError: Dispatch<SetStateAction<string | null>>,
): void {
  const signature = required
    .map((field) => (field.submitted.length === 0 ? field.label : ''))
    .join('|');
  useEffect(() => {
    if (!guardedRef.current) return;
    guardedRef.current = false;
    setMissing(NO_MISSING_FIELDS);
    setError(null);
  }, [signature, guardedRef, setMissing, setError]);
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
  // True only while the banner holds a message this guard wrote, so the
  // retraction below can never swallow a server error or a screen's own copy.
  const guardedRef = useRef(false);

  // A caller writing the banner itself -- ``useSignupForm``'s password verdict,
  // ``ResetPasswordScreen``'s pair check -- takes the banner back from the
  // guard, so editing an unrelated field can no longer retract their message.
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((value) => {
    guardedRef.current = false;
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
      guardedRef.current = true;
      setMissing(new Set(blocked));
      setErrorState(requiredFieldMessage(blocked));
      return;
    }
    guardedRef.current = false;
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
