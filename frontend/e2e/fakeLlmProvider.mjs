import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

/**
 * A provider that refuses, on the wire, the way real providers refuse.
 *
 * The lane's server runs the stub BotMason provider, which cannot fail: it has
 * no account, no key and no network, so the one condition this journey is about
 * -- the balance behind the key that pays for a reflection is spent -- was
 * unreachable from any spec. Injecting the typed error instead would have
 * proved the routing and assumed the classification, which is the exact hole
 * that let the bug ship (#2479): the whole retry/classification suite had only
 * ever seen hand-built exceptions and never how a provider expresses this.
 *
 * So this process speaks the two providers' real HTTP APIs and answers with
 * their real refusal bodies. Adepthood's server reaches it through the SDKs'
 * own `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` -- no patched client, no
 * injected transport -- so `openai.RateLimitError` and
 * `anthropic.BadRequestError` are built by the SDKs out of these bytes, and the
 * classification under test is the production one.
 *
 * Which answer a request gets is decided by the API key it presents, because
 * that is what decides it in reality: an exhausted balance is a property of the
 * account behind a key, not of a request. The three keys are minted per run by
 * `globalSetup` and handed to this process by environment; a key it does not
 * recognise gets each provider's own `401`, so a misconfigured lane fails
 * loudly instead of quietly serving something that looks like success.
 *
 * The refusal bodies are copies of the fixtures in
 * `backend/tests/services/test_botmason_credit_exhausted.py`, which captured
 * them from real accounts. If they ever drift out of what the classifier
 * recognises, this journey goes red -- which is the point of having it.
 *
 * `GET /__lane/attempts` reports how many requests reached each provider
 * surface, by shape and never by key. That is what lets a spec assert the press
 * actually reached the provider (a wallet that did not move because nothing was
 * ever charged is not the claim), and what makes "a genuine rate limit is still
 * retried" observable: the same status, a different code, three attempts
 * instead of one.
 */

const READY_PREFIX = 'FAKE_LLM_READY port=';
const LOOPBACK_HOST = '127.0.0.1';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Where each key this fake knows about is read from, and what it means. */
const KEY_FILES = {
  spentOpenai: 'FAKE_LLM_SPENT_OPENAI_KEY_FILE',
  throttledOpenai: 'FAKE_LLM_THROTTLED_OPENAI_KEY_FILE',
  spentAnthropic: 'FAKE_LLM_SPENT_ANTHROPIC_KEY_FILE',
};

function requiredFile(name) {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is unset`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

const keys = Object.fromEntries(
  Object.entries(KEY_FILES).map(([role, variable]) => [role, requiredFile(variable)]),
);

/** Requests that reached each surface, by outcome. Never keyed by the key. */
const attempts = {
  openaiSpent: 0,
  openaiThrottled: 0,
  openaiUnrecognised: 0,
  anthropicSpent: 0,
  anthropicUnrecognised: 0,
};

/** OpenAI's answer for an account whose quota is spent: a 429 with a code. */
const OPENAI_QUOTA_BODY = {
  error: {
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    param: null,
    code: 'insufficient_quota',
  },
};

/**
 * OpenAI's answer for a genuine rate limit: the same status, a different code.
 * Telling a rate-limited caller to go top up an account that is not empty is
 * the failure mode the narrow carve-out exists to avoid, so the lane drives
 * this one too.
 */
const OPENAI_RATE_LIMIT_BODY = {
  error: {
    message: 'Rate limit reached for gpt-4o-mini in organization on requests per min.',
    type: 'requests',
    param: null,
    code: 'rate_limit_exceeded',
  },
};

/** Anthropic publishes no code for this, so the prose of a 400 is the signal. */
const ANTHROPIC_CREDIT_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'Your credit balance is too low to access the Anthropic API. ' +
      'Please go to Plans & Billing to upgrade or purchase credits.',
  },
  request_id: 'req_011CeRey6WW3GcfU1D4hjUXs',
};

const OPENAI_UNKNOWN_KEY_BODY = {
  error: {
    message: 'Incorrect API key provided.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
};

const ANTHROPIC_UNKNOWN_KEY_BODY = {
  type: 'error',
  error: { type: 'authentication_error', message: 'invalid x-api-key' },
};

function send(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** The bearer token an OpenAI client presents, or an empty string. */
function bearerKey(request) {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function chatCompletions(request, response) {
  const key = bearerKey(request);
  if (key === keys.spentOpenai) {
    attempts.openaiSpent += 1;
    send(response, HTTP_TOO_MANY_REQUESTS, OPENAI_QUOTA_BODY);
    return;
  }
  if (key === keys.throttledOpenai) {
    attempts.openaiThrottled += 1;
    send(response, HTTP_TOO_MANY_REQUESTS, OPENAI_RATE_LIMIT_BODY);
    return;
  }
  attempts.openaiUnrecognised += 1;
  send(response, HTTP_UNAUTHORIZED, OPENAI_UNKNOWN_KEY_BODY);
}

function messages(request, response) {
  const key = request.headers['x-api-key'] ?? '';
  if (key === keys.spentAnthropic) {
    attempts.anthropicSpent += 1;
    send(response, HTTP_BAD_REQUEST, ANTHROPIC_CREDIT_BODY);
    return;
  }
  attempts.anthropicUnrecognised += 1;
  send(response, HTTP_UNAUTHORIZED, ANTHROPIC_UNKNOWN_KEY_BODY);
}

const server = createServer((request, response) => {
  // Drained rather than parsed: what the prompt says is the server's business,
  // and a body left unread stalls the SDK's next request on a kept-alive socket.
  request.resume();
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'GET' && pathname === '/__lane/attempts') {
    send(response, HTTP_OK, attempts);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/chat/completions') {
    chatCompletions(request, response);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/messages') {
    messages(request, response);
    return;
  }
  send(response, HTTP_NOT_FOUND, { error: { message: `no route for ${pathname}` } });
});

server.listen(0, LOOPBACK_HOST, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake LLM provider did not bind');
  }
  process.stdout.write(`${READY_PREFIX}${address.port}\n`);
});

// Kept-alive sockets are the normal state here: each SDK client the server
// builds leaves a pooled connection behind, and `close()` alone waits for every
// one of them to go idle. Dropping them first is what makes teardown's SIGTERM
// land inside its grace period instead of escalating to SIGKILL ten seconds on.
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
