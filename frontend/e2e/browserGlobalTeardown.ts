import { clearBrowserLaneState, readBrowserLaneState } from './browserState';
import apiGlobalTeardown from './globalTeardown';

async function stopProcessGroup(pid: number): Promise<void> {
  if (pid <= 0) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return undefined;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return undefined;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The process exited after the final liveness probe.
  }
}

export default async function browserGlobalTeardown(): Promise<void> {
  const state = readBrowserLaneState();
  try {
    if (state !== null) await stopProcessGroup(state.frontendPid);
    await apiGlobalTeardown();
  } finally {
    clearBrowserLaneState();
  }
}
