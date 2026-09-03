import { describe, expect, it } from '@jest/globals';

import type { Habit, OnboardingHabit } from '../../Habits.types';
import {
  ADD_HABITS_STEP,
  buildMergePlan,
  buildReviewRows,
  eligibleForReview,
  entryStepFor,
  originHabitId,
  poolIdFor,
  releasedRows,
  releaseRow,
  REVIEW_STEP,
  setDestination,
  syncPool,
  toggleKeep,
} from '../onboardingReview';

const MEDITATE = 'Meditate';
const MORNING_PAGES = 'Morning pages';
const COLD_SHOWER = 'Cold shower';

const habit = (over: Partial<Habit> = {}): Habit =>
  ({
    id: 7,
    name: MEDITATE,
    icon: '🧘',
    stage: 'Beige',
    streak: 4,
    revealed: true,
    energy_cost: 3,
    energy_return: 8,
    start_date: new Date('2026-01-01'),
    goals: [],
    completions: [],
    ...over,
  }) as Habit;

const typed = (id: string, name: string): OnboardingHabit => ({
  id,
  name,
  icon: '⭐',
  energy_cost: 5,
  energy_return: 5,
  stage: 'Beige',
  start_date: new Date('2026-06-01'),
});

describe('which habits the review step may ask about', () => {
  it('offers every server-backed habit', () => {
    expect(eligibleForReview([habit(), habit({ id: 8, name: MORNING_PAGES })])).toHaveLength(2);
  });

  it('leaves out a demo placeholder, which is content the user never made', () => {
    expect(eligibleForReview([habit({ isDemoSeed: true })])).toEqual([]);
  });

  it('leaves out a row whose ids this device minted, which names no server row', () => {
    expect(eligibleForReview([habit({ hasClientMintedIds: true })])).toEqual([]);
  });

  it('leaves out the negative placeholder a pre-sync row carries', () => {
    // Not a shape check for its own sake: a DELETE against -1738000000000 names
    // nobody, and a PUT against it names nobody either.
    expect(eligibleForReview([habit({ id: -1738000000000 })])).toEqual([]);
  });

  it('opens a store of nothing but demo tiles exactly as a first run', () => {
    const rows = buildReviewRows([habit({ isDemoSeed: true }), habit({ id: 8, isDemoSeed: true })]);
    expect(rows).toEqual([]);
    expect(entryStepFor(rows)).toBe(ADD_HABITS_STEP);
  });

  it('opens on the review step as soon as there is one habit to ask about', () => {
    expect(entryStepFor(buildReviewRows([habit()]))).toBe(REVIEW_STEP);
  });
});

describe('what each row starts as', () => {
  it('keeps every habit, because a release must follow a choice and never a default', () => {
    expect(buildReviewRows([habit(), habit({ id: 8 })]).every((row) => row.keep)).toBe(true);
  });

  it('defaults a habit already carried from before the program to bring along', () => {
    expect(buildReviewRows([habit({ is_carryover: true })])[0]?.destination).toBe('bring-along');
  });

  it('defaults a habit already in the program lap to re-rate', () => {
    expect(buildReviewRows([habit({ is_carryover: false })])[0]?.destination).toBe('re-rate');
  });

  it('defaults a habit that predates the carryover flag to re-rate', () => {
    expect(buildReviewRows([habit()])[0]?.destination).toBe('re-rate');
  });
});

describe('changing your mind', () => {
  it('unticks and re-ticks a row without losing anything', () => {
    const rows = buildReviewRows([habit()]);
    const off = toggleKeep(rows, 7);
    const back = toggleKeep(off, 7);
    expect(off[0]?.keep).toBe(false);
    expect(back).toEqual(rows);
  });

  it("changes one row's destination and leaves its neighbour alone", () => {
    const rows = buildReviewRows([habit(), habit({ id: 8, name: MORNING_PAGES })]);
    const next = setDestination(rows, 8, 'bring-along');
    expect(next[0]?.destination).toBe('re-rate');
    expect(next[1]?.destination).toBe('bring-along');
  });

  it('names the unticked rows and only those', () => {
    const rows = toggleKeep(buildReviewRows([habit(), habit({ id: 8, name: MORNING_PAGES })]), 8);
    expect(releasedRows(rows).map((row) => row.name)).toEqual([MORNING_PAGES]);
  });

  it('releases a row outright when a chip removal is confirmed', () => {
    expect(releaseRow(buildReviewRows([habit()]), 7)[0]?.keep).toBe(false);
  });
});

