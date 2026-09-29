import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { clearBrowserLaneState, writeBrowserLaneState } from './browserState';
import { scriptUrls, warmBundles } from './bundleWarmup';
import apiGlobalSetup from './globalSetup';
import apiGlobalTeardown from './globalTeardown';
import { readLaneState } from './laneState';

const BOOT_TIMEOUT_MS = 180_000;
/** How long to wait between attempts at a bundle Metro is still compiling. */
const WARM_RETRY_MS = 250;
// Development CORS is deliberately explicit and includes this origin. Using a
// random port would make the app report "offline" even while both servers are
// healthy, which tests CORS rejection rather than the browser journey.
const FRONTEND_PORT = 3000;
const FRONTEND_DIR = join(__dirname, '..');
const EXPO_CLI = join(FRONTEND_DIR, 'node_modules', 'expo', 'bin', 'cli');

function launchFrontend(apiUrl: string, port: number): ChildProcess {
  return spawn(process.execPath, [EXPO_CLI, 'start', '--web', '--port', String(port)], {
    cwd: FRONTEND_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CI: '1',
      EXPO_PUBLIC_API_BASE_URL: apiUrl,
    },
  });
}

/**
 * Fetch every bundle the shell references until Metro has compiled it.
 *
 * The shell answers before any JS exists: Metro compiles a bundle on its first
 * request. Without this, the first spec to navigate -- whichever sorts first --
 * paid the cold compile inside its own 15s action timeout (#2860's CI run,
 * where the action-row sweep became that spec). Warming here spends it inside
 * the boot deadline, the budget meant for it. The URLs are printed so a run
 * log shows what was warmed.
 */
async function warmFrontend(html: string, frontendUrl: string, deadline: number): Promise<void> {
  const urls = scriptUrls(html, frontendUrl);
  console.log(`[browser lane] warming ${String(urls.length)} bundle(s): ${urls.join(', ')}`);
  await warmBundles(urls, { deadline, fetchImpl: fetch, retryMs: WARM_RETRY_MS });
}

/** The HTML shell once Expo serves it, or null while it is not up yet. */
async function fetchShell(frontendUrl: string): Promise<string | null> {
  try {
    const response = await fetch(frontendUrl);
    const html = await response.text();
    return response.ok && html.includes('<div id="root">') ? html : null;
  } catch {
    // The socket is not accepting requests yet; the caller keeps polling.
    return null;
  }
}

/** Everything the dev server has printed so far, for a failure message. */
function captureLog(child: ChildProcess): { text: string } {
  const log = { text: '' };
  const append = (chunk: Buffer): void => {
    log.text += chunk.toString();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return log;
}

async function waitForFrontend(child: ChildProcess, frontendUrl: string): Promise<void> {
  const log = captureLog(child);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let shell: string | null = null;
  while (shell === null) {
    if (Date.now() >= deadline) {
      throw new Error(`Expo web did not become ready within ${BOOT_TIMEOUT_MS}ms.\n${log.text}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`Expo web exited before it was ready (exit ${child.exitCode}).\n${log.text}`);
    }
    shell = await fetchShell(frontendUrl);
    if (shell === null) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  try {
    await warmFrontend(shell, frontendUrl, deadline);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Expo web served its shell but not its bundle: ${reason}\n${log.text}`);
  }
}

export default async function browserGlobalSetup(): Promise<void> {
  clearBrowserLaneState();
  await apiGlobalSetup();
  const apiState = readLaneState();
  if (apiState === null || apiState.baseUrl === '') {
    await apiGlobalTeardown();
    throw new Error('the API journey setup returned without a live backend URL');
  }

  const frontendUrl = `http://127.0.0.1:${FRONTEND_PORT}`;
  const child = launchFrontend(apiState.baseUrl, FRONTEND_PORT);
  writeBrowserLaneState({ frontendPid: child.pid ?? 0, frontendUrl });
  try {
    await waitForFrontend(child, frontendUrl);
  } catch (error: unknown) {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    clearBrowserLaneState();
    await apiGlobalTeardown();
    throw error;
  }
}
