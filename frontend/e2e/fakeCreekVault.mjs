import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

/**
 * A Creek Vault that takes documents and journal replicas on the real wire.
 *
 * The lane's accounts have never had a vault to seed into, so the one outcome
 * `seed.upload-document` is about -- a document accepted by the vault, with a
 * ref to show for it -- was unreachable from any spec. A spec written anyway
 * would have asserted `vault_unavailable` forever and registered as coverage
 * while proving its own outcome never happens.
 *
 * So this process speaks Creek's published `/v1` surface and adepthood reaches
 * it through its own production `CREEK_VAULT_URL` / `CREEK_VAULT_API_KEY`
 * settings. Nothing is patched, injected or rebound: the server builds its real
 * `HttpCreekVaultClient`, negotiates the real capability document, and posts a
 * real `UploadRequest` over a real socket. That is the point -- a stubbed client
 * would prove the routing and assume the protocol, and the protocol is the half
 * only a live server can exercise.
 *
 * **It advertises five capabilities and no more.** The upload journey needs
 * `capabilities` and `upload`; the withdrawal journey needs `journal-upsert`,
 * `journal-withdraw`, and `voice-drafts`. The deployment binding still keeps
 * every other lane account on Adepthood's local fallback, so only the two specs
 * that deliberately log in as the bound owner can send traffic here.
 *
 * Shapes come from the vendored bundle at `backend/tests/fixtures/creek_v1/`:
 * capability, upload, journal upsert/withdrawal, Voice Draft upsert/deletion,
 * and error envelopes. The refusals are real refusals -- a missing
 * contract-version header is a 409, an unrecognised bearer is a 401, a field
 * adepthood invented is a 400 -- so a mis-wired lane fails loudly instead of
 * quietly serving something that looks like success.
 *
 * `GET /__lane/uploads` reports what actually arrived: every `/v1` request in
 * order, and the fragments the ledger holds. Requests are recorded by shape and
 * by a digest of the bytes, never by the bytes -- which is what lets a spec
 * prove both halves of the privacy guarantee at once. An intimate document adds
 * no request and its digest never appears; and because the personal one's does,
 * "nothing arrived" cannot be satisfied by a fake nobody ever reached.
 */

const READY_PREFIX = 'FAKE_VAULT_READY port=';
const LOOPBACK_HOST = '127.0.0.1';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_INCOMPATIBLE_VERSION = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The production client makes one call plus two bounded idempotent retries. */
const ADEPTHOOD_DELETE_ATTEMPTS = 3;

/** The contract this vault serves, and the minor a caller must declare to use it. */
const CONTRACT_VERSION = '0.16.0';
const CONTRACT_MINOR = '0.16';
const CONTRACT_HEADER = 'x-creek-contract-version';
const CEILING_HEADER = 'x-creek-tier-ceiling';

/**
 * Everything this vault says it can do.
 *
 * Five names, and the shortness is the safety property rather than an economy:
 * adepthood consults this list before every capability call, so a name added
 * here is a new class of traffic aimed at this process from journeys that have
 * nothing to do with seeding.
 */
const ADVERTISED_CAPABILITIES = [
  'capabilities',
  'upload',
  'journal-upsert',
  'journal-withdraw',
  'voice-drafts',
];

/** The only two tiers `/v1` can express; anything else is not a tier, it is a leak. */
const ADMITTED_TIERS = ['open', 'personal'];

/** Exactly the fields `UploadRequest` publishes; the shape forbids any other. */
const UPLOAD_REQUEST_FIELDS = ['filename', 'content_base64', 'external_id', 'timestamp', 'tier'];
const JOURNAL_REQUEST_FIELDS = ['content', 'timestamp', 'tier'];
const VOICE_DRAFT_REQUEST_FIELDS = ['content', 'tier'];

const ONTOLOGY_VERSION = 'aptitude-wavelength/2026-05-23';

/** Every `/v1` request served, in arrival order, by shape and digest only. */
const received = [];

/** Fragments this vault holds, keyed by the consumer's own stable id. */
const fragments = new Map();

/** One deterministic transport fault, armed only by the withdrawal journey. */
let voiceDraftDeleteFailuresRemaining = 0;

