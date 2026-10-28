import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { frontendUrl } from './journalHabitsBrowserSupport';
import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';

export const ROWS = ['writing-offer', 'morning-pages-offer', 'link-habit-nudge'];
export const ARTIFACTS = join(__dirname, 'artifacts', 'decline-ownership-3289');

export async function settings(page: Page): Promise<void> {
  await page.goto(`${frontendUrl()}/settings`);
  await expect(page.getByTestId('settings-group-journal')).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await settings(page);
  await page.getByTestId('settings-row-logout').click();
  await expect(page.getByRole('link', { name: 'Go to log-in screen' })).toBeVisible();
}

export async function offered(page: Page, value: boolean): Promise<void> {
  for (const row of ROWS) {
    const control = page.getByTestId(`settings-row-${row}`).getByRole('switch');
    await expect(control).toBeEnabled();
    if (value) await expect(control).toBeChecked();
    else await expect(control).not.toBeChecked();
  }
}

/** Arrange real persisted pending rows; eligibility/generation is outside this
 * journey. The browser then uses unmodified listing/dismissal HTTP handlers. */
export interface InvitationSeed {
  targetType: 'habit' | 'practice' | 'course' | 'sangha' | 'embodied_community';
  targetId?: number | null;
  kind: 'readiness' | 'consistency' | 'mastery';
}

const DECLINE_SEEDS: readonly InvitationSeed[] = [
  { targetType: 'habit', kind: 'consistency' },
  { targetType: 'practice', kind: 'consistency' },
  { targetType: 'sangha', kind: 'consistency' },
];

export function seedInvitations(
  email: string,
  seeds: readonly InvitationSeed[] = DECLINE_SEEDS,
): number[] {
  const lane = readLaneState();
  if (lane === null) throw new Error('Missing isolated database');
  const code = `
import asyncio, json, os, sys
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlmodel import select
from database import normalize_database_url
from models import User
from models.invitation_signal import InvitationSignal
async def main():
    engine = create_async_engine(normalize_database_url(os.environ['DATABASE_URL']))
    async with AsyncSession(engine, expire_on_commit=False) as session:
        user = (await session.execute(select(User).where(User.email == sys.argv[1]))).scalar_one()
        seeds = json.loads(sys.argv[2])
        rows = [InvitationSignal(
            user_id=user.id,
            target_type=seed['targetType'],
            target_id=seed.get('targetId'),
            kind=seed['kind'],
        ) for seed in seeds]
        session.add_all(rows)
        await session.commit()
        print(json.dumps([row.id for row in rows]))
    await engine.dispose()
asyncio.run(main())
`;
  const result = spawnSync(pythonExecutable(), ['-c', code, email, JSON.stringify(seeds)], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: lane.databaseUrl },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout) as number[];
}

export async function expectTextWithinViewport(page: Page, testId: string): Promise<void> {
  const overflow = await page.getByTestId(testId).evaluate((root) => {
    const result: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.childElementCount || !element.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1))
          result.push(element.textContent);
      }
    }
    return result;
  });
  expect(overflow).toEqual([]);
}
