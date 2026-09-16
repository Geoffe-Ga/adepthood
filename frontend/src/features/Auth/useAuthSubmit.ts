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

/** What the guard is currently claiming about the form. */
interface GuardClaim {
  /** Labels it flagged whose controls still advertise themselves; null when none. */
  readonly flagged: ReadonlySet<string> | null;
  /** Whether the words in the banner are the guard's own. */
  readonly ownsBanner: boolean;
}

/** Shared because it is never mutated in place -- every transition replaces it. */
const NO_CLAIM: GuardClaim = Object.freeze({ flagged: null, ownsBanner: false });

/**
 * Withdraw exactly as much of the guard's verdict as the user has earned.
 *
 * Two rules, and the code says both of them.
 *
 * **Only satisfaction retracts, and only what it satisfies.** The trigger is a
 * flagged field now holding a value -- not a change of any kind to any field,
 * and not a change to some other field. Filling one of two blanks is partial
 * progress: the flag on that control goes, the flag on the other stays, and the
 * banner re-derives to name what is *still* missing. Clearing a filled field
 * leaves the form more invalid, so nothing is withdrawn at all.
 *
 * **The flags outlive the banner.** A flag says "this control is empty and will
 * block the next submit", which stays true under a server's answer or a screen's
 * own verdict -- so the flags keep narrowing underneath either. What it may not
 * do is outlive the emptiness it describes. The banner is different: it is
 * rewritten here only while the claim's ``ownsBanner`` says the words in it are
 * the guard's, so no retraction can ever speak over someone else's message.
 */
function useRetractOnEdit(
  required: readonly RequiredField[],
  claimRef: RefObject<GuardClaim>,
  setMissing: Dispatch<SetStateAction<ReadonlySet<string>>>,
  setError: Dispatch<SetStateAction<string | null>>,
): void {
  const { flagged } = claimRef.current;
  const stillMissing =
    flagged === null
      ? []
      : required
          .filter((field) => flagged.has(field.label) && field.submitted.length === 0)
          .map((field) => field.label);
  const satisfiedSome = flagged !== null && stillMissing.length < flagged.size;
  const stillMissingKey = stillMissing.join('|');

  // The list itself travels by ref, the way ``cfgRef`` carries the config: the
  // key is what decides whether this render's list differs from the last one,
  // and the ref hands the effect the array that key was derived from.
  const pendingRef = useRef<readonly string[]>(stillMissing);
  pendingRef.current = stillMissing;

  useEffect(() => {
    if (!satisfiedSome) return;
    const pending = pendingRef.current;
    const { ownsBanner } = claimRef.current;
    const remaining = pending.length === 0 ? null : new Set(pending);
    claimRef.current = { flagged: remaining, ownsBanner: ownsBanner && remaining !== null };
    setMissing(remaining ?? NO_MISSING_FIELDS);
    if (ownsBanner) {
      // ``requiredFieldMessage`` answers null for an empty list, which is the
      // same "no banner" the screens already render for a null error.
      setError(requiredFieldMessage(pending));
    }
  }, [satisfiedSome, stillMissingKey, claimRef, setMissing, setError]);
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
  const claimRef = useRef<GuardClaim>(NO_CLAIM);

  // A caller writing the banner itself -- ``useSignupForm``'s password verdict,
  // ``ResetPasswordScreen``'s pair check -- takes the banner, and only the
  // banner. The per-field flags stay: they describe controls that are still
  // empty and will still refuse the next submit, which is true no matter whose
  // message is on screen. They narrow on their own as the user fills them.
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((value) => {
    claimRef.current = { ...claimRef.current, ownsBanner: false };
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
      claimRef.current = { flagged, ownsBanner: true };
      setMissing(flagged);
      setErrorState(requiredFieldMessage(blocked));
      return;
    }
    claimRef.current = NO_CLAIM;
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

  useRetractOnEdit(required, claimRef, setMissing, setErrorState);

  return { submitting, error, setError, run, missing };
}