describe('the pool a re-rated habit enters', () => {
  it("seeds the chip with the habit's stored ratings rather than the defaults", () => {
    const [pick] = syncPool([], buildReviewRows([habit()]), [habit()]);
    expect(pick?.energy_cost).toBe(3);
    expect(pick?.energy_return).toBe(8);
    expect(pick?.name).toBe(MEDITATE);
    expect(pick?.icon).toBe('🧘');
  });

  it('marks the chip with the row it came from, so the save names that row', () => {
    const [pick] = syncPool([], buildReviewRows([habit()]), [habit()]);
    expect(originHabitId(pick?.id ?? '')).toBe(7);
  });

  it('never seeds a brought-along habit, which is not competing for a slot', () => {
    const rows = setDestination(buildReviewRows([habit()]), 7, 'bring-along');
    expect(syncPool([], rows, [habit()])).toEqual([]);
  });

  it('drops the chip when the user switches that habit to bring along', () => {
    const rows = buildReviewRows([habit()]);
    const pool = syncPool([], rows, [habit()]);
    expect(syncPool(pool, setDestination(rows, 7, 'bring-along'), [habit()])).toEqual([]);
  });

  it('drops the chip when the user unticks that habit', () => {
    const rows = buildReviewRows([habit()]);
    const pool = syncPool([], rows, [habit()]);
    expect(syncPool(pool, toggleKeep(rows, 7), [habit()])).toEqual([]);
  });

  it('keeps a rating the user already changed on a second pass through', () => {
    const rows = buildReviewRows([habit()]);
    const rated = syncPool([], rows, [habit()]).map((pick) => ({ ...pick, energy_cost: 9 }));
    expect(syncPool(rated, rows, [habit()])[0]?.energy_cost).toBe(9);
  });

  it('leaves a habit the user typed themselves entirely alone', () => {
    const rows = buildReviewRows([habit()]);
    const pool = [...syncPool([], rows, [habit()]), typed('mine', COLD_SHOWER)];
    expect(syncPool(pool, rows, [habit()]).map((pick) => pick.name)).toEqual([
      MEDITATE,
      COLD_SHOWER,
    ]);
  });

  it('does not mint a second chip for a habit that already has one', () => {
    const rows = buildReviewRows([habit()]);
    const pool = syncPool([], rows, [habit()]);
    expect(syncPool(pool, rows, [habit()])).toHaveLength(1);
  });
});

describe('the plan the modal hands the save', () => {
  const existing = [
    habit(),
    habit({ id: 8, name: MORNING_PAGES, is_carryover: true }),
    habit({ id: 9, name: COLD_SHOWER }),
  ];

  it("says re-rated for a pooled chip, naming the server's own id", () => {
    const rows = buildReviewRows(existing);
    const pool = syncPool([], rows, existing);
    expect(buildMergePlan(pool, rows, existing)).toContainEqual({
      kind: 're-rated',
      habitId: 7,
      habit: expect.objectContaining({ id: poolIdFor(7), name: MEDITATE }),
    });
  });

  it('says new for a habit the user typed, which names no row', () => {
    const rows = buildReviewRows(existing);
    const plan = buildMergePlan([typed('mine', 'Stretch')], rows, existing);
    expect(plan).toContainEqual({
      kind: 'new',
      habit: expect.objectContaining({ name: 'Stretch' }),
    });
  });

  it('says brought-along for a habit sent to the carryover pages', () => {
    const rows = setDestination(buildReviewRows(existing), 7, 'bring-along');
    const plan = buildMergePlan(syncPool([], rows, existing), rows, existing);
    expect(plan).toContainEqual({
      kind: 'brought-along',
      habitId: 7,
      habit: expect.objectContaining({ name: MEDITATE, energy_cost: 3 }),
    });
  });

  it('says released, and only for a row the user actually unticked', () => {
    const rows = toggleKeep(buildReviewRows(existing), 9);
    const plan = buildMergePlan(syncPool([], rows, existing), rows, existing);
    expect(plan).toContainEqual({ kind: 'released', habitId: 9 });
    expect(plan.filter((d) => d.kind === 'released')).toHaveLength(1);
  });

  it('never derives a release from a habit that is simply absent from the pool', () => {
    // Taking a chip off the add-habits step is not asking to lose the habit.
    // The delete cascades its goals and check-ins and cannot be undone.
    const rows = buildReviewRows(existing);
    const plan = buildMergePlan([], rows, existing);
    expect(plan.some((d) => d.kind === 'released')).toBe(false);
    expect(plan).toContainEqual({ kind: 'retained', habitId: 7 });
  });

  it('decides every reviewed habit exactly once', () => {
    const rows = toggleKeep(setDestination(buildReviewRows(existing), 8, 'bring-along'), 9);
    const plan = buildMergePlan(syncPool([], rows, existing), rows, existing);
    const named = plan.flatMap((d) => ('habitId' in d ? [d.habitId] : []));
    expect(named.sort((a, b) => a - b)).toEqual([7, 8, 9]);
  });

  it('drops a stale chip rather than re-POSTing a name the server still owns', () => {
    // The chip's own row says released, so the row's disposition is the answer;
    // treating the chip as `new` would POST under a name the server has and get
    // back the swallowed 409 this whole flow exists to remove.
    const rows = toggleKeep(buildReviewRows(existing), 7);
    const stale = syncPool([], buildReviewRows(existing), existing).filter(
      (pick) => originHabitId(pick.id) === 7,
    );
    const plan = buildMergePlan(stale, rows, existing);
    expect(plan.some((d) => d.kind === 'new')).toBe(false);
    expect(plan).toContainEqual({ kind: 'released', habitId: 7 });
  });

  it('hands back bare picks in pool order, ahead of the rows the pool does not carry', () => {
    const rows = setDestination(buildReviewRows(existing), 8, 'bring-along');
    const pool = syncPool([], rows, existing);
    const plan = buildMergePlan([...pool, typed('mine', 'Stretch')], rows, existing);
    expect(plan.map((d) => d.kind)).toEqual(['re-rated', 're-rated', 'new', 'brought-along']);
  });
});
