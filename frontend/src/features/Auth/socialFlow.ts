import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { validateLicenseKey } from './licenseKeyValidation';

import { formatApiError } from '@/api/errorMessages';
import type { SocialSignInResult } from '@/context/AuthContext';

/** The single, deliberately vague refusal the backend returns for every non-cryptographic failure. */
const NEEDS_LICENSE_REFUSAL = { status: 409, detail: 'needs_license' };

/**
 * The one refusal copy, shared by every provider. Resolved through
 * ``formatApiError`` so it stays tied to the shared error-code map: both 409s —
 * the first refusal and a refused key — must render byte-identical copy,
 * because any difference between them would tell an attacker which of the
 * collapsed causes actually fired. Nothing here may be specialised per
 * provider for the same reason.
 */
const NEEDS_LICENSE_MESSAGE = formatApiError(NEEDS_LICENSE_REFUSAL);

/** What the buttons render. ``needsLicense`` means: show the license step in place. */
export interface SocialAuthView {
  status: 'idle' | 'needsLicense';
  error: string | null;
  submitting: boolean;
}

const IDLE_VIEW: SocialAuthView = { status: 'idle', error: null, submitting: false };
const PROMPTING_VIEW: SocialAuthView = { status: 'idle', error: null, submitting: true };

/**
 * Everything a flow must read or write synchronously, outside React state.
 *
 * ``credential`` is whatever the provider just issued — an ID token for Google,
 * an ID token plus Apple's one-shot name for Apple — held here and nowhere
 * else. Never React state, never AsyncStorage, and never navigation params,
 * which serialize into persisted navigation state: a replayable credential must
 * not survive the component instance that obtained it. ``attempt`` is the epoch
 * that lets only the newest exchange write state; ``busy`` guards a second
 * prompt; ``mounted`` drops a late settle.
 */
interface SocialFlow<C> {
  credential: C | null;
  attempt: number;
  busy: boolean;
  mounted: boolean;
}

/** Translate an exchange outcome into the view, using the provider's own fallback copy. */
function viewFor(result: SocialSignInResult, fallbackCopy: string): SocialAuthView {
  if (result.kind === 'success') return IDLE_VIEW;
  if (result.kind === 'needs_license') {
    return { status: 'needsLicense', error: NEEDS_LICENSE_MESSAGE, submitting: false };
  }
  return {
    status: 'idle',
    error: formatApiError(result.error, { fallback: fallbackCopy }),
    submitting: false,
  };
}

/**
 * Apply an exchange outcome: keep the credential only while the license step is
 * still live — a success or any failure discards it, so no path can replay a
 * credential the server has already judged.
 */
function settle<C>(
  flow: SocialFlow<C>,
  credential: C,
  result: SocialSignInResult,
  fallbackCopy: string,
): SocialAuthView {
  const view = viewFor(result, fallbackCopy);
  flow.credential = view.status === 'needsLicense' ? credential : null;
  flow.busy = false;
  return view;
}

/**
 * Re-send the credential we are already holding, with the key the user typed.
 * Validation runs first, so a key we can already tell is malformed costs no
 * round trip; with nothing pending the submit is a silent no-op.
 */
function submitKey<C>(
  flow: SocialFlow<C>,
  key: string,
  exchange: (_credential: C, _licenseKey: string) => void,
  setView: Dispatch<SetStateAction<SocialAuthView>>,
): void {
  if (flow.busy) return;
  const invalid = validateLicenseKey(key);
  if (invalid !== null) {
    setView((prev) => ({ ...prev, error: invalid }));
    return;
  }
  if (flow.credential !== null) exchange(flow.credential, key);
}

/** Per-instance mutable flow state, wiped on unmount so nothing outlives the screen. */
function useSocialFlow<C>(): MutableRefObject<SocialFlow<C>> {
  const flow = useRef<SocialFlow<C>>({ credential: null, attempt: 0, busy: false, mounted: true });
  useEffect(() => {
    // The record itself is created once and never replaced, so the cleanup can
    // safely close over it rather than re-reading the ref.
    const state = flow.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
      state.credential = null;
    };
  }, []);
  return flow;
}

/** The provider-neutral half of a social sign-in hook. */
export interface SocialFlowController<C> {
  view: SocialAuthView;
  /** True while a prompt or an exchange is already running. */
  isBusy: () => boolean;
  /** Arm the in-flight guard and show the "connecting" view before prompting. */
  beginPrompt: () => void;
  /** Trade the credential for a session; pass a license key on the retry leg. */
  exchange: (_credential: C, _licenseKey?: string) => void;
  /** Drop the guard and show ``message`` — ``null`` for an outcome the user chose. */
  release: (_message: string | null) => void;
  submitLicenseKey: (_key: string) => void;
}

/**
 * The whole flow every provider shares: view state, the credential ref, the
 * exchange with its epoch and mount guards, and the inline license retry.
 *
 * ``send`` is the only provider-specific piece — it forwards the held
 * credential (and the key, when there is one) to the matching AuthContext
 * action.
 */
export function useSocialFlowController<C>(
  send: (_credential: C, _licenseKey: string | undefined) => Promise<SocialSignInResult>,
  fallbackCopy: string,
): SocialFlowController<C> {
  const [view, setView] = useState<SocialAuthView>(IDLE_VIEW);
  const flow = useSocialFlow<C>();

  const exchange = useCallback(
    (credential: C, licenseKey?: string) => {
      flow.current.attempt += 1;
      const ticket = flow.current.attempt;
      flow.current.credential = credential;
      flow.current.busy = true;
      setView((prev) => ({ ...prev, error: null, submitting: true }));
      void send(credential, licenseKey).then((result) => {
        if (!flow.current.mounted || flow.current.attempt !== ticket) return;
        setView(settle(flow.current, credential, result, fallbackCopy));
      });
    },
    [fallbackCopy, flow, send],
  );

  const release = useCallback(
    (message: string | null) => {
      flow.current.busy = false;
      if (!flow.current.mounted) return;
      setView((prev) => ({ ...prev, error: message, submitting: false }));
    },
    [flow],
  );

  const beginPrompt = useCallback(() => {
    flow.current.credential = null;
    flow.current.busy = true;
    setView(PROMPTING_VIEW);
  }, [flow]);

  const isBusy = useCallback(() => flow.current.busy, [flow]);

  const submitLicenseKey = useCallback(
    (key: string) => submitKey(flow.current, key, exchange, setView),
    [exchange, flow],
  );

  return { view, isBusy, beginPrompt, exchange, release, submitLicenseKey };
}
