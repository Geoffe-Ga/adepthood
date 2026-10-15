import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import type { PracticeSessionCreate, SessionMetadata } from '../src/api';
import { STAGE_DURATIONS_DAYS } from '../src/constants/program';
import type { ModeConfig } from '../src/features/Practice/engine/types';

import {
  backendUrl,
  bearer,
  dayKeyIn,
  nextDayKey,
  sessionFor,
  setProgramAnchorDaysAgo,
  signUp,
} from './journalHabitsBrowserSupport';
import { instantAt } from './zonedClock';

/** #3212 / #3072: actual UI and persisted sessions for every supported family.
 * Seven real catalog presets and four UI-authored defaults. This is an engine
 * repertoire witness; native lifecycle/haptics and Course category authority
 * remain separate release evidence. No practice/adoption/session write is
 * arranged through the API, and no Course prerequisite is visited.
 */
const MINUTE = 60_000;
const CLOCK_BEHIND = 6 * 60 * MINUTE;
const OPEN_MINUTES = 2;
const PAUSE_MINUTES = 2;
const DURATION_TOLERANCE = 0.25;

type Mode = ModeConfig['mode'];
interface Family {
  stage: number;
  preset?: string;
  view: string;
}
/** A newly supported discriminator must add a real path to this closed matrix. */
const FAMILIES: Record<Mode, Family> = {
  sense_grounding: { stage: 1, preset: '5-4-3-2-1 grounding', view: 'sense-grounding-view' },
  meditation_timer: { stage: 1, preset: 'Body Scan', view: 'meditation-timer-view' },
  tallied_grounding: { stage: 1, preset: 'Find Colors', view: 'tallied-grounding-view' },
  mindful_anchor: { stage: 1, preset: 'Mindful Eating', view: 'mindful-anchor-view' },
  tarot: { stage: 2, preset: 'Tarot meditation', view: 'tarot-meditation-view' },
  metronome: { stage: 6, preset: 'Shadow work', view: 'metronome-view' },
  // Journaling has its own quick-launch writing path. Shadow Drawing exposes
  // the ordinary count-up player; both are real Green catalog rows.
  count_up: { stage: 6, preset: 'Shadow Drawing', view: 'count-up-timer-view' },
  interval_bell: { stage: 1, view: 'interval-bell-view' },
  random_interval_bell: { stage: 1, view: 'random-interval-bell-view' },
  rep_counter: { stage: 1, view: 'rep-counter-view' },
  card_meditation: { stage: 1, view: 'card-meditation-view' },
};
interface Practice {
  id: number;
  name: string;
  stage_number: number;
  mode: Mode;
  mode_config: ModeConfig;
}
interface Adoption {
  id: number;
  practice_id: number;
  stage_number: number;
  start_date: string;
  end_date: string | null;
}
interface SavedSession {
  id: number;
  user_practice_id: number;
  duration_minutes: number;
  mode: Mode;
  mode_metadata: SessionMetadata;
  completed: boolean;
}

