import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import globalTeardown from './globalTeardown';
import {
  BACKEND_DIR,
  clearLaneState,
  pythonExecutable,
  writeLaneState,
  type LaneState,
} from './laneState';
import { freshLicenseKey } from './licenseKey';

/**
 * Bring up the server the journeys drive: an ephemeral Postgres database built
 * by `alembic upgrade head`, and the real FastAPI app serving it on a loopback
 * port. Nothing here degrades gracefully. A missing Postgres, a server that
 * fails to boot, or a health probe that answers wrong all throw, because the
 * only thing worse than a red e2e lane is a green one that never made a
 * request.
 */

const POSTGRES_URL_ENV = 'TEST_POSTGRES_URL';
const READY_PREFIX = 'E2E_READY port=';
const BOOT_TIMEOUT_MS = 180_000;
const SECRET_KEY_BYTES = 32;
const DATABASE_SUFFIX_BYTES = 6;
const CREDENTIAL_BYTES = 32;
const PROVIDER_KEY_BYTES = 24;
const PROBE_TOKEN_BYTES = 24;
// The prefixes each provider's key format requires, and which
// `botmason.provider_for_api_key` routes on: a BYOK key selects its own
// provider, so these are what send the caller's-key branch to OpenAI and leave
// the server's own key on Anthropic.
const OPENAI_KEY_PREFIX = 'sk-e2e-'; // pragma: allowlist secret
const ANTHROPIC_KEY_PREFIX = 'sk-ant-e2e-'; // pragma: allowlist secret

/**
 * The email backend the lane boots the server with, and the file it writes to.
 *
 * The password-recovery journey has to read a plaintext reset token, and that
 * token exists nowhere but the rendered body of the email: the row stores a
 * bcrypt digest, the response is a fixed anti-enumeration sentence, and the
 * console adapter masks the token to its first eight characters before it
 * reaches any log. `EMAIL_BACKEND=capture` is the backend that writes the body
 * out verbatim, and `services.email` refuses to build it when `ENV` names
 * production -- it is a live credential on disk, so it is barred from the only
 * environment where that matters rather than merely discouraged there.
 */
const EMAIL_BACKEND = 'capture';
const MAIL_FILE_NAME = 'outbound.jsonl';

/**
 * The origin the server builds the browser-followable half of its links from.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, which is what makes
 * it safe here: the journey asserts on the string the email carries and never
 * opens it. It must be `https://` because that is the assertion -- a reset mail
 * offering only the `adepthood://` deep link is delivery no browser can follow,
 * and the web build is the only client that ships.
 */
const WEB_BASE_URL = 'https://reset.adepthood.invalid';

/**
 * The account the lane's deployment-wide Creek Vault belongs to.
 *
 * `dependencies.creek_vault` serves the configured vault to exactly one user --
 * the one `CREEK_VAULT_OWNER_USER_ID` names -- and reads that variable from the
 * server process's environment, which is fixed before the server has a database,
 * let alone an account in it. The circle is closed by naming the id the sequence
 * is about to hand out and then proving it: this is the *first* request the lane
 * makes, against a database `alembic upgrade head` built moments earlier, so the
 * account it creates takes the first id in `user`'s identity sequence.
 *
 * Nothing rests on that being true, because `provisionVaultOwner` asserts the id
 * it got back and throws the lane down if it differs. A guess that stopped
 * holding fails at setup, loudly, naming what changed -- rather than leaving one
 * spec asserting `vault_unavailable` and calling it coverage.
 */
const VAULT_OWNER_USER_ID = 1;
const VAULT_OWNER_PASSWORD = 'a candle carried between rooms'; // pragma: allowlist secret
const VAULT_OWNER_TIMEZONE = 'UTC';
const HTTP_OK = 200;

const POSTGRES_HELP =
  `${POSTGRES_URL_ENV} is unset, so there is no database to build the schema in. ` +
  'Start one with: docker run -d --name adepthood-e2e-pg -e POSTGRES_USER=aptitude ' +
  '-e POSTGRES_PASSWORD=aptitude -e POSTGRES_DB=aptitude -p 5432:5432 postgres:16 ' +
  `then point ${POSTGRES_URL_ENV} at it (see frontend/e2e/README.md for the full recipe). ` +
  'The lane never skips on an absent server: that is the gap it exists to close.';

