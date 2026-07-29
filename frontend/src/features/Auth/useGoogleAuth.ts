import { useAuthRequest } from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { Platform } from 'react-native';

import { validateLicenseKey } from './licenseKeyValidation';
import { googleClientIds } from './oauthConfig';

import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import type { GoogleSignInResult } from '@/context/AuthContext';

// Completes the redirect leg on web, where the auth session finishes in a
// popup that has to hand its result back to this window. Must run at module
// scope, before any component mounts.
WebBrowser.maybeCompleteAuthSession();

/** ``ResponseType.IdToken``, spelled out so the ESM-only root package stays unimported. */
const ID_TOKEN_RESPONSE_TYPE = 'id_token';

/**
 * Web finishes the flow with the ID token straight from the redirect; native
 * uses the default code flow, which the provider auto-exchanges into
 * ``params.id_token``. That single fork is all ``useIdTokenAuthRequest`` adds
 * over ``useAuthRequest``, so we keep one provider entry point.
 */
const GOOGLE_REQUEST_CONFIG = {
  iosClientId: googleClientIds.ios,
  androidClientId: googleClientIds.android,
  webClientId: googleClientIds.web,
  responseType: Platform.OS === 'web' ? ID_TOKEN_RESPONSE_TYPE : undefined,
};

/** The single, deliberately vague refusal the backend returns for every non-cryptographic failure. */
const NEEDS_LICENSE_REFUSAL = { status: 409, detail: 'needs_license' };

/**
 * The one refusal copy. Resolved through ``formatApiError`` so it stays tied to
 * the shared error-code map: both 409s — the first refusal and a refused key —
 * must render byte-identical copy, because any difference between them would
 * tell an attacker which of the collapsed causes actually fired.
 */
const NEEDS_LICENSE_MESSAGE = formatApiError(NEEDS_LICENSE_REFUSAL);

/** Copy for failures with no backend code of their own (a dead browser sheet). */
const GOOGLE_FALLBACK = "We couldn't finish that Google sign-in. Try again in a moment.";

type GoogleAuthResponse = ReturnType<typeof useAuthRequest>[1];

/** What the buttons render. ``needsLicense`` means: show the license step in place. */
interface GoogleAuthView {
  status: 'idle' | 'needsLicense';
  error: string | null;
  submitting: boolean;
}

/** Public shape of the flow, as {@link useGoogleAuth} hands it to the UI. */
export interface GoogleAuthState extends GoogleAuthView {
  signIn: () => void;
  submitLicenseKey: (_key: string) => void;
}

const IDLE_VIEW: GoogleAuthView = { status: 'idle', error: null, submitting: false };
const PROMPTING_VIEW: GoogleAuthView = { status: 'idle', error: null, submitting: true };

/**
 * Everything the flow must read or write synchronously, outside React state.
 *
 * ``idToken`` is the credential Google just issued, held here — never in state,
 * AsyncStorage, or navigation params — so it lives and dies with this component
 * instance. ``attempt`` is the epoch that lets only the newest exchange write
 * state; ``busy`` guards a second prompt; ``mounted`` drops a late settle.
 */
interface GoogleFlow {
  idToken: string | null;
  attempt: number;
  busy: boolean;
  mounted: boolean;
}

function viewFor(result: GoogleSignInResult): GoogleAuthView {
  if (result.kind === 'success') return IDLE_VIEW;
  if (result.kind === 'needs_license') {
    return { status: 'needsLicense', error: NEEDS_LICENSE_MESSAGE, submitting: false };
  }
  return {
    status: 'idle',
    error: formatApiError(result.error, { fallback: GOOGLE_FALLBACK }),
    submitting: false,
  };
}

/**
 * Apply an exchange outcome: keep the ID token only while the license step is
 * still live — a success or any failure discards it, so no path can replay a
 * token the server has already judged.
 */
function settle(flow: GoogleFlow, idToken: string, result: GoogleSignInResult): GoogleAuthView {
  const view = viewFor(result);
  flow.idToken = view.status === 'needsLicense' ? idToken : null;
  flow.busy = false;
  return view;
}