async function openPractice(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Open \w+ menu$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Practice menu' })).toBeVisible();
}
/** Real scrolling, viewport bounds and browser hit testing precede every tap. */
async function reachable(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeEnabled();
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.x >= -1 &&
          box.y >= -1 &&
          box.right <= window.innerWidth + 1 &&
          box.bottom <= window.innerHeight + 1 &&
          hit !== null &&
          (element === hit || element.contains(hit))
        );
      }),
    )
    .toBe(true);
}
async function press(page: Page, id: string): Promise<void> {
  const control = page.getByTestId(id);
  await reachable(control);
  await control.click();
}
async function frames(
  page: Page,
  testInfo: TestInfo,
  state: string,
  control: string,
  mode: Mode,
  tarotName = 'The Fool',
): Promise<void> {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const scale of [1, 2]) {
      await page.evaluate((textScale) => {
        const texts = Array.from(document.querySelectorAll<HTMLElement>('[dir="auto"]'));
        const bases = texts.map(
          (text) => text.dataset.repertoireFontSize ?? getComputedStyle(text).fontSize,
        );
        for (const [index, text] of texts.entries()) {
          const base = bases[index];
          if (base === undefined) throw new Error('text has no measured base size');
          text.dataset.repertoireFontSize = base;
          text.style.fontSize = `${parseFloat(base) * textScale}px`;
          text.style.lineHeight = 'normal';
        }
      }, scale);
      // Modal completion deliberately blocks the underlying shell controls.
      if (state !== 'complete') {
        await headerFits(page);
        await playerTextFits(page, mode, tarotName, scale);
        await bellTimeFits(page);
      }
      await tarotCardFrame(page, testInfo, mode, state, viewport.width, scale);
      await reachable(page.getByTestId(control));
      await page.screenshot({
        path: testInfo.outputPath(`${state}-${String(viewport.width)}-${scale}x.png`),
      });
    }
  }
}
/** Capture the full card name before the separate control reachability scroll. */
async function tarotCardFrame(
  page: Page,
  testInfo: TestInfo,
  mode: Mode,
  state: string,
  width: number,
  scale: number,
): Promise<void> {
  if (mode === 'tarot' && state !== 'complete') {
    const name = page.getByTestId('tarot-card-name');
    await name.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const box = await name.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('the Tarot name has no browser geometry');
    expect(box.y).toBeGreaterThanOrEqual(110);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
    await page.screenshot({
      path: testInfo.outputPath(`${state}-card-${String(width)}-${scale}x.png`),
    });
    const begin = await page.getByTestId('tarot-begin').boundingBox();
    expect(begin).not.toBeNull();
    expect(begin?.width).toBeGreaterThanOrEqual(44);
    expect(begin?.height).toBeGreaterThanOrEqual(44);
  }
}
async function tarotNameFits(page: Page, expectedName: string, scale: number): Promise<void> {
  const name = page.getByTestId('tarot-card-name');
  await expect(name).toBeVisible();
  await expect(name, 'the rendered Tarot name must retain the complete card name').toHaveText(
    expectedName,
  );
  const bounds = await name.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const glyphs = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('the browser cannot measure text');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const naturalWidth = context.measureText(element.textContent ?? '').width;
    return {
      fits:
        (style.whiteSpace !== 'nowrap' || naturalWidth <= box.width + 0.01) &&
        glyphs.left >= box.left - 1 &&
        glyphs.right <= box.right + 1 &&
        glyphs.top >= box.top - 1 &&
        glyphs.bottom <= box.bottom + 1,
      naturalWidth,
      width: box.width,
      height: box.height,
      font: context.font,
      whiteSpace: style.whiteSpace,
      fontSize: parseFloat(style.fontSize),
    };
  });
  expect(bounds.fontSize, 'Tarot names retain the requested text size').toBe(26 * scale);
  expect(bounds.fits, `the full Tarot name must fit: ${JSON.stringify(bounds)}`).toBe(true);
}
/** A real later day selects a longer arcana name; no future session is submitted. */
async function laterTarotCardFits(
  page: Page,
  testInfo: TestInfo,
  mode: Mode,
  adoption: Adoption,
  timezone: string,
): Promise<void> {
  if (mode === 'tarot') {
    // Adoption is dated by the server; the initially backdated browser clock
    // can be on yesterday. Advance from that persisted account-calendar day.
    const targetDay = nextDayKey(nextDayKey(adoption.start_date));
    const later = instantAt(targetDay, '12:00', timezone);
    expect(dayKeyIn(later.toISOString(), timezone)).toBe(targetDay);
    await page.clock.setSystemTime(later);
    await page.reload();
    await openPractice(page);
    await expect(page.getByTestId('tarot-card-name')).toHaveText('The High Priestess');
    await expect(page.getByTestId('tarot-card-keyword')).toHaveText('Intuition');
    await frames(page, testInfo, 'later-idle', 'tarot-begin', mode, 'The High Priestess');
  }
}
async function playerTextFits(
  page: Page,
  mode: Mode,
  tarotName: string,
  scale: number,
): Promise<void> {
  if (mode === 'tarot') {
    await tarotNameFits(page, tarotName, scale);
    await expect(page.getByTestId('tarot-symbolism-scroll')).toBeVisible();
    await symbolismIsReadable(page, 'tarot-symbolism-scroll');
  }
  const cardName = page.getByTestId('card-meditation-card-name');
  if ((await cardName.count()) > 0) {
    const glyphsFit = await cardName.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().height <= element.getBoundingClientRect().height + 1;
    });
    expect(glyphsFit, 'the drawn card name must not be vertically clipped').toBe(true);
    await symbolismIsReadable(page);
  }
  const title = page.getByTestId('practice-identity-title');
  expect(
    await title.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return (
        range.getBoundingClientRect().right <=
        Math.min(element.getBoundingClientRect().right, window.innerWidth) + 1
      );
    }),
    'the practice name must wrap inside the identity row',
  ).toBe(true);
}
async function symbolismIsReadable(
  page: Page,
  testID = 'card-meditation-symbolism-scroll',
): Promise<void> {
  const scroll = page.getByTestId(testID);
  if ((await scroll.count()) > 0) {
    const dimensions = await scroll.evaluate((element) => ({
      viewport: element.clientHeight,
      content: element.scrollHeight,
    }));
    expect(dimensions.viewport).toBeGreaterThan(0);
    if (dimensions.content > dimensions.viewport) {
      await scroll.hover();
      await page.mouse.wheel(0, dimensions.content);
      await expect
        .poll(() =>
          scroll.evaluate(
            (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
          ),
        )
        .toBe(true);
    }
  }
}
async function bellTimeFits(page: Page): Promise<void> {
  const row = page.getByTestId('interval-bell-row-0');
  if ((await row.count()) > 0) {
    await expect(row.getByText('Opening bell', { exact: true })).toHaveCount(1);
    const time = row.getByText('00:00', { exact: true });
    expect(
      await time.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
      'a bell timestamp must stay readable on one line',
    ).toBe(1);
  }
}
async function headerFits(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Practice', exact: true });
  const feedback = page.getByRole('button', { name: 'Send feedback', exact: true });
  const settings = page.getByRole('button', { name: 'Open settings', exact: true });
  const menu = page.getByRole('button', { name: 'Open Practice menu', exact: true });
  for (const control of [feedback, settings, menu]) await reachable(control);
  const boxes = await Promise.all(
    [menu, heading, feedback, settings].map((item) => item.boundingBox()),
  );
  for (const box of boxes) expect(box).not.toBeNull();
  const [left, title, send, gear] = boxes;
  if (!left || !title || !send || !gear)
    throw new Error('the shell header has no browser geometry');
  expect(left.x + left.width).toBeLessThanOrEqual(title.x + 1);
  expect(title.x + title.width).toBeLessThanOrEqual(send.x + 1);
  expect(send.x + send.width).toBeLessThanOrEqual(gear.x + 1);
}
function startControl(mode: Mode): string {
  if (mode === 'tarot') return 'tarot-begin';
  if (mode === 'card_meditation') return 'card-meditation-begin';
  if (mode === 'mindful_anchor') return 'mindful-anchor-begin';
  return 'ritual-start';
}
async function currentAdoption(page: Page, token: string, practice: Practice): Promise<Adoption> {
  const response = await page.request.get(`${backendUrl()}/user-practices/`, {
    headers: bearer(token),
  });
  expect(response.ok()).toBe(true);
  const rows = (await response.json()) as Adoption[];
  const row = rows.find((item) => item.practice_id === practice.id && item.end_date === null);
  expect(row).toBeDefined();
  if (!row) throw new Error('the UI adoption was not persisted');
  expect(row.stage_number).toBe(practice.stage_number);
  return row;
}
async function selectPreset(page: Page, token: string, family: Family): Promise<Practice> {
  const response = await page.request.get(
    `${backendUrl()}/practices/?stage_number=${family.stage}`,
    { headers: bearer(token) },
  );
  expect(response.ok()).toBe(true);
  const catalog = (await response.json()) as Practice[];
  const practice = catalog.find((row) => row.name === family.preset);
  if (!practice) throw new Error(`real seeded preset missing: ${family.preset ?? ''}`);
  await press(page, 'practice-tab-catalog');
  await page.getByTestId('practice-catalog-search').fill(practice.name);
  await press(page, `practice-catalog-row-${practice.id}`);
  await expect(page.getByTestId('practice-detail-name')).toHaveText(practice.name);
  await press(page, 'practice-detail-use-for-stage');
  const adopted = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === '/user-practices/' && reply.request().method() === 'POST',
  );
  await press(page, `practice-detail-stage-pick-${family.stage}`);
  expect((await adopted).ok()).toBe(true);
  await expect(page.getByTestId('practice-detail-overlay')).toHaveCount(0);
  return practice;
}
async function createDefault(page: Page, mode: Mode): Promise<Practice> {
  await press(page, 'practice-tab-catalog');
  const name = `Browser repertoire ${mode}`;
  // The embedded catalog exposes creation through its empty-result CTA.
  await page.getByTestId('practice-catalog-search').fill(name);
  await press(page, 'practice-catalog-section-drafts-create');
  await press(page, 'create-practice-from-scratch');
  await press(page, `mode-picker-mode-${mode}`);
  await press(page, 'create-practice-configure-next');
  await page.getByTestId('create-practice-name').fill(name);
  await press(page, 'create-practice-stage-1');
  const created = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === '/practices/' && reply.request().method() === 'POST',
  );
  const assigned = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === '/user-practices/' && reply.request().method() === 'POST',
  );
  await press(page, 'create-practice-submit');
  const response = await created;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await assigned).ok()).toBe(true);
  const practice = (await response.json()) as Practice;
  expect(practice).toMatchObject({ name, stage_number: 1, mode, mode_config: { mode } });
  await expect(page.getByTestId('practice-detail-name')).toHaveText(name);
  return practice;
}
/** An early cancellation is optional and records no completed sitting. */
async function cancelAndRestart(page: Page, mode: Mode): Promise<void> {
  await press(page, startControl(mode));
  await page.clock.fastForward(10_000);
  if (mode === 'tarot' || mode === 'card_meditation') {
    const id = mode === 'tarot' ? 'tarot-cancel-longpress' : 'card-meditation-cancel-longpress';
    const control = page.getByTestId(id);
    await reachable(control);
    const box = await control.boundingBox();
    if (!box) throw new Error('the cancellation control has no browser box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.clock.fastForward(1000);
    await page.mouse.up();
  } else {
    await press(page, 'ritual-cancel');
  }
  await expect(page.getByTestId(startControl(mode))).toBeVisible();
  await expect(page.getByTestId('insight-capture-modal')).toHaveCount(0);
}
type PauseCapability =
  { kind: 'required' } | { kind: 'card'; defaultHidden: boolean; cancel: string };
/** UI capability comes from the mode and saved configuration, never missing DOM. */
const PAUSE_CAPABILITIES: Record<Mode, PauseCapability> = {
  sense_grounding: { kind: 'required' },
  meditation_timer: { kind: 'required' },
  tallied_grounding: { kind: 'required' },
  mindful_anchor: { kind: 'required' },
  tarot: { kind: 'card', defaultHidden: false, cancel: 'tarot-cancel-longpress' },
  metronome: { kind: 'required' },
  count_up: { kind: 'required' },
  interval_bell: { kind: 'required' },
  random_interval_bell: { kind: 'required' },
  rep_counter: { kind: 'required' },
  card_meditation: {
    kind: 'card',
    defaultHidden: true,
    cancel: 'card-meditation-cancel-longpress',
  },
};
async function pauseOnce(page: Page, config: ModeConfig): Promise<void> {
  const capability = PAUSE_CAPABILITIES[config.mode];
  let hidden = false;
  if (capability.kind === 'card') {
    if (config.mode !== 'tarot' && config.mode !== 'card_meditation')
      throw new Error('a card-only capability must name a card mode');
    hidden = config.hide_timer_during_meditation ?? capability.defaultHidden;
  }
  if (hidden && capability.kind === 'card') {
    await expect(page.getByTestId('ritual-pause')).toHaveCount(0);
    await expect(page.getByTestId('ritual-resume')).toHaveCount(0);
    await reachable(page.getByTestId(capability.cancel));
  } else {
    await expect(page.getByTestId('ritual-pause')).toBeVisible();
    await press(page, 'ritual-pause');
    await expect(page.getByTestId('ritual-resume')).toBeVisible();
    await expect(page.getByTestId('ritual-pause')).toHaveCount(0);
    await page.clock.fastForward(PAUSE_MINUTES * MINUTE);
    await press(page, 'ritual-resume');
    await expect(page.getByTestId('ritual-pause')).toBeVisible();
    await expect(page.getByTestId('ritual-resume')).toHaveCount(0);
  }
}
/** #3273: a missing required Pause must fail the same real-player witness. */
async function missingPauseIsRejected(page: Page, config: ModeConfig): Promise<void> {
  const pause = await page.getByTestId('ritual-pause').elementHandle();
  if (!pause) throw new Error('the control-removal witness requires the actual Pause button');
  const parent = await pause.evaluateHandle((element) => element.parentElement);
  await pause.evaluate((element) => element.remove());
  try {
    await expect(pauseOnce(page, config)).rejects.toThrow(/ritual-pause/);
  } finally {
    await parent.evaluate((element, control) => {
      if (!element || !control) throw new Error('cannot restore the actual Pause control');
      element.appendChild(control);
    }, pause);
  }
}

async function beginWithPauseProof(page: Page, mode: Mode, config: ModeConfig): Promise<void> {
  await press(page, startControl(mode));
  if (mode === 'meditation_timer') await missingPauseIsRejected(page, config);
}

function timedMinutes(config: ModeConfig): number | null {
  switch (config.mode) {
    case 'meditation_timer':
    case 'interval_bell':
    case 'random_interval_bell':
      return config.duration_minutes;
    case 'metronome':
      return config.timer.duration_minutes;
    case 'tarot':
    case 'card_meditation':
      return config.per_card_minutes ?? 5;
    default:
      return null;
  }
}
async function complete(page: Page, config: ModeConfig): Promise<number> {
  const plan = timedMinutes(config);
  if (plan !== null) {
    await page.clock.fastForward((plan * MINUTE) / 2);
    await pauseOnce(page, config);
    await page.clock.fastForward((plan * MINUTE) / 2 + 1000);
    return plan;
  }
  const minutes =
    config.mode === 'mindful_anchor' ? config.min_duration_seconds / 60 + 1 : OPEN_MINUTES;
  await page.clock.fastForward((minutes * MINUTE) / 2);
  await pauseOnce(page, config);
  await page.clock.fastForward((minutes * MINUTE) / 2);
  await finishUntimed(page, config);
  return minutes;
}
async function finishUntimed(page: Page, config: ModeConfig): Promise<void> {
  switch (config.mode) {
    case 'count_up':
      await press(page, 'count-up-end');
      break;
    case 'mindful_anchor':
      await press(page, 'mindful-anchor-save');
      break;
    case 'rep_counter':
      for (let n = 0; n < config.target_reps; n++) await press(page, 'rep-counter-tap-zone');
      break;
    case 'sense_grounding':
      for (let n = 0; n < config.prompts.length; n++) await press(page, 'sense-grounding-advance');
      break;
    case 'tallied_grounding': {
      const items =
        config.rounds * config.categories.reduce((n, category) => n + category.target_count, 0);
      for (let n = 0; n < items; n++) await press(page, 'tallied-grounding-advance');
      break;
    }
  }
}
function paired<M extends Mode>(
  mode: M,
  config: ModeConfig,
  metadata: SessionMetadata,
): {
  config: Extract<ModeConfig, { mode: M }>;
  metadata: Extract<SessionMetadata, { mode: M }>;
} {
  expect(config.mode).toBe(mode);
  expect(metadata.mode).toBe(mode);
  return {
    config: config as Extract<ModeConfig, { mode: M }>,
    metadata: metadata as Extract<SessionMetadata, { mode: M }>,
  };
}
type MetadataAssertion = (
  config: ModeConfig,
  metadata: SessionMetadata,
  cardName: string | null,
) => void;
const METADATA_ASSERTIONS: Record<Mode, MetadataAssertion> = {
  meditation_timer: (_config, metadata) => expect(metadata).toEqual({ mode: 'meditation_timer' }),
  count_up: (_config, metadata) => expect(metadata).toEqual({ mode: 'count_up' }),
  sense_grounding: (input, kept) => {
    const { config, metadata } = paired('sense_grounding', input, kept);
    expect(metadata.senses_completed).toEqual(config.prompts.map((prompt) => prompt.sense));
  },
  tallied_grounding: (input, kept) => {
    const { config, metadata } = paired('tallied_grounding', input, kept);
    expect(metadata).toMatchObject({
      rounds_completed: config.rounds,
      total_rounds: config.rounds,
      items_completed: config.rounds * config.categories.reduce((n, c) => n + c.target_count, 0),
    });
  },
  metronome: (input, kept) => {
    const { config, metadata } = paired('metronome', input, kept);
    expect(metadata.bpm_used).toBe(config.bpm);
  },
  rep_counter: (input, kept) => {
    const { config, metadata } = paired('rep_counter', input, kept);
    expect(metadata.rep_count).toBe(config.target_reps);
  },
  interval_bell: (input, kept) => {
    const { metadata } = paired('interval_bell', input, kept);
    expect(metadata).toMatchObject({ intervals_struck: 3, total_intervals: 3 });
  },
  random_interval_bell: (input, kept) => {
    const { config, metadata } = paired('random_interval_bell', input, kept);
    expect(metadata.bells_struck).toBeGreaterThan(0);
    expect(metadata.interval_seconds).toHaveLength(metadata.bells_struck);
    for (const seconds of metadata.interval_seconds) {
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(config.min_interval_seconds);
      expect(seconds).toBeLessThanOrEqual(config.max_interval_seconds);
    }
  },
  tarot: (input, kept) => {
    const { metadata } = paired('tarot', input, kept);
    expect(Number.isInteger(metadata.card_index)).toBe(true);
    expect(metadata.card_index).toBeGreaterThanOrEqual(0);
    expect(metadata.card_index).toBeLessThan(22);
  },
  card_meditation: (input, kept, cardName) => {
    const { metadata } = paired('card_meditation', input, kept);
    expect(metadata.deck_id).toBe('rws');
    expect(metadata.card_drawn_name).toBe(cardName);
    expect(Number.isInteger(metadata.card_drawn_index)).toBe(true);
    expect(metadata.card_drawn_index).toBeGreaterThanOrEqual(0);
    expect(metadata.card_drawn_index).toBeLessThan(78);
  },
  mindful_anchor: (input, kept) => {
    const { config, metadata } = paired('mindful_anchor', input, kept);
    expect(metadata.chosen_option_key).toBe(config.options[0]?.key ?? null);
    expect(metadata.met_min_duration).toBe(true);
    expect(metadata.duration_seconds).toBeGreaterThanOrEqual(config.min_duration_seconds);
  },
};

for (const [mode, family] of Object.entries(FAMILIES) as Array<[Mode, Family]>) {
  test(`${mode} is selected or created through the UI, completed and persisted`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.clock.install({ time: Date.now() - CLOCK_BEHIND });
    const email = await signUp(page, `repertoire-${mode}`);
    const { token, timezone } = await sessionFor(page.request, email);
    if (family.stage > 1) {
      const before = STAGE_DURATIONS_DAYS.slice(0, family.stage - 1).reduce(
        (n, days) => n + days,
        0,
      );
      setProgramAnchorDaysAgo(email, before + 5);
      await page.reload();
    }
    await openPractice(page);
    const practice = family.preset
      ? await selectPreset(page, token, family)
      : await createDefault(page, mode);
    expect(practice.mode).toBe(mode);
    const adoption = await currentAdoption(page, token, practice);
    await page.reload();
    await openPractice(page);
    await expect(page.getByTestId('practice-identity-title')).toHaveText(practice.name);
    await expect(page.getByTestId(family.view)).toBeVisible();
    expect(await currentAdoption(page, token, practice)).toEqual(adoption);
    const config = practice.mode_config;
    if (config.mode === 'mindful_anchor' && config.options[0])
      await press(page, `mindful-anchor-option-${config.options[0].key}`);
    const cardName =
      mode === 'card_meditation'
        ? await page.getByTestId('card-meditation-card-name').innerText()
        : null;
    await frames(page, testInfo, 'idle', startControl(mode), mode);
    const posts: PracticeSessionCreate[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/practice-sessions/' && request.method() === 'POST')
        posts.push(request.postDataJSON() as PracticeSessionCreate);
    });
    await cancelAndRestart(page, mode);
    expect(posts).toHaveLength(0);
    if (config.mode === 'mindful_anchor' && config.options[0]) {
      if (config.require_option_choice)
        await expect(page.getByTestId('mindful-anchor-begin')).toBeDisabled();
      await press(page, `mindful-anchor-option-${config.options[0].key}`);
    }
    await beginWithPauseProof(page, mode, config);
    const expectedMinutes = await complete(page, config);
    await expect(page.getByTestId('insight-capture-modal')).toBeVisible();
    await frames(page, testInfo, 'complete', 'insight-skip', mode);
    const saved = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === '/practice-sessions/' &&
        reply.request().method() === 'POST',
    );
    await press(page, 'insight-skip');
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    const session = (await response.json()) as SavedSession;
    expect(session).toMatchObject({ user_practice_id: adoption.id, mode, completed: true });
    METADATA_ASSERTIONS[mode](config, session.mode_metadata, cardName);
    expect(posts).toHaveLength(1);
    const sent = posts[0];
    expect(sent).toBeDefined();
    if (!sent) throw new Error('the UI did not post its sitting');
    expect(sent).not.toHaveProperty('duration_minutes');
    expect(sent.mode_metadata).toEqual(session.mode_metadata);
    const minutes = (Date.parse(sent.ended_at) - Date.parse(sent.started_at)) / MINUTE;
    expect(Math.abs(minutes - expectedMinutes)).toBeLessThan(DURATION_TOLERANCE);
    expect(session.duration_minutes).toBeCloseTo(minutes, 5);
    await page.reload();
    const history = await page.request.get(
      `${backendUrl()}/practice-sessions/?user_practice_id=${adoption.id}`,
      { headers: bearer(token) },
    );
    expect(history.ok()).toBe(true);
    expect(await history.json()).toEqual([session]);
    await laterTarotCardFits(page, testInfo, mode, adoption, timezone);
    expect(posts).toHaveLength(1);
  });
}
