import { exchangeCodeAsync } from 'expo-auth-session';
import { discovery, useAuthRequest } from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { googleClientIds } from './oauthConfig';
import { useSocialFlowController, type SocialAuthView } from './socialFlow';

import { useAuth } from '@/context/AuthContext';

// Completes the redirect leg on web, where the auth session finishes in a
// popup that has to hand its result back to this window. Must run at module
// scope, before any component mounts.
WebBrowser.maybeCompleteAuthSession();

/** ``ResponseType.IdToken``, spelled out rather than importing the library's enum. */
const ID_TOKEN_RESPONSE_TYPE = 'id_token';

/**
 * Web finishes the flow with the ID token straight from the redirect; native
 * uses the default code flow and redirects back with a one-time code. That
 * single fork is all ``useIdTokenAuthRequest`` adds over ``useAuthRequest``,
 * so we keep one provider entry point.
 *
 * Native's code is traded here rather than by the provider: the provider's
 * own auto-exchange has no ``.catch`` (57.0.13), so a refused or failed trade
 * never delivers a response and the button would stay busy forever (#1989).
 */
const GOOGLE_REQUEST_CONFIG = {
  iosClientId: googleClientIds.ios,
  androidClientId: googleClientIds.android,
  webClientId: googleClientIds.web,
  responseType: Platform.OS === 'web' ? ID_TOKEN_RESPONSE_TYPE : undefined,
  shouldAutoExchangeCode: false,
};

/** Copy for failures with no backend code of their own (a dead browser sheet). */
const GOOGLE_FALLBACK = "We couldn't finish that Google sign-in. Try again in a moment.";

/**
 * Copy for a refusal Google reports on the redirect itself — a misconfigured
 * client, a server hiccup, a state mismatch. Waiting may not help, so it offers
 * the email path too, and it never echoes the provider's code or description.
 */
const GOOGLE_PROVIDER_ERROR =
  "Google couldn't complete that sign-in. Try again, or continue with email instead.";

/**
 * Google's code when the user presses Cancel or Deny on its own screen: their
 * choice, not a failure, so it stays as silent as a closed sheet. Mirrors
 * ``useAppleAuth``'s ``USER_CANCELED_CODE``.
 */
const GOOGLE_USER_DECLINED_CODE = 'access_denied';

type GoogleAuthRequest = ReturnType<typeof useAuthRequest>[0];
type GoogleAuthResponse = ReturnType<typeof useAuthRequest>[1];

/**
 * The redirect-carrying member of the library union. ``'error'`` and
 * ``'success'`` share it, so it is selected by its fields, not its ``type``.
 */
type GoogleRedirectResult = Extract<NonNullable<GoogleAuthResponse>, { params: unknown }>;

/**
 * The copy for an ``error`` result, or ``null`` when the user declined. A
 * missing code is surfaced, never silenced.
 */
function providerErrorCopy(result: GoogleRedirectResult): string | null {
  const code = result.error?.code ?? result.params.error;
  return code === GOOGLE_USER_DECLINED_CODE ? null : GOOGLE_PROVIDER_ERROR;
}

/** Public shape of the flow, as {@link useGoogleAuth} hands it to the UI. */
export interface GoogleAuthState extends SocialAuthView {
  signIn: () => void;
  submitLicenseKey: (_key: string) => void;
}

/**
 * Trade native's one-time code for an ID token and hand it on. Every way the
 * trade can end releases or exchanges — a refusal or a dead network shows the
 * provider copy, a trade with no token the fallback — so the guard is never
 * left latched. Superseded or unmounted outcomes are dropped by the flow
 * controller's own epoch and mount guards.
 */
function tradeCode(
  request: GoogleAuthRequest,
  code: string,
  exchange: (_idToken: string) => void,
  release: (_message: string | null) => void,
): void {
  if (request === null) {
    release(GOOGLE_FALLBACK);
    return;
  }
  const config = {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    code,
    extraParams: { code_verifier: request.codeVerifier ?? '' },
  };
  exchangeCodeAsync(config, discovery).then(
    ({ idToken }) => {
      if (idToken) exchange(idToken);
      else release(GOOGLE_FALLBACK);
    },
    () => release(GOOGLE_PROVIDER_ERROR),
  );
}

/**
 * Start an exchange for every *new* provider response.
 *
 * Deliberately not gated by the in-flight guard: a fresh Google response
 * supersedes whatever was running, and the epoch check inside the exchange —
 * not this effect — is what keeps the superseded attempt from writing state.
 */
function useResponseBridge(
  request: GoogleAuthRequest,
  response: GoogleAuthResponse,
  exchange: (_idToken: string) => void,
  release: (_message: string | null) => void,
): void {
  // Read through a ref so a re-created request never re-runs the effect and
  // spends the single-use code a second time.
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!response) return;
    if (response.type === 'error') {
      release(providerErrorCopy(response));
      return;
    }
    // cancel / dismiss / locked: a closed sheet is not a failure — drop the
    // guard and say nothing.
    if (response.type !== 'success') {
      release(null);
      return;
    }
    const { id_token: idToken, code } = response.params;
    if (idToken !== undefined) exchange(idToken);
    else if (code !== undefined) tradeCode(requestRef.current, code, exchange, release);
    // A "success" carrying neither means the client is misconfigured. The user
    // cannot fix that, but they should still be told the attempt is over.
    else release(GOOGLE_FALLBACK);
  }, [response, exchange, release]);
}

/**
 * "Continue with Google": prompt for an ID token, trade it for a session, and
 * fall into the inline license step when the server asks for a key.
 *
 * The only module in the app that talks to ``expo-auth-session``. Everything
 * that is not Google-shaped — the held credential, the epoch and mount guards,
 * the license retry — lives in the shared flow controller.
 */
export function useGoogleAuth(): GoogleAuthState {
  const { loginWithGoogle } = useAuth();
  const [request, response, promptAsync] = useAuthRequest(GOOGLE_REQUEST_CONFIG);
  const { view, isBusy, beginPrompt, exchange, release, submitLicenseKey } =
    useSocialFlowController<string>(loginWithGoogle, GOOGLE_FALLBACK);

  useResponseBridge(request, response, exchange, release);

  const signIn = useCallback(() => {
    if (isBusy()) return;
    beginPrompt();
    void promptAsync().catch(() => release(GOOGLE_FALLBACK));
  }, [beginPrompt, isBusy, promptAsync, release]);

  return { ...view, signIn, submitLicenseKey };
}
