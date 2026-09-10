import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The handshake between `globalSetup` and `globalTeardown`, which run in the
 * same process but cannot share a closure across Jest's module boundary, and
 * between both of them and `setupEnv`, which runs in the worker.
 */
export interface LaneState {
  /** Process group leader of the server, killed as a group at teardown. */
  pid: number;
  /** Process group leader of the isolated fake Creek control plane. */
  creekPid: number;
  /** Process group leader of the loopback fake the provider SDKs are pointed at. */
  providerPid: number;
  /** Origin of that fake, which a journey reads its attempt counters from. */
  providerUrl: string;
  /** Per-run directory holding only the generated fake-provider keys. */
  providerKeyDir: string;
  /**
   * The three keys the fake recognises, minted per run.
   *
   * They are credentials for a loopback process and nothing else, and they are
   * the arrangement itself: `spentOpenaiKey` is the caller's own spent account
   * (402), `throttledOpenaiKey` is a genuine rate limit that must still retry,
   * and the server's own `LLM_API_KEY` is the spent Anthropic account (503).
   */
  spentOpenaiKey: string;
  throttledOpenaiKey: string;
  /**
   * The token that sends one marked prompt past the stub to a real provider.
   *
   * A journey needing the server's *own* key to be refused has no other way to
   * reach a provider: a BYOK header would make it the caller's key by
   * definition, which is the other half of the split. See
   * `backend/src/services/provider_probe.py`.
   */
  providerProbeToken: string;
  /** Process group leader of the loopback fake serving Creek's `/v1` surface. */
  vaultPid: number;
  /**
   * Origin of that vault, which the seed journey reads its arrival ledger from.
   *
   * The same string the lane's server holds as `CREEK_VAULT_URL`, so a spec
   * asking what arrived is asking the process adepthood actually dialled rather
   * than one it happens to agree with.
   */
  vaultUrl: string;
  /** Per-run directory holding only the generated vault bearer. */
  vaultKeyDir: string;
  /** The bearer the lane's server presents to that vault, minted per run. */
  vaultApiKey: string;
  /**
   * The one account the deployment-wide vault belongs to, and its password.
   *
   * `CREEK_VAULT_OWNER_USER_ID` is read from the server's environment, so the
   * id it names has to exist before the server that reads it does. `globalSetup`
   * closes that circle by signing this account up over HTTP as the lane's very
   * first request and asserting it received exactly the id the environment
   * already named -- so a spec logs in as an owner rather than trying to become
   * one. Every other account in the lane is a non-owner and reaches no vault,
   * which is what leaves every other journey's behaviour where it was.
   */
  vaultOwnerEmail: string;
  vaultOwnerPassword: string;
  /** Loopback origin the production client is pointed at. */
  baseUrl: string;
  /** URL of the throwaway database the run owns. */
  databaseUrl: string;
  /** URL of a database that already exists, used only to drop the throwaway one. */
  adminUrl: string;
  /** Per-run directory containing only generated control-plane test credentials. */
  credentialDir: string;
  /** Per-run directory holding the captured outbound mail, removed at teardown. */
  mailDir: string;
  /** File the server's capture email backend appends every rendered message to. */
  emailCaptureFile: string;
  /** The `https://` origin the server builds the links in outbound mail from. */
  webBaseUrl: string;
}

/** Repository root, three levels up from `frontend/e2e`. */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** Working directory the server module must be launched from. */
export const BACKEND_DIR = join(REPO_ROOT, 'backend');

/** Where the run records itself; `.gitignore`d, and removed at teardown. */
export const STATE_FILE = join(__dirname, '.e2e-state.json');

/** Write the run's coordinates so teardown can reach them. */
export function writeLaneState(state: LaneState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Read the run's coordinates, or null when setup never got far enough. */
export function readLaneState(): LaneState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as LaneState;
}

/** Forget the run, so a later invocation cannot inherit a dead server's port. */
export function clearLaneState(): void {
  rmSync(STATE_FILE, { force: true });
}

/**
 * The interpreter that can import the backend. `E2E_PYTHON` wins; otherwise the
 * repo's virtualenv if it exists (the local case), else whatever `python3` is on
 * PATH (the CI case, where dependencies are installed system-wide).
 *
 * Shared rather than duplicated: setup spawns the server with it and teardown
 * drops the database with it, and an interpreter that differed between the two
 * would leave the database behind while looking like it had cleaned up.
 */
export function pythonExecutable(): string {
  const override = process.env.E2E_PYTHON?.trim();
  if (override) return override;
  const venv = join(REPO_ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}