/** Replace the database component of a connection URL, preserving any query. */
function withDatabase(url: string, name: string): string {
  // Split on the FIRST '?' only, keeping the whole query: split(url, 2) would
  // silently drop everything after a second '?'.
  const queryStart = url.indexOf('?');
  const base = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? undefined : url.slice(queryStart + 1);
  if (!base.includes('://')) {
    throw new Error(`${POSTGRES_URL_ENV} is not a connection URL: "${url}"`);
  }
  const authorityEnd = base.indexOf('/', base.indexOf('://') + '://'.length);
  const authority = authorityEnd === -1 ? base : base.slice(0, authorityEnd);
  return `${authority}/${name}${query === undefined ? '' : `?${query}`}`;
}

/** Confirm the app is actually answering, not merely listening. */
async function assertHealthy(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);
  const body: unknown = await response.json();
  const { status, database } = body as { status?: unknown; database?: unknown };
  if (response.status !== HTTP_OK || status !== 'healthy' || database !== 'connected') {
    throw new Error(
      `the e2e server answered GET /health with ${response.status} ${JSON.stringify(body)}; ` +
        'the lane needs a server that is up and connected to its database',
    );
  }
}

interface Launch {
  pid: number;
  port: number;
}

/** Where the server's captured outbound mail lands, and the origin its links use. */
interface MailFixture {
  mailDir: string;
  captureFile: string;
  webBaseUrl: string;
}

interface CreekFixture {
  pid: number;
  port: number;
  credentialDir: string;
  requesterFile: string;
  handoffFile: string;
  callbackFile: string;
}

/**
 * The loopback provider fake, the keys it recognises, and the token that routes
 * one marked prompt to it.
 *
 * The lane's server runs the stub provider, which cannot refuse for billing --
 * it has no account at all -- so the spent-balance journey had no way to
 * happen. These are what make it happen without weakening anything: the SDKs'
 * own base-URL variables point at this process, the keys decide which refusal
 * it answers with (an exhausted balance is a property of an account, not of a
 * request), and the probe token is the only way a request paid for by the
 * *server's* key can reach a provider on a stub-configured deployment.
 */
interface ProviderFixture {
  pid: number;
  port: number;
  keyDir: string;
  spentOpenaiKey: string;
  throttledOpenaiKey: string;
  spentAnthropicKey: string;
  probeToken: string;
  keyFiles: { spentOpenai: string; throttledOpenai: string; spentAnthropic: string };
}

/** A per-run credential of the shape the named provider's keys carry. */
function providerKey(prefix: string): string {
  return `${prefix}${randomBytes(PROVIDER_KEY_BYTES).toString('hex')}`;
}

/**
 * Mint the fake's keys and write them where only it can read them.
 *
 * Files rather than arguments, for the reason the Creek fixture uses files: an
 * argument vector is world-readable through `/proc`, and these are handed to a
 * second process.
 */
function createProviderKeys(): Omit<ProviderFixture, 'pid' | 'port'> {
  const keyDir = mkdtempSync(join(tmpdir(), 'adepthood-e2e-llm-'));
  const values = {
    spentOpenai: providerKey(OPENAI_KEY_PREFIX),
    throttledOpenai: providerKey(OPENAI_KEY_PREFIX),
    spentAnthropic: providerKey(ANTHROPIC_KEY_PREFIX),
  };
  const keyFiles = {
    spentOpenai: join(keyDir, 'spent-openai'),
    throttledOpenai: join(keyDir, 'throttled-openai'),
    spentAnthropic: join(keyDir, 'spent-anthropic'),
  };
  for (const [role, path] of Object.entries(keyFiles)) {
    writeFileSync(path, values[role as keyof typeof values], { encoding: 'utf8', mode: 0o600 });
  }
  return {
    keyDir,
    keyFiles,
    spentOpenaiKey: values.spentOpenai,
    throttledOpenaiKey: values.throttledOpenai,
    spentAnthropicKey: values.spentAnthropic,
    probeToken: randomBytes(PROBE_TOKEN_BYTES).toString('base64url'),
  };
}

