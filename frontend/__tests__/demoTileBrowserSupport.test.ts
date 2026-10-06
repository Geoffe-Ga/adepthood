import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  DEMO_SEED_TOAST,
  FORBIDDEN_DEMO_WIRE,
  HABITS_CACHE_PREFIX,
  HABITS_UNREACHABLE,
  LOADING_STATS,
  SYNC_FAILURE_TITLE,
  forbiddenDemoRequests,
  isHabitsListGet,
} from '../e2e/demoTileBrowserSupport';

/**
 * The demo-tile journey's classifiers (#2491). The browser spec's load-bearing
 * claim is that NO request put a demo tile's fabricated id on the wire, and an
 * absence is only as good as the pattern that looks for it: a typo'd anchor or
 * a dropped entry would let the spec pass while the leak it guards against
 * happened. So every forbidden route is shown matching here, at both ends of
 * the demo id range, and every near miss is shown not matching.
 */

const API = 'http://127.0.0.1:8123';
/** The demo-configured frontend's origin: it serves its own `/habits/` route. */
const FRONTEND = 'http://localhost:8080';
const SRC = join(__dirname, '..', 'src');

/** One concrete request for each forbidden route, with `id` in every id slot. */
function concrete(id: number): Array<{ method: string; url: string; label: string }> {
  return [
    { method: 'PUT', url: `${API}/habits/${id}`, label: `PUT /habits/${id}` },
    { method: 'DELETE', url: `${API}/habits/${id}`, label: `DELETE /habits/${id}` },
    {
      method: 'DELETE',
      url: `${API}/habits/${id}/completions`,
      label: `DELETE /habits/${id}/completions`,
    },
    {
      method: 'PUT',
      url: `${API}/habits/${id}/goals/units`,
      label: `PUT /habits/${id}/goals/units`,
    },
    { method: 'PUT', url: `${API}/goals/${id}`, label: `PUT /goals/${id}` },
    { method: 'POST', url: `${API}/goal_completions/`, label: 'POST /goal_completions/' },
    { method: 'GET', url: `${API}/habits/${id}/stats`, label: `GET /habits/${id}/stats` },
  ];
}

describe('forbiddenDemoRequests', () => {
  it('names one concrete request per forbidden route', () => {
    expect(concrete(1)).toHaveLength(FORBIDDEN_DEMO_WIRE.length);
  });

  it.each([1, 10])('flags every forbidden route for demo id %i on the API origin', (id) => {
    for (const request of concrete(id)) {
      expect(forbiddenDemoRequests([request], API)).toEqual([request.label]);
    }
  });

  it('flags a query-string variant by its pathname', () => {
    expect(
      forbiddenDemoRequests([{ method: 'GET', url: `${API}/habits/3/stats?x=1` }], API),
    ).toEqual(['GET /habits/3/stats']);
  });

  it.each([
    ['the habit list read', 'GET', `${API}/habits/`],
    ['the habit list read with a query', 'GET', `${API}/habits/?paginate=true`],
    ['a new habit', 'POST', `${API}/habits/`],
    ['a per-habit read that is not stats', 'GET', `${API}/habits/3`],
    ['the stats path with another method', 'POST', `${API}/habits/3/stats`],
    ['the completions path with another method', 'GET', `${API}/goal_completions/`],
    ['a deeper path under a forbidden one', 'PUT', `${API}/habits/3/extra`],
    ['the frontend origin', 'DELETE', `${FRONTEND}/habits/3`],
    ['the frontend origin', 'PUT', `${FRONTEND}/goals/3`],
  ])('passes %s (%s %s)', (_name, method, url) => {
    expect(forbiddenDemoRequests([{ method, url }], API)).toEqual([]);
  });
});

describe('isHabitsListGet', () => {
  it.each([`${API}/habits/`, `${API}/habits/?paginate=true&limit=50`])('matches GET %s', (url) => {
    expect(isHabitsListGet('GET', url, API)).toBe(true);
  });

  it.each([
    ['GET', `${API}/habits/3`],
    ['GET', `${API}/habits/3/stats`],
    ['POST', `${API}/habits/`],
    ['GET', `${FRONTEND}/habits/`],
    ['GET', `${FRONTEND}/habits`],
  ])('leaves %s %s alone', (method, url) => {
    expect(isHabitsListGet(method, url, API)).toBe(false);
  });
});

describe('the copy the spec looks for is the copy the app shows', () => {
  it.each([
    [DEMO_SEED_TOAST, 'features/Habits/hooks/useHabitActions.ts'],
    [HABITS_UNREACHABLE, 'api/errorMessages.ts'],
    [SYNC_FAILURE_TITLE, 'features/Habits/services/habitManager.ts'],
    [LOADING_STATS, 'features/Habits/components/StatsModal.tsx'],
    [HABITS_CACHE_PREFIX, 'storage/habitStorage.ts'],
  ])('%s appears in src/%s', (copy, file) => {
    expect(readFileSync(join(SRC, file), 'utf8')).toContain(copy);
  });
});
