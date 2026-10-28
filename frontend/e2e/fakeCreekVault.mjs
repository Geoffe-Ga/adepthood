import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

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
 * **It advertises eight capabilities by default.** The upload journey needs
 * `capabilities` and `upload`; the withdrawal journey needs `journal-upsert`,
 * `journal-withdraw`, `voice-drafts`, `reflections` and `letters` -- the bound
 * owner is vault-bound (#3061), so its resonance pass and its first letter are
 * answered by this vault or not at all (#3203), and a vault that never
 * advertised either is a refunded 503, never a quiet hand-off to the app's
 * model provider. The deployment binding still keeps
 * every other lane account on Adepthood's local fallback, so only the two specs
 * that deliberately log in as the bound owner can send traffic here.
 * Classification is enabled only by its own journey through an authenticated
 * control route; its opaque job handles and counts never retain a provider key.
 *
 * Shapes come from the vendored bundle at `backend/tests/fixtures/creek_v1/`:
 * capability, upload, journal upsert/withdrawal, Voice Draft upsert/deletion,
 * reflection, letter, and error envelopes. The refusals are real refusals -- a missing
 * contract-version header is a 409, an unrecognised bearer is a 401, a field
 * adepthood invented is a 400 -- so a mis-wired lane fails loudly instead of
 * quietly serving something that looks like success.
 *
 * `POST /__lane/escalate-next-letter` arms one care escalation: the next letter
 * request is answered with Creek's own published `letters` care-escalation cell
 * (read verbatim from the vendored bundle, never written here) and stores no
 * Voice Draft, as Creek's acute-distress guard answers instead of writing.
 * `GET /__lane/letter-care-escalation` hands a journey that same cell, so it can
 * prove none of Creek's prose reached the writer without reading backend files.
 *
 * `GET /v1/agent-activity` (contract 0.22, #3535) answers Creek's published
 * `AgentActivityResponse` from an audit log this process keeps. The lane has no
 * `/mcp` surface, so no agent can call this vault; a journey stands in for the
 * calls one would have made with `POST /__lane/record-agent-call` (a consumer
 * stamp, a tool name and an outcome -- the four audited fields, `at` stamped
 * here) and can arm one off-schema answer with `POST /__lane/leak-next-activity`,
 * which adds an argument summary and prose to the next answer exactly as a
 * vault breaking the content-free promise would. Neither is ever recorded in
 * the ledger: they are reads of the audit, not traffic adepthood sent.
 *
 * `POST /__lane/fail-upload` arms one refusal for the upload whose content
 * digest it names: that `POST /v1/uploads` is answered 503 and stores nothing,
 * and is recorded with `action: 'failed'`, so the folder-import journey can
 * fail one document of several and prove its retry keeps the same identity.
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
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_INCOMPATIBLE_VERSION = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The production client makes one call plus two bounded idempotent retries. */
const ADEPTHOOD_DELETE_ATTEMPTS = 3;

/** The contract this vault serves, and the minor a caller must declare to use it. */
const CONTRACT_VERSION = '0.22.0';
const CONTRACT_MINOR = '0.22';
const READING_MINOR = '0.25';
/** The minor whose failed job names why (Creek contract 0.26, Creek-Vault#1877). */
const FAILURE_CODE_MINOR = '0.26';
let readingsAdvertised = false;
const CONTRACT_HEADER = 'x-creek-contract-version';
const CEILING_HEADER = 'x-creek-tier-ceiling';

/**
 * Everything this vault says it can do.
 *
 * Eight default names; the separate classification journey opts into pipeline:
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
  'reflections',
  'letters',
  'agent-activity',
];

/** The only two tiers `/v1` can express; anything else is not a tier, it is a leak. */
const ADMITTED_TIERS = ['open', 'personal'];

/** Exactly the fields `UploadRequest` publishes; the shape forbids any other. */
const UPLOAD_REQUEST_FIELDS = ['filename', 'content_base64', 'external_id', 'timestamp', 'tier'];
const JOURNAL_REQUEST_FIELDS = ['content', 'timestamp', 'tier'];
const VOICE_DRAFT_REQUEST_FIELDS = ['content', 'tier'];
/** `ReflectionRequest` as adepthood sends it: inline content and a note budget, nothing else. */
const REFLECTION_REQUEST_FIELDS = ['content', 'max_notes'];
/** What this vault says about the writer's words; a lane sentinel, never real advice. */
const LANE_REFLECTION_NOTE = 'The lane vault reads this line back to you.';
/** `LetterRequest` as adepthood sends it: the entry, the note, and the tier -- no title. */
const LETTER_REQUEST_FIELDS = ['content', 'note', 'tier'];
const LETTER_NOTE_FIELDS = ['anchor_text', 'kind', 'note'];
/** The letter this vault writes; a lane sentinel, so no writer prose is ever held here. */
const LANE_LETTER = 'The lane vault wrote this letter back to you.';
/**
 * Creek's published `letters` care-escalation cell, verbatim from the vendored
 * bundle: the care guard's 200 answer *instead of* a letter. Adepthood drops
 * its prose at the adapter, so a journey can prove none of it is shown.
 */
const LETTER_CARE_ESCALATION = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../backend/tests/fixtures/creek_v1/examples/letters/care-escalation.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);
/** Creek's content-free placeholder title for a Voice Draft stored without one. */
const VOICE_DRAFT_TITLE = 'Voice draft';

const ONTOLOGY_VERSION = 'aptitude-wavelength/2026-05-23';

/**
 * The audit log `GET /v1/agent-activity` projects, oldest first, as Creek's
 * chain is: each entry exactly `{consumer, tool, at, outcome}`.
 */
const auditLog = [];
/** One answer a journey armed to carry more than the four published fields. */
let activityLeakArmed = false;
/** The published bounds on `limit` (`AgentActivityQuery`), and its default. */
const ACTIVITY_MIN_LIMIT = 1;
const ACTIVITY_MAX_LIMIT = 200;
const ACTIVITY_DEFAULT_LIMIT = 50;
/** The only outcomes the closed enum names. */
const ACTIVITY_OUTCOMES = ['admitted', 'refused'];
/** What an off-schema answer smuggles: the shape of an argument summary. */
const LEAKED_PROSE = 'The lane vault leaked this sentence.';
const HTTP_UNPROCESSABLE = 422;

/** Every `/v1` request served, in arrival order, by shape and digest only. */
const received = [];

/** Fragments this vault holds, keyed by the consumer's own stable id. */
const fragments = new Map();

/**
 * Content digests whose next upload this vault refuses once, armed only by the
 * folder-import journey (#3557) so one named document fails while its siblings
 * land. A digest, never the bytes: the journey computes it from its own fixture.
 */
const uploadFailuresArmed = new Set();

/** One deterministic transport fault, armed only by the withdrawal journey. */
let voiceDraftDeleteFailuresRemaining = 0;
/** Held until a journey releases it, so retained copies can be observed directly. */
let journalWithdrawalsHeld = false;
/** An authenticated journey can model a vault that lacks letters. */
let lettersHeld = false;
/** One letter request a journey armed to meet the vault's care guard instead. */
let letterEscalationArmed = false;
/**
 * A journey can model a managed vault (Creek-Vault ADR-0015, #3437): one that lists
 * the vendors whose writer key it will spend in `request_key_providers`. Off by
 * default, so every other journey sees a self-connected vault, which (since contract
 * 0.18) lists none and is never sent a key.
 */
let requestKeysAdvertised = false;
/** Classification traffic is enabled only by its own journey, never by default. */
let pipelineAdvertised = false;
/** Keep the job non-terminal until its journey has observed the journal reply. */
let pipelineJobsHeld = false;
/** Opaque handles and counts only; no request key survives the admitting call. */
const pipelineJobs = new Map();
/**
 * A journey can model a vendor that refuses the writer's key (#3595): this vault
 * then lists 0.26, and a keyed classification admitted meanwhile ends `failed`
 * -- with `failure_code` only for a poll that declares 0.26, as Creek answers.
 */
let requestKeysRejected = false;
/** Handles whose keyed pass the vendor refused. Opaque ids only. */
const rejectedJobs = new Set();
/**
 * A journey can model Creek's managed rules floor (#3577, Creek-Vault#1982): an
 * `llm` classification admitted meanwhile finishes `complete: true` with
 * `method: 'rules'`, which the server must read as a sort not yet finished.
 */
let classifyWithRules = false;
/** The vendors a managed Creek vault spends a writer's own key for. */
const REQUEST_KEY_PROVIDERS = ['anthropic', 'openai'];
const PROVIDER_HEADER = 'x-creek-provider';
const PROVIDER_KEY_HEADER = 'x-creek-provider-key';
/**
 * Every request that carried a writer's key, by route, vendor and a digest of
 * the key -- never the key itself -- so a journey can prove which call the key
 * rode, and that it was exactly the writer's, without this process holding it.
 */
const keyed = [];

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
    capabilities: ADVERTISED_CAPABILITIES.filter((name) => !lettersHeld || name !== 'letters')
      .concat(pipelineAdvertised ? ['pipeline'] : [])
      .concat(readingsAdvertised ? ['reading-recommendations'] : []),
    contract_minor: readingsAdvertised ? READING_MINOR : CONTRACT_MINOR,
    contract_version: readingsAdvertised ? '0.25.0' : CONTRACT_VERSION,
    ...(readingsAdvertised ? { keyless_inference: true } : {}),
    ontology_version: ONTOLOGY_VERSION,
    request_key_providers: requestKeysAdvertised ? REQUEST_KEY_PROVIDERS : [],
    status: 'ok',
    supported_contract_minors: [CONTRACT_MINOR]
      .concat(readingsAdvertised ? [READING_MINOR] : [])
      .concat(requestKeysRejected ? [FAILURE_CODE_MINOR] : []),
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
  if (uploadFailuresArmed.delete(digest)) {
    // Recorded as an attempt that stored nothing, so a journey can prove the
    // retry that follows addressed this same external id.
    received.push({
      method: 'POST',
      path: '/v1/uploads',
      externalId: body.external_id,
      tier: body.tier,
      ceiling: request.headers[CEILING_HEADER] ?? null,
      digest,
      action: 'failed',
    });
    refuse(response, HTTP_SERVICE_UNAVAILABLE, 'temporarily_unavailable');
    return;
  }
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
  if (journalWithdrawalsHeld) {
    received.push({
      method: 'DELETE',
      path: `/v1/journal-entries/${externalId}`,
      externalId,
      action: 'unconfirmed',
    });
    refuse(response, HTTP_SERVICE_UNAVAILABLE, 'temporarily_unavailable');
    return;
  }
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

/** Whether a letter request's note is exactly the published `LetterNote` shape. */
function malformedNote(note) {
  if (note === null || typeof note !== 'object' || Array.isArray(note)) return true;
  if (Object.keys(note).sort().join() !== LETTER_NOTE_FIELDS.join()) return true;
  return [note.anchor_text, note.note].some(
    (field) => typeof field !== 'string' || field.trim() === '',
  );
}

/**
 * Write a margin note's letter and keep it as a Voice Draft at the caller's id.
 *
 * First writer wins, as Creek's store does: a repeat at an id that already holds
 * a draft is `unchanged` and returns what is stored. The letter is this lane's
 * own sentinel, so the ledger still holds a digest of the entry and nothing of
 * its prose.
 */
async function writeLetter(request, response, externalId) {
  if (!hasContract(request, response)) return;
  const body = await readJson(request);
  const ceiling = request.headers[CEILING_HEADER] ?? null;
  if (
    malformed(body, LETTER_REQUEST_FIELDS) ||
    malformedNote(body.note) ||
    typeof body.content !== 'string' ||
    body.content.trim() === '' ||
    ceiling !== body.tier
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  if (letterEscalationArmed) {
    letterEscalationArmed = false;
    received.push({
      method: 'POST',
      path: `/v1/letters/${externalId}`,
      externalId,
      tier: body.tier,
      ceiling,
      digest: createHash('sha256').update(body.content, 'utf8').digest('hex'),
      action: 'escalated',
    });
    send(response, HTTP_OK, { ...LETTER_CARE_ESCALATION, tier_ceiling: ceiling });
    return;
  }
  const held = fragments.get(`voice-draft:${externalId}`);
  const { fragment, action } =
    held === undefined
      ? store('voice-draft', externalId, digestOf(LANE_LETTER))
      : { fragment: held, action: 'unchanged' };
  received.push({
    method: 'POST',
    path: `/v1/letters/${externalId}`,
    externalId,
    tier: body.tier,
    ceiling,
    digest: createHash('sha256').update(body.content, 'utf8').digest('hex'),
    action,
  });
  send(response, HTTP_OK, {
    action,
    attribution: { author: 'ai', author_slug: 'ai-as-user', voice_weight: 0 },
    external_id: externalId,
    fragment_id: fragment.fragmentId,
    letter: LANE_LETTER,
    status: 'ok',
    tier: body.tier,
    tier_ceiling: ceiling,
    title: VOICE_DRAFT_TITLE,
    // A re-read letter called no model, so it names no route (Creek's own cell).
    ...(action === 'unchanged' ? {} : { inference_source: answeringRoute(request) }),
  });
}

/**
 * The route a model-backed answer names in `inference_source` (contract 0.19):
 * `request_key:<vendor>` when this vault spent a writer key it advertises,
 * otherwise its own local model. Adepthood bills on this receipt (#3483).
 */
function answeringRoute(request) {
  const provider = request.headers[PROVIDER_HEADER];
  const keyed =
    requestKeysAdvertised &&
    REQUEST_KEY_PROVIDERS.includes(provider) &&
    typeof request.headers[PROVIDER_KEY_HEADER] === 'string';
  return keyed ? `request_key:${provider}` : 'local';
}

/**
 * The writer's own first sentence, verbatim, so the note anchors for real.
 *
 * A note whose quote is not in the body is dropped by adepthood's anchor check,
 * and a reflection with no surviving note is a zero-note pass -- so quoting the
 * body is what lets this vault produce the margin note the journey expands.
 */
function firstSentence(content) {
  const sentence = content.trim().split(/(?<=[.!?])\s/u)[0] ?? '';
  return sentence.replace(/[.!?]+$/u, '');
}

/** Answer a reflection with one note quoting the writer, recording only a digest. */
async function reflect(request, response) {
  if (!hasContract(request, response)) return;
  const body = await readJson(request);
  const keys = body !== null && typeof body === 'object' ? Object.keys(body).sort() : [];
  const ceiling = request.headers[CEILING_HEADER] ?? null;
  if (
    keys.join() !== [...REFLECTION_REQUEST_FIELDS].sort().join() ||
    typeof body.content !== 'string' ||
    body.content.trim() === '' ||
    !ADMITTED_TIERS.includes(ceiling)
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  received.push({
    method: 'POST',
    path: '/v1/reflections',
    externalId: null,
    tier: null,
    ceiling,
    digest: createHash('sha256').update(body.content, 'utf8').digest('hex'),
  });
  send(response, HTTP_OK, {
    essay: null,
    essay_grounded: false,
    inference_source: answeringRoute(request),
    notes: [{ kind: 'pattern', note: LANE_REFLECTION_NOTE, quote: firstSentence(body.content) }],
    related_eddies: [],
    related_praxis: [],
    routed_tier: ceiling,
    status: 'ok',
    tier_ceiling: ceiling,
  });
}

/** `limit` from a query admitting nothing else, or `null` when Creek would refuse it. */
function activityLimit(url) {
  const names = [...url.searchParams.keys()];
  if (names.some((name) => name !== 'limit') || names.length > 1) return null;
  const raw = url.searchParams.get('limit');
  if (raw === null) return ACTIVITY_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < ACTIVITY_MIN_LIMIT) return null;
  return Math.min(limit, ACTIVITY_MAX_LIMIT);
}

/** Creek's content-free projection of this vault's audit log, newest first. */
function agentActivity(request, response, url) {
  if (!hasContract(request, response)) return;
  request.resume();
  const limit = activityLimit(url);
  if (limit === null) {
    refuse(response, HTTP_UNPROCESSABLE, 'invalid_request');
    return;
  }
  const rows = auditLog.slice(-limit).reverse();
  const answer = { status: 'ok', tier_ceiling: 'open', skipped: 0, rows };
  if (activityLeakArmed) {
    activityLeakArmed = false;
    send(response, HTTP_OK, {
      ...answer,
      note: LEAKED_PROSE,
      rows: rows.map((row) => ({ ...row, args_summary: { topic: LEAKED_PROSE } })),
    });
    return;
  }
  send(response, HTTP_OK, answer);
}

/** Append one call to the audit log, as the vault's MCP adapter would have. */
async function recordAgentCall(request, response) {
  const body = await readJson(request);
  if (
    typeof body?.consumer !== 'string' ||
    typeof body.tool !== 'string' ||
    !ACTIVITY_OUTCOMES.includes(body.outcome)
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  const at = new Date();
  at.setMilliseconds(0);
  auditLog.push({
    consumer: body.consumer,
    tool: body.tool,
    at: at.toISOString().replace('.000Z', 'Z'),
    outcome: body.outcome,
  });
  send(response, HTTP_OK, { status: 'ok' });
}

/** The opt-in pipeline publishes only counts and a bounded inference source. */
async function pipelineCall(request, response, pathname) {
  if (!pipelineAdvertised) return false;
  const jobId = pathname.startsWith('/v1/jobs/') ? pathname.slice('/v1/jobs/'.length) : null;
  if (request.method === 'GET' && jobId !== null) {
    const declared = request.headers[CONTRACT_HEADER] ?? null;
    received.push({ method: 'GET', path: pathname, externalId: null, tier: null, declared });
    const result = pipelineJobs.get(jobId);
    if (result === undefined) refuse(response, HTTP_NOT_FOUND, 'invalid_request');
    else if (pipelineJobsHeld) {
      send(response, HTTP_OK, { status: 'ok', job_id: jobId, state: 'running' });
    } else if (rejectedJobs.has(jobId)) {
      send(response, HTTP_OK, {
        status: 'ok',
        job_id: jobId,
        state: 'failed',
        result: null,
        ...(declared === FAILURE_CODE_MINOR ? { failure_code: 'request_key_rejected' } : {}),
      });
    } else send(response, HTTP_OK, { status: 'ok', job_id: jobId, state: 'succeeded', result });
    return true;
  }
  if (request.method !== 'POST' || !['/v1/classifications', '/v1/links'].includes(pathname)) {
    return false;
  }
  const body = await readJson(request);
  const method = pathname === '/v1/classifications' ? 'llm' : 'temporal';
  if (
    body === null ||
    typeof body !== 'object' ||
    Object.keys(body).join() !== 'method' ||
    body.method !== method
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return true;
  }
  received.push({ method: 'POST', path: pathname, externalId: null, tier: null });
  if (method === 'temporal') {
    send(response, HTTP_OK, {
      status: 'ok',
      tier_ceiling: 'personal',
      method,
      fragment_count: 1,
      link_count: 1,
      largest_cluster_fragments: 1,
      clusters_split: 0,
      oversized_discarded: 0,
    });
    return true;
  }
  const handle = randomUUID();
  const answeredMethod = classifyWithRules ? 'rules' : method;
  if (requestKeysRejected && typeof request.headers[PROVIDER_KEY_HEADER] === 'string') {
    rejectedJobs.add(handle);
  }
  pipelineJobs.set(handle, {
    status: 'ok',
    tier_ceiling: 'personal',
    method: answeredMethod,
    total: 1,
    classified: 1,
    preserved_manual: 0,
    preserved_llm: 0,
    privacy_tiers_assigned: 0,
    retiered: 0,
    praxis_marked: 0,
    tags_extracted: 1,
    complete: true,
    inference_source: answeringRoute(request),
  });
  send(response, HTTP_ACCEPTED, { status: 'accepted', job_id: handle, state: 'queued' });
  return true;
}

/** Synthetic generation at the external boundary; identity and quotes still cross the real app. */
async function recommendReading(request, response) {
  if (!readingsAdvertised || request.headers[CONTRACT_HEADER] !== READING_MINOR) {
    refuse(response, HTTP_INCOMPATIBLE_VERSION, 'incompatible_version');
    return;
  }
  const body = await readJson(request);
  const source = body?.sources?.find((item) => item.content.includes('tension in my shoulders'));
  const reading = body?.readings?.[0];
  if (
    !reading ||
    !source ||
    !ADMITTED_TIERS.includes(source.tier) ||
    Object.keys(body).sort().join() !== 'catalog_version,readings,sources' ||
    Object.keys(reading).sort().join() !== 'content,content_id,title' ||
    Object.keys(source).sort().join() !== 'content,entry_id,tier' ||
    request.headers[CEILING_HEADER] !== 'personal' ||
    request.headers[PROVIDER_KEY_HEADER]
  ) {
    refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
    return;
  }
  received.push({
    method: 'POST',
    path: '/v1/reading-recommendations',
    tier: source.tier,
    externalId: null,
    digest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  });
  send(response, HTTP_OK, {
    status: 'ok',
    inference_source: 'local',
    recommendation: {
      content_id: reading.content_id,
      entry_id: source.entry_id,
      quote: 'tension in my shoulders',
      reason: 'You describe tension as a bodily sensation in your journal.',
      benefit: 'This reading offers a way to explore attention to physical sensations.',
    },
  });
}

/** Serve one authorised `/v1` call, or say this vault has no such route. */
async function capability(request, response, pathname) {
  if (request.method === 'POST' && pathname === '/v1/reading-recommendations') {
    await recommendReading(request, response);
    return;
  }
  if (await pipelineCall(request, response, pathname)) return;
  if (request.method === 'GET' && pathname === '/v1/capabilities') {
    received.push({ method: 'GET', path: pathname, externalId: null, tier: null, digest: null });
    capabilities(response);
    return;
  }
  if (request.method === 'GET' && pathname === '/v1/agent-activity') {
    agentActivity(request, response, new URL(request.url ?? '/', 'http://localhost'));
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/uploads') {
    await uploads(request, response);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/reflections') {
    await reflect(request, response);
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
  const letterMatch = /^\/v1\/letters\/([^/]+)$/u.exec(pathname);
  if (letterMatch?.[1] !== undefined && request.method === 'POST') {
    await writeLetter(request, response, decodeURIComponent(letterMatch[1]));
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
      send(response, HTTP_OK, { received, fragments: [...fragments.values()], keyed });
      return;
    }
    if (
      request.method === 'POST' &&
      (pathname === '/__lane/enable-pipeline' || pathname === '/__lane/disable-pipeline')
    ) {
      request.resume();
      pipelineAdvertised = pathname === '/__lane/enable-pipeline';
      pipelineJobsHeld = pipelineAdvertised;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/release-pipeline-jobs') {
      request.resume();
      pipelineJobsHeld = false;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (
      request.method === 'POST' &&
      (pathname === '/__lane/advertise-request-keys' ||
        pathname === '/__lane/withdraw-request-keys')
    ) {
      request.resume();
      requestKeysAdvertised = pathname === '/__lane/advertise-request-keys';
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (
      request.method === 'POST' &&
      ['/__lane/reject-request-keys', '/__lane/accept-request-keys'].includes(pathname)
    ) {
      request.resume();
      requestKeysRejected = pathname === '/__lane/reject-request-keys';
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (
      request.method === 'POST' &&
      ['/__lane/classify-with-rules', '/__lane/classify-with-llm'].includes(pathname)
    ) {
      request.resume();
      classifyWithRules = pathname === '/__lane/classify-with-rules';
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (
      request.method === 'POST' &&
      ['/__lane/advertise-readings', '/__lane/withdraw-readings'].includes(pathname)
    ) {
      request.resume();
      readingsAdvertised = pathname === '/__lane/advertise-readings';
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    const providerKey = request.headers[PROVIDER_KEY_HEADER];
    if (typeof providerKey === 'string') {
      keyed.push({
        method: request.method,
        path: pathname,
        provider: request.headers[PROVIDER_HEADER] ?? null,
        keyDigest: createHash('sha256').update(providerKey, 'utf8').digest('hex'),
      });
    }
    if (
      request.method === 'POST' &&
      (pathname === '/__lane/hold-letters' || pathname === '/__lane/release-letters')
    ) {
      request.resume();
      lettersHeld = pathname === '/__lane/hold-letters';
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && pathname === '/__lane/letter-care-escalation') {
      request.resume();
      send(response, HTTP_OK, LETTER_CARE_ESCALATION);
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/escalate-next-letter') {
      request.resume();
      letterEscalationArmed = true;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/fail-upload') {
      const body = await readJson(request);
      if (typeof body?.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(body.digest)) {
        refuse(response, HTTP_BAD_REQUEST, 'invalid_request');
        return;
      }
      uploadFailuresArmed.add(body.digest);
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/fail-next-voice-draft-delete') {
      request.resume();
      voiceDraftDeleteFailuresRemaining = ADEPTHOOD_DELETE_ATTEMPTS;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/record-agent-call') {
      await recordAgentCall(request, response);
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/leak-next-activity') {
      request.resume();
      activityLeakArmed = true;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/hold-journal-withdrawals') {
      request.resume();
      journalWithdrawalsHeld = true;
      send(response, HTTP_OK, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && pathname === '/__lane/release-journal-withdrawals') {
      request.resume();
      journalWithdrawalsHeld = false;
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