function launchFakeProvider(): Promise<ProviderFixture> {
  const fixture = createProviderKeys();
  const child = spawn(process.execPath, [join(__dirname, 'fakeLlmProvider.mjs')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FAKE_LLM_SPENT_OPENAI_KEY_FILE: fixture.keyFiles.spentOpenai,
      FAKE_LLM_THROTTLED_OPENAI_KEY_FILE: fixture.keyFiles.throttledOpenai,
      FAKE_LLM_SPENT_ANTHROPIC_KEY_FILE: fixture.keyFiles.spentAnthropic,
    },
  });
  return new Promise<ProviderFixture>((resolvePort, reject) => {
    let log = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), BOOT_TIMEOUT_MS);
    const fail = (reason: string): void => {
      clearTimeout(timer);
      rmSync(fixture.keyDir, { recursive: true, force: true });
      reject(new Error(`${reason}\n--- fake LLM provider output ---\n${log}`));
    };
    const onChunk = (chunk: Buffer): void => {
      log += chunk.toString();
      const match = /FAKE_LLM_READY port=(\d+)/u.exec(log);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolvePort({ ...fixture, pid: child.pid ?? 0, port: Number(match[1]) });
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) =>
      fail(`the fake LLM provider exited (${String(code)}, ${String(signal)}) before ready`),
    );
    child.on('error', (error: Error) =>
      fail(`could not start the fake LLM provider: ${error.message}`),
    );
  });
}

/** The half of the run's state the provider fake contributes, for both writes. */
type ProviderLaneState = Pick<
  LaneState,
  | 'providerPid'
  | 'providerUrl'
  | 'providerKeyDir'
  | 'spentOpenaiKey'
  | 'throttledOpenaiKey'
  | 'providerProbeToken'
>;

/**
 * Project the launched fake onto the fields a journey and teardown read.
 *
 * Written once and spread into both `writeLaneState` calls: the pre-boot write
 * exists so a server that never comes up still has its fake reaped, and two
 * hand-copied literals would be one edit away from disagreeing about which
 * process to kill.
 */
function providerLaneState(provider: ProviderFixture): ProviderLaneState {
  return {
    providerPid: provider.pid,
    providerUrl: `http://127.0.0.1:${provider.port}`,
    providerKeyDir: provider.keyDir,
    spentOpenaiKey: provider.spentOpenaiKey,
    throttledOpenaiKey: provider.throttledOpenaiKey,
    providerProbeToken: provider.probeToken,
  };
}

/** The half of the run's state the vault fake contributes, for every write. */
type VaultLaneState = Pick<LaneState, 'vaultPid' | 'vaultUrl' | 'vaultKeyDir' | 'vaultApiKey'>;

/** The one place the vault's origin is spelled, for both the server and the spec. */
function vaultOrigin(vault: VaultFixture): string {
  return `http://127.0.0.1:${vault.port}`;
}

/**
 * Project the launched vault onto the fields the seed journey and teardown read.
 *
 * `vaultUrl` is the same origin `serverEnvironment` hands the server as
 * `CREEK_VAULT_URL`, derived from one port rather than written twice, so a spec
 * asking what arrived cannot end up asking a different process than the one
 * adepthood dialled.
 */
function vaultLaneState(vault: VaultFixture): VaultLaneState {
  return {
    vaultPid: vault.pid,
    vaultUrl: vaultOrigin(vault),
    vaultKeyDir: vault.keyDir,
    vaultApiKey: vault.apiKey,
  };
}

/** Create the per-run directory the capture backend appends its mail to. */
function createMailFixture(): MailFixture {
  const mailDir = mkdtempSync(join(tmpdir(), 'adepthood-e2e-mail-'));
  return { mailDir, captureFile: join(mailDir, MAIL_FILE_NAME), webBaseUrl: WEB_BASE_URL };
}

function testCredential(): string {
  return randomBytes(CREDENTIAL_BYTES).toString('base64url');
}

