import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { describe, afterAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';
import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, setTokenGetter } from '@/api';
import { MIN_TOKEN_LENGTH } from '@/features/Auth/resetToken';

/**
 * The password-recovery journey: a locked-out account asks for a reset, reads
 * the email that arrives, follows the link a browser can actually open, sets a
 * new password, and logs in with it.
 *
 * This is the journey the outage came through. Reset mail went to a production
 * log for one reason and carried nothing but an `adepthood://` deep link for
 * another; `POST /auth/password-reset/request` answered 202 through both, every
 * backend suite stayed green, and both symptoms were found by a locked-out
 * external tester rather than by the suite. A green half-suite is what this
 * spec exists to stop being sufficient.
 *
 * Which is why the token under assertion is taken from the `https://` link and
 * from nowhere else. Reading it out of the deep link, or out of a JSON field,
 * would leave this spec green on the exact body that locked that tester out.
 * The origin it is anchored on is `APP_BASE_URL` as the lane configured it, so
 * a body that hardcoded some other host fails here too: the point of that
 * variable is that nothing inside a running server can derive its own public
 * origin, and the one header that claims to is chosen by whoever sent the
 * request.
 *
 * The email itself is real. The lane boots the server with
 * `EMAIL_BACKEND=capture`, a `services.email` adapter that appends every
 * rendered message verbatim to a file -- the one seam that lets a lane speaking
 * HTTP read a token that exists nowhere but a rendered body. Nothing on the
 * request path is stubbed, mocked or rebound to reach it: the adapter is
 * ordinary configuration, selected the way `console` and `smtp` are, and it
 * refuses to be built at all when `ENV` names production (asserted in
 * `backend/tests/services/test_email_capture.py` and, through the app's own
 * startup, in `backend/tests/test_email_startup_config.py`).
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const NEW_PASSWORD = 'a lantern left in the window'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

/** The two actions the email offers, as the paths its links carry. */
const RESET_PATH = '/reset-password?token=';
const CANCEL_PATH = '/cancel-reset?token=';

/** The custom scheme an installed native build registers, offered alongside. */
const DEEP_LINK_SCHEME = 'adepthood://';
const HTTPS_SCHEME = 'https://';

const RESET_SUBJECT = 'Reset your Adepthood password';
const CHANGE_SUBJECT = 'Your Adepthood password was changed';

const email = `e2e-recovery-${randomUUID()}${EMAIL_DOMAIN}`;

/** One message as the capture backend wrote it: the rendered email, verbatim. */
interface CapturedEmail {
  to: string;
  subject: string;
  body: string;
  html: string | null;
}

let cachedLane: { captureFile: string; webBaseUrl: string } | null = null;

/** The capture file this run owns, and the origin its links were built from. */
function lane(): { captureFile: string; webBaseUrl: string } {
  if (cachedLane === null) {
    const state = readLaneState();
    if (state === null) {
      throw new Error(
        'the e2e lane wrote no state file, so this journey has no captured mail to read. ' +
          'Run the lane through "npm run test:e2e".',
      );
    }
    cachedLane = { captureFile: state.emailCaptureFile, webBaseUrl: state.webBaseUrl };
  }
  return cachedLane;
}

/** Every message the server has rendered so far, oldest first. */
function capturedEmails(): CapturedEmail[] {
  const { captureFile } = lane();
  if (!existsSync(captureFile)) return [];
  return readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedEmail);
}

/** The messages addressed to this journey's account, in the order they were sent. */
function mailbox(): CapturedEmail[] {
  return capturedEmails().filter((message) => message.to === email);
}

/** The newest message to this account carrying `subject`, or a loud failure. */
function latest(subject: string): CapturedEmail {
  const matching = mailbox().filter((message) => message.subject === subject);
  const message = matching.at(-1);
  if (message === undefined) {
    throw new Error(
      `no email titled "${subject}" was delivered to ${email}; the mailbox holds ` +
        `[${mailbox()
          .map((held) => held.subject)
          .join(', ')}]`,
    );
  }
  return message;
}

/**
 * The token `prefix` introduces, read to the end of its line.
 *
 * Throwing rather than returning null is the whole assertion: `prefix` is
 * always a link this email is required to carry, so an absent one is a body a
 * recipient cannot act on, which is the delivered-but-useless email the journey
 * is here to catch.
 */
function tokenAfter(body: string, prefix: string): string {
  const start = body.indexOf(prefix);
  if (start === -1) {
    throw new Error(
      `the delivered email carries no "${prefix}" link, so this is a body its ` +
        `recipient cannot act on. Delivered:\n${body}`,
    );
  }
  const token = body.slice(start + prefix.length).split(/\s/u)[0] ?? '';
  if (token.length === 0) {
    throw new Error(`the "${prefix}" link in the delivered email carries an empty token`);
  }
  return token;
}

