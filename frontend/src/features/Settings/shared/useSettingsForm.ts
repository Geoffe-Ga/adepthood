import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Shared form-state scaffolding for Settings screens.
 *
 * Both the API-key and time-zone screens are the same small form: a text
 * ``draft``, a ``submitting`` flag, and a mutually-exclusive ``error``/``status``
 * banner pair. ``useSettingsFormState`` holds that state and ``useSettingsSubmit``
 * wraps the validate → submit → try/catch/finally state-machine so neither
 * screen has to re-derive it.
 */

export interface SettingsFormState {
  draft: string;
  submitting: boolean;
  error: string | null;
  status: string | null;
  setDraft: Dispatch<SetStateAction<string>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
}

export function useSettingsFormState(initialDraft: string): SettingsFormState {
  const [draft, setDraft] = useState<string>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  return { draft, submitting, error, status, setDraft, setSubmitting, setError, setStatus };
}

type SettingsSubmitState = Pick<SettingsFormState, 'setSubmitting' | 'setError' | 'setStatus'>;

export interface SettingsSubmitConfig {
  /** Return an error message to block the submit, or ``null`` to proceed. */
  validate: () => string | null;
  /** The async work run inside the try block (including success side effects). */
  perform: () => Promise<void>;
  /** Map a thrown value to the error message shown to the user. */
  onError: (_err: unknown) => string;
}

export function useSettingsSubmit(
  state: SettingsSubmitState,
  { validate, perform, onError }: SettingsSubmitConfig,
): () => Promise<void> {
  const { setSubmitting, setError, setStatus } = state;
  return useCallback(async () => {
    setStatus(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await perform();
    } catch (err) {
      setError(onError(err));
    } finally {
      setSubmitting(false);
    }
  }, [validate, perform, onError, setSubmitting, setError, setStatus]);
}