function createCredentialFiles(): Omit<CreekFixture, 'pid' | 'port'> {
  const credentialDir = mkdtempSync(join(tmpdir(), 'adepthood-e2e-creek-'));
  const requesterFile = join(credentialDir, 'requester-token');
  const handoffFile = join(credentialDir, 'handoff-token');
  const callbackFile = join(credentialDir, 'callback-url');
  writeFileSync(requesterFile, testCredential(), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(handoffFile, testCredential(), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(callbackFile, '', { encoding: 'utf8', mode: 0o600 });
  return { credentialDir, requesterFile, handoffFile, callbackFile };
}

function launchFakeCreek(): Promise<CreekFixture> {
  const files = createCredentialFiles();
  const child = spawn(process.execPath, [join(__dirname, 'fakeCreekServer.mjs')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FAKE_CREEK_REQUESTER_AUTH_FILE: files.requesterFile,
      FAKE_CREEK_HANDOFF_AUTH_FILE: files.handoffFile,
      FAKE_CREEK_CALLBACK_FILE: files.callbackFile,
    },
  });
  return new Promise<CreekFixture>((resolvePort, reject) => {
    let log = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), BOOT_TIMEOUT_MS);
    const fail = (reason: string): void => {
      clearTimeout(timer);
      rmSync(files.credentialDir, { recursive: true, force: true });
      reject(new Error(`${reason}\n--- fake Creek output ---\n${log}`));
    };
    const onChunk = (chunk: Buffer): void => {
      log += chunk.toString();
      const match = /FAKE_CREEK_READY port=(\d+)/u.exec(log);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolvePort({ ...files, pid: child.pid ?? 0, port: Number(match[1]) });
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) =>
      fail(`fake Creek exited (${String(code)}, ${String(signal)}) before ready`),
    );
    child.on('error', (error: Error) => fail(`could not start fake Creek: ${error.message}`));
  });
}

/**
 * The loopback Creek Vault and the bearer the lane's server presents to it.
 *
 * The vault half of `seed.upload-document` had no destination at all: the lane
 * runs no vault, so every import took the local-fallback path and the accepted
 * outcome was unreachable. This is that destination, reached through
 * adepthood's own production `CREEK_VAULT_URL` -- a plaintext loopback origin,
 * which `services.creek_vault_url` admits for the *operator's* value by
 * deliberate design (whoever sets it owns the machine the process runs on).
 * The per-user rules are stricter and refuse loopback outright, which is why
 * this boundary is configured deployment-wide and bound to one account.
 */
interface VaultFixture {
  pid: number;
  port: number;
  keyDir: string;
  apiKey: string;
  keyFile: string;
}

function createVaultKey(): Omit<VaultFixture, 'pid' | 'port'> {
  const keyDir = mkdtempSync(join(tmpdir(), 'adepthood-e2e-vault-'));
  const keyFile = join(keyDir, 'api-key');
  const apiKey = testCredential();
  writeFileSync(keyFile, apiKey, { encoding: 'utf8', mode: 0o600 });
  return { keyDir, keyFile, apiKey };
}

function launchFakeVault(): Promise<VaultFixture> {
  const fixture = createVaultKey();
  const child = spawn(process.execPath, [join(__dirname, 'fakeCreekVault.mjs')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_VAULT_API_KEY_FILE: fixture.keyFile },
  });
  return new Promise<VaultFixture>((resolvePort, reject) => {
    let log = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), BOOT_TIMEOUT_MS);
    const fail = (reason: string): void => {
      clearTimeout(timer);
      rmSync(fixture.keyDir, { recursive: true, force: true });
      reject(new Error(`${reason}\n--- fake Creek Vault output ---\n${log}`));
    };
    const onChunk = (chunk: Buffer): void => {
      log += chunk.toString();
      const match = /FAKE_VAULT_READY port=(\d+)/u.exec(log);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolvePort({ ...fixture, pid: child.pid ?? 0, port: Number(match[1]) });
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) =>
      fail(`the fake Creek Vault exited (${String(code)}, ${String(signal)}) before ready`),
    );
    child.on('error', (error: Error) =>
      fail(`could not start the fake Creek Vault: ${error.message}`),
    );
  });
}

/** The four out-of-process fixtures one run owns, passed around as one value. */
interface LaneFixtures {
  creek: CreekFixture;
  mail: MailFixture;
  provider: ProviderFixture;
  vault: VaultFixture;
}

