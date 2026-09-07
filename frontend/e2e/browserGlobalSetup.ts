import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { clearBrowserLaneState, writeBrowserLaneState } from './browserState';
import apiGlobalSetup from './globalSetup';
import apiGlobalTeardown from './globalTeardown';
import { readLaneState } from './laneState';

const BOOT_TIMEOUT_MS = 180_000;
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

async function waitForFrontend(child: ChildProcess, frontendUrl: string): Promise<void> {
  let log = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Expo web exited before it was ready (exit ${child.exitCode}).\n${log}`);
    }
    try {
      const response = await fetch(frontendUrl);
      const html = await response.text();
      if (response.ok && html.includes('<div id="root">')) return;
    } catch {
      // The socket is not accepting requests yet; keep polling until the budget ends.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Expo web did not become ready within ${BOOT_TIMEOUT_MS}ms.\n${log}`);
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
