import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CONTRACT_HEADER = 'Creek-Provisioning-Version';
const CONTRACT_VERSION = '2.0.0';
const READY_PREFIX = 'FAKE_CREEK_READY port=';
const LOOPBACK_HOST = '127.0.0.1';
const REQUESTER_FILE = process.env.FAKE_CREEK_REQUESTER_AUTH_FILE;
const HANDOFF_FILE = process.env.FAKE_CREEK_HANDOFF_AUTH_FILE;
const CALLBACK_FILE = process.env.FAKE_CREEK_CALLBACK_FILE;
const CLIENT_VAULT_URL = 'https://1.1.1.1';
const CLIENT_CREDENTIAL = 'e2e-provisioned-vault-credential'; // pragma: allowlist secret
const jobs = new Map();

function requiredFile(path, name) {
  if (!path) throw new Error(`${name} is unset`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

const requesterToken = requiredFile(REQUESTER_FILE, 'FAKE_CREEK_REQUESTER_AUTH_FILE');
const handoffToken = requiredFile(HANDOFF_FILE, 'FAKE_CREEK_HANDOFF_AUTH_FILE');

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    [CONTRACT_HEADER]: CONTRACT_VERSION,
  });
  response.end(JSON.stringify(payload));
}

function unauthorized(response) {
  send(response, 401, { code: 'invalid_request' });
}

function jobResponse(job) {
  return {
    job_id: job.jobId,
    activation_id: job.activationId,
    state: job.state,
    attempts: job.attempts,
    retryable: false,
    failure_reason: null,
    created_at: job.createdAt,
    updated_at: new Date().toISOString(),
    attested_confidential: false,
    custody_mode: job.state === 'ready' ? 'provider_managed' : null,
    status_url: `/control/v1/jobs/${job.jobId}`,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function deliverHandoff(job) {
  const callbackBase = requiredFile(CALLBACK_FILE, 'FAKE_CREEK_CALLBACK_FILE');
  const response = await fetch(`${callbackBase}/internal/vault-provisioning/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${handoffToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      job_id: job.jobId,
      consumer_identity: job.consumerIdentity,
      vault_url: CLIENT_VAULT_URL,
      consumer_credential: CLIENT_CREDENTIAL,
    }),
  });
  if (response.status !== 204) throw new Error(`handoff returned ${response.status}`);
}

async function activate(request, response) {
  const body = await readJson(request);
  const existing = [...jobs.values()].find((job) => job.activationId === body.activation_id);
  const now = new Date().toISOString();
  const job = existing ?? {
    jobId: `job-${randomUUID()}`,
    activationId: body.activation_id,
    consumerIdentity: body.consumer_identity,
    state: 'pending',
    attempts: 1,
    createdAt: now,
  };
  jobs.set(job.jobId, job);
  send(response, 202, jobResponse(job));
}

function findJob(pathname) {
  const match = /^\/control\/v1\/jobs\/([^/]+)/u.exec(pathname);
  return match?.[1] ? jobs.get(match[1]) : undefined;
}

async function handleJob(request, response, pathname) {
  const job = findJob(pathname);
  if (!job) return send(response, 404, { code: 'job_unavailable' });
  if (request.method === 'GET') {
    if (job.state === 'pending') {
      job.state = 'provisioning';
    } else if (job.state === 'provisioning') {
      await deliverHandoff(job);
      job.state = 'ready';
    }
    return send(response, 200, jobResponse(job));
  }
  return send(response, 405, { code: 'invalid_request' });
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.headers.authorization !== `Bearer ${requesterToken}`) {
      unauthorized(response);
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && pathname === '/control/v1/activations') {
      await activate(request, response);
      return;
    }
    if (pathname.startsWith('/control/v1/jobs/')) {
      await handleJob(request, response, pathname);
      return;
    }
    send(response, 404, { code: 'job_unavailable' });
  })().catch(() => send(response, 500, { code: 'internal_error' }));
});

server.listen(0, LOOPBACK_HOST, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake Creek did not bind');
  process.stdout.write(`${READY_PREFIX}${address.port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