/**
 * Everything the server reads from its environment, and nothing it does not.
 *
 * Split out from `launchServer` because the two are separate questions: what
 * this run configures, and how the launch is awaited. The settings are declared
 * last-wins over the ambient environment on purpose -- a developer with
 * `EMAIL_BACKEND=smtp` exported in their shell must not have the lane's mail
 * leave the machine.
 */
function serverEnvironment(
  databaseUrl: string,
  adminUrl: string,
  { creek, mail, provider, vault }: LaneFixtures,
): typeof process.env {
  return {
    ...process.env,
    PYTHONPATH: 'src',
    DATABASE_URL: databaseUrl,
    E2E_ADMIN_DATABASE_URL: adminUrl,
    SECRET_KEY: randomBytes(SECRET_KEY_BYTES).toString('base64url'),
    CREEK_PROVISIONING_URL: `http://127.0.0.1:${creek.port}`,
    CREEK_PROVISIONING_AUTH_FILE: creek.requesterFile,
    CREEK_PROVISIONING_HANDOFF_AUTH_FILE: creek.handoffFile,
    EMAIL_BACKEND,
    EMAIL_CAPTURE_FILE: mail.captureFile,
    APP_BASE_URL: mail.webBaseUrl,
    // `BOTMASON_PROVIDER` stays unset, so every journey keeps the stub: no key,
    // no network, no third party. The four settings below matter only to a
    // request that reaches a provider at all, which on this server means one
    // carrying a BYOK key or the probe token -- one journey, deliberately.
    //
    // The base URLs are the SDKs' own variables, so nothing here is patched:
    // the OpenAI and Anthropic clients the production code builds address this
    // loopback fake the way they would address the real thing, and the errors
    // they raise are ones they constructed from its response bodies. That is
    // the whole point -- injecting the typed error would prove the routing and
    // assume the classification.
    OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
    // Whose key the server itself spends, pointed at the account the fake
    // treats as having no credit -- which is what the 503 half of the split
    // ("ours to restore, not yours") is about.
    LLM_API_KEY: provider.spentAnthropicKey,
    BOTMASON_PROVIDER_PROBE_TOKEN: provider.probeToken,
    // The deployment-wide vault, and the single account it belongs to. Both are
    // ordinary production settings: adepthood builds its real HTTP vault
    // adapter from them and negotiates the real contract over the wire. Every
    // account but the owner is served the local fallback, exactly as before --
    // which is the whole of why no other journey's outcome moves.
    CREEK_VAULT_URL: vaultOrigin(vault),
    CREEK_VAULT_API_KEY: vault.apiKey,
    CREEK_VAULT_OWNER_USER_ID: String(VAULT_OWNER_USER_ID),
  };
}

/** Spawn the server and resolve once it announces the port it bound. */
function launchServer(
  databaseUrl: string,
  adminUrl: string,
  fixtures: LaneFixtures,
): Promise<Launch> {
  const child = spawn(pythonExecutable(), ['-m', 'tests.e2e.server'], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: serverEnvironment(databaseUrl, adminUrl, fixtures),
  });

  return new Promise<Launch>((resolvePort, reject) => {
    let log = '';
    const fail = (reason: string): void => {
      reject(new Error(`${reason}\n--- server output ---\n${log}`));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`the e2e server did not report readiness within ${BOOT_TIMEOUT_MS}ms`);
    }, BOOT_TIMEOUT_MS);

    const onChunk = (chunk: Buffer): void => {
      log += chunk.toString();
      const match = /E2E_READY port=(\d+)/.exec(log);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePort({ pid: child.pid ?? 0, port: Number(match[1]) });
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fail(
        `the e2e server exited (code ${String(code)}, signal ${String(signal)}) before ${READY_PREFIX}`,
      );
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      fail(`could not start the e2e server: ${error.message}`);
    });
  });
}

/** The vault owner's credentials, as the run records them for its one spec. */
type VaultOwner = Pick<LaneState, 'vaultOwnerEmail' | 'vaultOwnerPassword'>;