/**
 * Re-send the token we are already holding, with the key the user typed.
 * Validation runs first, so a key we can already tell is malformed costs no
 * round trip; with nothing pending the submit is a silent no-op.
 */
function submitKey(
  flow: GoogleFlow,
  key: string,
  exchange: (_idToken: string, _licenseKey: string) => void,
  setView: Dispatch<SetStateAction<GoogleAuthView>>,
): void {
  if (flow.busy) return;
  const invalid = validateLicenseKey(key);
  if (invalid !== null) {
    setView((prev) => ({ ...prev, error: invalid }));
    return;
  }
  if (flow.idToken !== null) exchange(flow.idToken, key);
}

/** Per-instance mutable flow state, wiped on unmount so nothing outlives the screen. */
function useGoogleFlow(): MutableRefObject<GoogleFlow> {
  const flow = useRef<GoogleFlow>({ idToken: null, attempt: 0, busy: false, mounted: true });
  useEffect(() => {
    // The record itself is created once and never replaced, so the cleanup can
    // safely close over it rather than re-reading the ref.
    const state = flow.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
      state.idToken = null;
    };
  }, []);
  return flow;
}

/**
 * Start an exchange for every *new* provider response.
 *
 * Deliberately not gated by the in-flight guard: a fresh Google response
 * supersedes whatever was running, and the epoch check inside the exchange —
 * not this effect — is what keeps the superseded attempt from writing state.
 */
function useResponseBridge(
  response: GoogleAuthResponse,
  exchange: (_idToken: string) => void,
  release: (_message: string | null) => void,
): void {
  useEffect(() => {
    if (!response) return;
    // A closed sheet is not a failure — drop the guard and say nothing.
    if (response.type !== 'success') {
      release(null);
      return;
    }
    const idToken = response.params.id_token;
    // A "success" carrying no token means the client is misconfigured. The user
    // cannot fix that, but they should still be told the attempt is over.
    if (idToken === undefined) release(GOOGLE_FALLBACK);
    else exchange(idToken);
  }, [response, exchange, release]);
}

/**
 * "Continue with Google": prompt for an ID token, trade it for a session, and
 * fall into the inline license step when the server asks for a key.
 *
 * The only module in the app that talks to ``expo-auth-session``.
 */
export function useGoogleAuth(): GoogleAuthState {
  const { loginWithGoogle } = useAuth();
  const [, response, promptAsync] = useAuthRequest(GOOGLE_REQUEST_CONFIG);
  const [view, setView] = useState<GoogleAuthView>(IDLE_VIEW);
  const flow = useGoogleFlow();

  const exchange = useCallback(
    (idToken: string, licenseKey?: string) => {
      flow.current.attempt += 1;
      const ticket = flow.current.attempt;
      flow.current.idToken = idToken;
      flow.current.busy = true;
      setView((prev) => ({ ...prev, error: null, submitting: true }));
      void loginWithGoogle(idToken, licenseKey).then((result) => {
        if (!flow.current.mounted || flow.current.attempt !== ticket) return;
        setView(settle(flow.current, idToken, result));
      });
    },
    [flow, loginWithGoogle],
  );

  const release = useCallback(
    (message: string | null) => {
      flow.current.busy = false;
      setView((prev) => ({ ...prev, error: message, submitting: false }));
    },
    [flow],
  );

  useResponseBridge(response, exchange, release);

  const signIn = useCallback(() => {
    if (flow.current.busy) return;
    flow.current.idToken = null;
    flow.current.busy = true;
    setView(PROMPTING_VIEW);
    void promptAsync().catch(() => release(GOOGLE_FALLBACK));
  }, [flow, promptAsync, release]);

  const submitLicenseKey = useCallback(
    (key: string) => submitKey(flow.current, key, exchange, setView),
    [exchange, flow],
  );

  return { ...view, signIn, submitLicenseKey };
}
