import {
  isAvailableAsync,
  signInAsync,
  AppleAuthenticationScope,
  type AppleAuthenticationFullName,
} from 'expo-apple-authentication';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { useSocialFlowController, type SocialAuthView } from './socialFlow';

import { useAuth } from '@/context/AuthContext';

/** Copy for failures with no backend code of their own (a dead Apple sheet). */
const APPLE_FALLBACK = "We couldn't finish that Apple sign-in. Try again in a moment.";

/** The coded rejection Apple raises when the user backs out of the sheet. */
const USER_CANCELED_CODE = 'ERR_REQUEST_CANCELED';

/**
 * The name is asked for because Apple will never offer it again, and the email
 * because the ladder needs an address the provider has vouched for. Both arrive
 * only on the very first authorization.
 */
const REQUESTED_SCOPES = [AppleAuthenticationScope.FULL_NAME, AppleAuthenticationScope.EMAIL];

/**
 * What one Apple authorization is worth to us: the token the backend verifies,
 * and the one-shot name that must survive as far as the request which creates
 * the account.
 */
interface AppleCredential {
  idToken: string;
  fullName?: string;
}

/** Public shape of the flow, as {@link useAppleAuth} hands it to the UI. */
export interface AppleAuthState extends SocialAuthView {
  signIn: () => void;
  submitLicenseKey: (_key: string) => void;
}

/**
 * Apple hands the name over in parts, any of which may be absent or blank.
 * Given name first, family name second, one space between whatever survives —
 * and nothing at all when nothing does, because an empty string would write a
 * blank display name over the column's honest ``NULL``.
 */
function joinFullName(fullName: AppleAuthenticationFullName | null): string | undefined {
  const parts = [fullName?.givenName, fullName?.familyName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Ask Apple to authorize us. Returns ``null`` when the sheet came back without
 * an identity token: there is nothing to exchange, and no reason to spend a
 * round trip finding that out.
 *
 * Absent and blank are the same answer. A whitespace-only token is a dead
 * sheet dressed as a credential — not something to ask the server to judge —
 * so both spellings take the identical fallback path.
 */
async function requestAppleCredential(): Promise<AppleCredential | null> {
  const credential = await signInAsync({ requestedScopes: REQUESTED_SCOPES });
  const idToken = credential.identityToken;
  if (idToken === null || idToken.trim() === '') return null;
  return { idToken, fullName: joinFullName(credential.fullName) };
}

/**
 * A closed sheet is the user's decision, not a failure — it gets silence. Read
 * the code defensively: a rejection is only conventionally an object.
 */
function isUserCancellation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return 'code' in err && err.code === USER_CANCELED_CODE;
}

/**
 * "Continue with Apple": authorize, trade the identity token for a session, and
 * fall into the inline license step when the server asks for a key.
 *
 * The credential — token *and* name — is held by the shared flow for the life
 * of the exchange and re-sent on the license retry, because that retry is the
 * request that creates the row and Apple will not offer the name a second time.
 * The sheet therefore opens exactly once per attempt.
 */
export function useAppleAuth(): AppleAuthState {
  const { loginWithApple } = useAuth();

  const send = useCallback(
    (credential: AppleCredential, licenseKey: string | undefined) =>
      loginWithApple(credential.idToken, credential.fullName, licenseKey),
    [loginWithApple],
  );

  const { view, isBusy, beginPrompt, exchange, release, submitLicenseKey } =
    useSocialFlowController<AppleCredential>(send, APPLE_FALLBACK);

  const signIn = useCallback(() => {
    if (isBusy()) return;
    beginPrompt();
    void requestAppleCredential().then(
      (credential) => {
        if (credential === null) release(APPLE_FALLBACK);
        else exchange(credential);
      },
      (err: unknown) => release(isUserCancellation(err) ? null : APPLE_FALLBACK),
    );
  }, [beginPrompt, exchange, isBusy, release]);

  return { ...view, signIn, submitLicenseKey };
}

/**
 * Whether this device can offer Sign in with Apple (iOS 13+ only).
 *
 * ``Platform.OS`` is read inside the effect rather than at module scope: the
 * platform is a run-time fact, and freezing it at import time would make the
 * off-iOS branch unobservable. A rejected probe — an older OS, or a build with
 * no native module — simply leaves the option hidden, which is the honest
 * outcome and not something to log about.
 */
export function useAppleSignInAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    let live = true;
    void isAvailableAsync().then(
      (supported) => {
        if (live) setAvailable(supported);
      },
      () => {
        /* unsupported platform or missing native module: stay hidden, stay quiet */
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return available;
}