function requiredFile(name) {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is unset`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

const apiKey = requiredFile('FAKE_VAULT_API_KEY_FILE');

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Creek-Contract-Version': CONTRACT_MINOR,
  });
  response.end(JSON.stringify(payload));
}

function refuse(response, status, code) {
  send(response, status, { code, message: code, request_id: `req-lane-${received.length}` });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A content-free fingerprint of the bytes, so a spec can trace them without holding them. */
function digestOf(contentBase64) {
  return createHash('sha256').update(String(contentBase64), 'utf8').digest('hex');
}

function capabilities(response) {
  send(response, HTTP_OK, {
    capabilities: ADVERTISED_CAPABILITIES,
    contract_minor: CONTRACT_MINOR,
    contract_version: CONTRACT_VERSION,
    ontology_version: ONTOLOGY_VERSION,
    status: 'ok',
    supported_contract_minors: [CONTRACT_MINOR],
    tier_model: { ceilings: ADMITTED_TIERS, default: 'open', intimate_never_egresses: true },
    vault: { available: true },
  });
}

/** Whether the body is exactly the published shape, and nothing adepthood invented. */
function malformed(body, fields) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return true;
  const keys = Object.keys(body).sort();
  if (keys.join() !== [...fields].sort().join()) return true;
  return !ADMITTED_TIERS.includes(body.tier);
}

/** Record the write and say what it did: a new fragment, an edit, or nothing at all. */
function store(kind, externalId, digest) {
  const key = `${kind}:${externalId}`;
  const held = fragments.get(key);
  if (held === undefined) {
    const fresh = {
      kind,
      externalId,
      fragmentId: `frag-lane-${fragments.size + 1}`,
      digest,
      writes: 1,
    };
    fragments.set(key, fresh);
    return { fragment: fresh, action: 'created' };
  }
  held.writes += 1;
  if (held.digest === digest) return { fragment: held, action: 'unchanged' };
  held.digest = digest;
  return { fragment: held, action: 'updated' };
}

async function uploads(request, response) {
  if (request.headers[CONTRACT_HEADER] !== CONTRACT_MINOR) {
    refuse(response, HTTP_INCOMPATIBLE_VERSION, 'incompatible_version');
    return;
  }
  const body = await readJson(request);
  if (
    malformed(body, UPLOAD_REQUEST_FIELDS) ||
    typeof body.external_id !== 'string' ||
    body.external_id === '' ||
    typeof body.content_base64 !== 'string' ||
    body.content_base64 === ''
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  const digest = digestOf(body.content_base64);
  const { fragment, action } = store('upload', body.external_id, digest);
  received.push({
    method: 'POST',
    path: '/v1/uploads',
    externalId: body.external_id,
    tier: body.tier,
    ceiling: request.headers[CEILING_HEADER] ?? null,
    digest,
    action,
  });
  send(response, HTTP_OK, {
    action,
    affected_fragment_ids: [fragment.fragmentId],
    external_id: body.external_id,
    fragment_id: fragment.fragmentId,
    source_type: 'markdown',
    status: 'ok',
    tier_ceiling: body.tier,
  });
}

function hasContract(request, response) {
  if (request.headers[CONTRACT_HEADER] === CONTRACT_MINOR) return true;
  request.resume();
  refuse(response, HTTP_INCOMPATIBLE_VERSION, 'incompatible_version');
  return false;
}

/** Store the journal body addressed by Adepthood's stable local entry id. */
async function journalUpsert(request, response, externalId) {
  if (!hasContract(request, response)) return;
  const body = await readJson(request);
  if (
    malformed(body, JOURNAL_REQUEST_FIELDS) ||
    typeof body.content !== 'string' ||
    body.content.trim() === ''
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  const digest = createHash('sha256').update(body.content, 'utf8').digest('hex');
  const { fragment, action } = store('journal', externalId, digest);
  received.push({
    method: 'PUT',
    path: `/v1/journal-entries/${externalId}`,
    externalId,
    tier: body.tier,
    ceiling: request.headers[CEILING_HEADER] ?? null,
    digest,
    action,
  });
  send(response, HTTP_OK, {
    action,
    external_id: externalId,
    fragment_id: fragment.fragmentId,
    status: 'ok',
    tier: body.tier,
    tier_ceiling: request.headers[CEILING_HEADER] ?? null,
  });
}

/** Delete a journal replica by identity and reveal nothing about prior existence. */
function journalWithdraw(request, response, externalId) {
  if (!hasContract(request, response)) return;
  request.resume();
  fragments.delete(`journal:${externalId}`);
  received.push({
    method: 'DELETE',
    path: `/v1/journal-entries/${externalId}`,
    externalId,
    tier: null,
    ceiling: request.headers[CEILING_HEADER] ?? null,
    action: 'withdrawn',
  });
  send(response, HTTP_OK, {
    action: 'withdrawn',
    status: 'ok',
    tier_ceiling: request.headers[CEILING_HEADER] ?? null,
  });
}

/** Store a zero-weight AI draft under the opaque id Adepthood supplies. */
async function voiceDraftUpsert(request, response, externalId) {
  if (!hasContract(request, response)) return;
  const body = await readJson(request);
  if (
    malformed(body, VOICE_DRAFT_REQUEST_FIELDS) ||
    typeof body.content !== 'string' ||
    body.content.trim() === ''
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  const digest = createHash('sha256').update(body.content, 'utf8').digest('hex');
  const { fragment, action } = store('voice-draft', externalId, digest);
  received.push({
    method: 'PUT',
    path: `/v1/voice-drafts/${externalId}`,
    externalId,
    tier: body.tier,
    ceiling: request.headers[CEILING_HEADER] ?? null,
    digest,
    action,
  });
  send(response, HTTP_OK, {
    action,
    attribution: { author: 'ai', author_slug: 'ai-as-user', voice_weight: 0 },
    external_id: externalId,
    fragment_id: fragment.fragmentId,
    status: 'ok',
    tier: body.tier,
    tier_ceiling: request.headers[CEILING_HEADER] ?? null,
  });
}

/** Retract a Voice Draft, with one test-controlled outage before confirmation. */
function voiceDraftDelete(request, response, externalId) {
  if (!hasContract(request, response)) return;
  request.resume();
  received.push({
    method: 'DELETE',
    path: `/v1/voice-drafts/${externalId}`,
    externalId,
    tier: null,
    ceiling: request.headers[CEILING_HEADER] ?? null,
    action: voiceDraftDeleteFailuresRemaining > 0 ? 'failed' : 'deleted',
  });
  if (voiceDraftDeleteFailuresRemaining > 0) {
    voiceDraftDeleteFailuresRemaining -= 1;
    refuse(response, HTTP_SERVICE_UNAVAILABLE, 'service_unavailable');
    return;
  }
  fragments.delete(`voice-draft:${externalId}`);
  send(response, HTTP_OK, {
    action: 'deleted',
    external_id: externalId,
    status: 'ok',
    tier_ceiling: request.headers[CEILING_HEADER] ?? null,
  });
}

/** Serve one authorised `/v1` call, or say this vault has no such route. */
async function capability(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/v1/capabilities') {
    received.push({ method: 'GET', path: pathname, externalId: null, tier: null, digest: null });
    capabilities(response);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/uploads') {
    await uploads(request, response);
    return;
  }
  const journalMatch = /^\/v1\/journal-entries\/([^/]+)$/u.exec(pathname);
  if (journalMatch?.[1] !== undefined && request.method === 'PUT') {
    await journalUpsert(request, response, decodeURIComponent(journalMatch[1]));
    return;
  }
  if (journalMatch?.[1] !== undefined && request.method === 'DELETE') {
    journalWithdraw(request, response, decodeURIComponent(journalMatch[1]));
    return;
  }
  const draftMatch = /^\/v1\/voice-drafts\/([^/]+)$/u.exec(pathname);
  if (draftMatch?.[1] !== undefined && request.method === 'PUT') {
    await voiceDraftUpsert(request, response, decodeURIComponent(draftMatch[1]));
    return;
  }
  if (draftMatch?.[1] !== undefined && request.method === 'DELETE') {
    voiceDraftDelete(request, response, decodeURIComponent(draftMatch[1]));
    return;
  }
  received.push({ method: request.method, path: pathname, externalId: null, tier: null });
  refuse(response, HTTP_NOT_FOUND, 'invalid_request');
}

const server = createServer((request, response) => {
  void (async () => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      request.resume();
      refuse(response, HTTP_UNAUTHORIZED, 'invalid_request');
      return;
    }
    // Read before the ledger is served: the read must not appear in what it
    // reports, or a spec comparing two snapshots would see its own question.
    if (request.method === 'GET' && pathname === '/__lane/uploads') {
      request.resume();
      send(response, HTTP_OK, { received, fragments: [...fragments.values()] });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/fail-next-voice-draft-delete') {
      request.resume();
      voiceDraftDeleteFailuresRemaining = ADEPTHOOD_DELETE_ATTEMPTS;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    await capability(request, response, pathname);
  })().catch(() => refuse(response, HTTP_BAD_REQUEST, 'invalid_request'));
});

server.listen(0, LOOPBACK_HOST, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake Creek Vault did not bind');
  }
  process.stdout.write(`${READY_PREFIX}${address.port}\n`);
});

// The vault adapter borrows from a process-wide httpx pool, so kept-alive
// sockets are the normal state here and `close()` alone would wait for every one
// of them to go idle. Dropping them first is what makes teardown's SIGTERM land
// inside its grace period instead of escalating to SIGKILL ten seconds on.
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
