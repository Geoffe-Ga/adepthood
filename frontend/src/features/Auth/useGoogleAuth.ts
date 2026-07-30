import { useAuthRequest } from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';

import { googleClientIds } from './oauthConfig';
import { useSocialFlowController, type SocialAuthView } from './socialFlow';

import { useAuth } from '@/context/AuthContext';

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

/** Copy for failures with no backend code of their own (a dead browser sheet). */
const GOOGLE_FALLBACK = "We couldn't finish that Google sign-in. Try again in a moment.";

type GoogleAuthResponse = ReturnType<typeof useAuthRequest>[1];

/** Public shape of the flow, as {@link useGoogleAuth} hands it to the UI. */
export interface GoogleAuthState extends SocialAuthView {
  signIn: () => void;
  submitLicenseKey: (_key: string) => void;
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
 * The only module in the app that talks to ``expo-auth-session``. Everything
 * that is not Google-shaped — the held credential, the epoch and mount guards,
 * the license retry — lives in the shared flow controller.
 */
export function useGoogleAuth(): GoogleAuthState {
  const { loginWithGoogle } = useAuth();
  const [, response, promptAsync] = useAuthRequest(GOOGLE_REQUEST_CONFIG);
  const { view, isBusy, beginPrompt, exchange, release, submitLicenseKey } =
    useSocialFlowController<string>(loginWithGoogle, GOOGLE_FALLBACK);

  useResponseBridge(response, exchange, release);

  const signIn = useCallback(() => {
    if (isBusy()) return;
    beginPrompt();
    void promptAsync().catch(() => release(GOOGLE_FALLBACK));
  }, [beginPrompt, isBusy, promptAsync, release]);

  return { ...view, signIn, submitLicenseKey };
}
