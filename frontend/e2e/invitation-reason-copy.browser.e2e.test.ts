import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { seedInvitations } from './declineOwnershipBrowserSupport';
import { signUp } from './journalHabitsBrowserSupport';
import { BACKEND_DIR, pythonExecutable, readLaneState } from './laneState';

/**
 * #3104 — the reason on an invitation and the served Aspect cross the real wire.
 *
 * The Aspect is deliberately longer than the seeded curriculum copy so the
 * three browser frames also exercise wrapping. It is written out of band
 * because curriculum identity has no user-facing mutation route; every read
 * under assertion remains the unmocked GET /stages/correspondence ->
 * InvitationNote path. Both changed fields are restored after the run.
 */

const STAGE = 2;
const LONG_ASPECT = 'Self-Love Across Every Tender Part of a Long and Changing Life';
const PRIVATE_PERSONA = 'Persona That Must Never Enter This Invitation';
const ARTIFACTS = join(__dirname, 'artifacts', 'invitation-reasons-3104', 'after');

interface FieldWrite {
  value: string;
  previous: string;
}

const writeStageField = (
  field: 'aspect' | 'relationship_to_free_will',
  value: string,
): FieldWrite => {
  const lane = readLaneState();
  if (lane === null) throw new Error('Missing isolated database');
  const code = `
import asyncio, json, os, sys
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlmodel import select
from database import normalize_database_url
from models.course_stage import CourseStage
async def main():
    engine = create_async_engine(normalize_database_url(os.environ['DATABASE_URL']))
    async with AsyncSession(engine, expire_on_commit=False) as session:
        stage = (await session.execute(select(CourseStage).where(CourseStage.stage_number == int(sys.argv[1])))).scalar_one()
        field, value = sys.argv[2], sys.argv[3]
        previous = getattr(stage, field)
        setattr(stage, field, value)
        session.add(stage)
        await session.commit()
        print(json.dumps({'value': value, 'previous': previous}))
    await engine.dispose()
asyncio.run(main())
`;
  const result = spawnSync(pythonExecutable(), ['-c', code, String(STAGE), field, value], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'src', DATABASE_URL: lane.databaseUrl },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout) as FieldWrite;
};

const expectedLine =
  `Your writing has circled ${LONG_ASPECT}. ` +
  'There is a reading built for exactly that. It is here when you want it, and I think you want it.';

async function assertCardGeometry(page: Page, id: number): Promise<void> {
  const card = page.getByTestId(`invitation-${String(id)}`);
  const decline = page.getByTestId(`invitation-${String(id)}-dismiss`);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card).toContainText(expectedLine);
  await expect(card).not.toContainText(PRIVATE_PERSONA);
  await expect(decline).toHaveAccessibleName('Dismiss this invitation');
  await expect(decline).toContainText('Not now');

  const geometry = await card.evaluate(
    (root, dismissTestId) => {
      const declineNode = root.querySelector<HTMLElement>(`[data-testid="${dismissTestId}"]`);
      if (declineNode === null) throw new Error('Invitation decline control is missing');
      const cardBox = root.getBoundingClientRect();
      const declineBox = declineNode.getBoundingClientRect();
      const lineNode = root.querySelector<HTMLElement>(
        `[data-testid="${String(dismissTestId).replace('-dismiss', '-line')}"]`,
      );
      if (lineNode === null) throw new Error('Invitation line is missing');
      const lineBox = lineNode.getBoundingClientRect();
      const clippedText = Array.from(root.querySelectorAll<HTMLElement>('*')).flatMap((node) => {
        if (node.childElementCount > 0 || !node.textContent?.trim()) return [];
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects())
          .filter(
            (box) =>
              box.width > 0 && (box.left < cardBox.left - 1 || box.right > cardBox.right + 1),
          )
          .map(() => node.textContent?.trim() ?? '');
      });
      return {
        card: { top: cardBox.top, bottom: cardBox.bottom },
        decline: {
          top: declineBox.top,
          width: declineBox.width,
          height: declineBox.height,
        },
        lineBottom: lineBox.bottom,
        clippedText,
        viewportHeight: window.innerHeight,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    },
    `invitation-${String(id)}-dismiss`,
  );

  expect(geometry.clippedText).toEqual([]);
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.card.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.decline.top).toBeGreaterThanOrEqual(geometry.lineBottom);
  expect(geometry.decline.width).toBeGreaterThanOrEqual(44);
  expect(geometry.decline.height).toBeGreaterThanOrEqual(44);
}

async function exerciseViewport(
  browser: Browser,
  label: string,
  viewport: { width: number; height: number },
  deviceScaleFactor = 1,
  dismiss = false,
): Promise<void> {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  try {
    const email = await signUp(page, `invitation-reason-${label}`);
    const [id] = seedInvitations(email, [
      { targetType: 'course', targetId: STAGE, kind: 'readiness' },
    ]);
    if (id === undefined) throw new Error('The course invitation was not seeded');

    // Open directly from a cold Journal route. The notification card performs
    // one visit-free curriculum vocabulary read, so explaining an invitation
    // cannot manufacture a Map/program visit merely to learn the Aspect name.
    const vocabulary = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'GET' &&
        new URL(candidate.url()).pathname === '/stages/correspondence',
    );
    await page.getByTestId('journal-notifications-open').click();
    expect((await vocabulary).ok()).toBe(true);
    await expect(page.getByTestId('journal-notification-center')).toBeVisible();
    await assertCardGeometry(page, id);

    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(ARTIFACTS, `${label}.png`) });

    if (dismiss) {
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          new URL(candidate.url()).pathname === `/invitations/${String(id)}/dismiss`,
      );
      await page.getByTestId(`invitation-${String(id)}-dismiss`).click();
      expect((await response).ok()).toBe(true);
      await expect(page.getByTestId(`invitation-${String(id)}`)).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
}

let previousAspect: string | null = null;
let previousPersona: string | null = null;

test.beforeAll(() => {
  previousAspect = writeStageField('aspect', LONG_ASPECT).previous;
  previousPersona = writeStageField('relationship_to_free_will', PRIVATE_PERSONA).previous;
});

test.afterAll(() => {
  if (previousAspect !== null) writeStageField('aspect', previousAspect);
  if (previousPersona !== null) writeStageField('relationship_to_free_will', previousPersona);
});

test('course invitation explains its real reason, names the served Aspect, and stays clear', async ({
  browser,
}) => {
  await exerciseViewport(browser, '390x844-100', { width: 390, height: 844 }, 1, true);
  // 200% effective browser size: a 195×422 CSS viewport rendered to 390×844 pixels.
  await exerciseViewport(browser, '390x844-200', { width: 195, height: 422 }, 2);
  await exerciseViewport(browser, '1280x800-100', { width: 1280, height: 800 });
});
