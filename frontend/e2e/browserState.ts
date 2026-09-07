import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BrowserLaneState {
  /** Process-group leader for the isolated Expo web server. */
  frontendPid: number;
  /** Origin served by that process. */
  frontendUrl: string;
}

export const BROWSER_STATE_FILE = join(__dirname, '.browser-e2e-state.json');

export function writeBrowserLaneState(state: BrowserLaneState): void {
  writeFileSync(BROWSER_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function readBrowserLaneState(): BrowserLaneState | null {
  if (!existsSync(BROWSER_STATE_FILE)) return null;
  return JSON.parse(readFileSync(BROWSER_STATE_FILE, 'utf8')) as BrowserLaneState;
}

export function clearBrowserLaneState(): void {
  rmSync(BROWSER_STATE_FILE, { force: true });
}