/** The reset token as a browser would recover it: out of the https link. */
function browserResetToken(message: CapturedEmail): string {
  const { webBaseUrl } = lane();
  return tokenAfter(message.body, `${webBaseUrl}${RESET_PATH}`);
}

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('password recovery against a live server', () => {
  let resetToken = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers the account that is about to lock itself out', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);
    // Nothing is mailed on signup, so the mailbox has to be empty here or the
    // assertions below would be reading somebody else's message.
    expect(mailbox()).toEqual([]);
  });

  it('answers the request with the anti-enumeration sentence and mails a link', async () => {
    const accepted = await auth.requestPasswordReset({ email });

    // The 202 body says nothing about whether the address is registered, and
    // that is the contract: it is also what made the outage invisible, so the
    // response is asserted and then disbelieved.
    expect(accepted.message).toContain('If an account exists');

    const delivered = latest(RESET_SUBJECT);
    expect(delivered.to).toBe(email);
    expect(delivered.html).not.toBeNull();
  });

  it('carries a link a browser can follow, built from the configured origin', () => {
    const { webBaseUrl } = lane();
    const delivered = latest(RESET_SUBJECT);

    // The half of the outage no test could have caught. A body offering only
    // the custom scheme is a link every real recipient's browser refuses, and
    // the web build is the only client that ships -- so the token this journey
    // goes on to use is read out of the https link and out of nothing else.
    expect(webBaseUrl.startsWith(HTTPS_SCHEME)).toBe(true);
    resetToken = browserResetToken(delivered);

    expect(delivered.body).toContain(`${webBaseUrl}${RESET_PATH}${resetToken}`);
    expect(delivered.body).toContain(`${webBaseUrl}${CANCEL_PATH}${resetToken}`);
    // The native scheme stays offered beside it: an installed build registers
    // it, and fixing web by dropping it would break the platform this flow was
    // written for. Same token in both, or one of the two links is a decoy.
    expect(delivered.body).toContain(`${DEEP_LINK_SCHEME}reset-password?token=${resetToken}`);
    // The token the reset screen would refuse is a token the email should never
    // have carried; this is that screen's own guard, applied to the mail.
    expect(resetToken.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
  });

  it('trades the emailed token for a new password and a live session', async () => {
    const response = await auth.confirmPasswordReset({
      token: resetToken,
      new_password: NEW_PASSWORD,
    });

    expect(response.user_id).toBeGreaterThan(0);
    expect(response.timezone).toBe(TIMEZONE);
  });

  it('lets the account back in with the password the email recovered', async () => {
    const response = await auth.login({ email, password: NEW_PASSWORD });

    expect(response.user_id).toBeGreaterThan(0);
  });

  it('has genuinely retired the password the account was locked out of', async () => {
    const failure = await rejection(auth.login({ email, password: PASSWORD }));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_UNAUTHORIZED);
    expect((failure as ApiError).detail).toBe('invalid_credentials');
  });

  it('tells the account out of band that its password moved', () => {
    const notice = latest(CHANGE_SUBJECT);

    expect(notice.to).toBe(email);
    // The whole point of this one is that it carries no link to act on: it is
    // how a legitimate user learns of a takeover they did not perform.
    expect(notice.body).not.toContain(RESET_PATH);
  });

  it('spends a reset token once, so the emailed link cannot be replayed', async () => {
    const failure = await rejection(
      auth.confirmPasswordReset({ token: resetToken, new_password: PASSWORD }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as ApiError).detail).toBe('invalid_or_expired_token');
  });

  it('kills a live token when the reader says it was not them', async () => {
    const { webBaseUrl } = lane();
    await auth.requestPasswordReset({ email });
    const unwanted = tokenAfter(latest(RESET_SUBJECT).body, `${webBaseUrl}${CANCEL_PATH}`);
    expect(unwanted).not.toBe(resetToken);

    // Possession of the token is the only auth this arm has, which is what lets
    // it be a link in an email -- so it is presented exactly as the mail did.
    await auth.cancelPasswordReset({ token: unwanted });

    const failure = await rejection(
      auth.confirmPasswordReset({ token: unwanted, new_password: PASSWORD }),
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_BAD_REQUEST);
    expect((failure as ApiError).detail).toBe('invalid_or_expired_token');
  });

  it('leaves the account on the password the recovery set', async () => {
    const response = await auth.login({ email, password: NEW_PASSWORD });

    expect(response.user_id).toBeGreaterThan(0);
  });
});