/**
 * Sign the vault's owner up over HTTP, and refuse the lane if it is not the owner.
 *
 * The assertion is the whole point of doing this here rather than in the spec.
 * `CREEK_VAULT_OWNER_USER_ID` was fixed before this database existed, so if the
 * account that comes back holds any other id then the deployment's vault belongs
 * to nobody, every import in the seed journey quietly takes the local-fallback
 * path, and a spec would sit there asserting `vault_unavailable` while counting
 * as coverage. Throwing here turns that into a red lane at setup, naming the two
 * ids that disagreed.
 *
 * Signup rather than a direct insert: the licence gate, the password hashing,
 * the entitlement grant and the identity sequence are all the production ones,
 * so the owner is an ordinary account that merely happens to be first.
 */
async function provisionVaultOwner(baseUrl: string): Promise<VaultOwner> {
  const vaultOwnerEmail = `e2e-vault-owner-${randomUUID()}@example.com`;
  const response = await fetch(`${baseUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: vaultOwnerEmail,
      password: VAULT_OWNER_PASSWORD,
      timezone: VAULT_OWNER_TIMEZONE,
      license_key: freshLicenseKey(),
    }),
  });
  const body: unknown = await response.json();
  const { user_id: userId } = body as { user_id?: unknown };
  if (response.status !== HTTP_OK) {
    throw new Error(
      `the lane could not create the vault owner: POST /auth/signup answered ` +
        `${response.status} ${JSON.stringify(body)}`,
    );
  }
  if (userId !== VAULT_OWNER_USER_ID) {
    throw new Error(
      `the lane's vault is bound to user ${VAULT_OWNER_USER_ID} but the first account ` +
        `it created is user ${String(userId)}. Nothing in the lane would reach the vault, ` +
        `and the seed journey would assert an outcome it can never produce. Something ` +
        `now writes to "user" before globalSetup does -- a seeder, or a migration.`,
    );
  }
  return { vaultOwnerEmail, vaultOwnerPassword: VAULT_OWNER_PASSWORD };
}

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env[POSTGRES_URL_ENV]?.trim();
  if (!adminUrl) throw new Error(POSTGRES_HELP);

  clearLaneState();
  const databaseUrl = withDatabase(
    adminUrl,
    `adepthood_e2e_${randomBytes(DATABASE_SUFFIX_BYTES).toString('hex')}`,
  );

  const mail = createMailFixture();
  const creek = await launchFakeCreek();
  const provider = await launchFakeProvider();
  const vault = await launchFakeVault();
  const fixtures: LaneFixtures = { creek, mail, provider, vault };
  const fixtureState = {
    creekPid: creek.pid,
    databaseUrl,
    adminUrl,
    credentialDir: creek.credentialDir,
    mailDir: mail.mailDir,
    emailCaptureFile: mail.captureFile,
    webBaseUrl: mail.webBaseUrl,
    ...providerLaneState(provider),
    ...vaultLaneState(vault),
  };
  writeLaneState({
    pid: 0,
    baseUrl: '',
    vaultOwnerEmail: '',
    vaultOwnerPassword: '',
    ...fixtureState,
  });

  try {
    const { pid, port } = await launchServer(databaseUrl, adminUrl, fixtures);
    const baseUrl = `http://127.0.0.1:${port}`;
    writeFileSync(creek.callbackFile, baseUrl, { encoding: 'utf8', mode: 0o600 });
    // Recorded before the owner exists so a server that booted and then failed
    // its probe is still reaped, exactly as the pre-boot write does for the fakes.
    writeLaneState({ pid, baseUrl, vaultOwnerEmail: '', vaultOwnerPassword: '', ...fixtureState });
    await assertHealthy(baseUrl);
    const owner = await provisionVaultOwner(baseUrl);
    const state: LaneState = { pid, baseUrl, ...owner, ...fixtureState };
    writeLaneState(state);
    process.env.EXPO_PUBLIC_API_BASE_URL = baseUrl;
  } catch (error: unknown) {
    // Jest runs globalTeardown only after a globalSetup that returned, so a
    // server that booted but answers wrong would otherwise outlive the run.
    await globalTeardown();
    throw error;
  }

  // The API base is set inside the successful setup block so workers inherit
  // only a server that passed its real health probe.
}
