import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { useStartHereStore } from '../startHereStore';

import { course, type CourseProgress, type SiteResource } from '@/api';
import { getActiveUser, setActiveUser } from '@/storage/userScope';

let mockSessionToken: string | undefined = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';

jest.mock('@/api', () => ({
  captureSessionToken: () => mockSessionToken,
  course: { siteResources: jest.fn(), startHereProgress: jest.fn() },
}));

const RESOURCES: SiteResource[] = [
  {
    slug: 'about',
    title: 'About',
    description: 'An introduction',
    url: 'content://about',
    order: 1,
    is_read: false,
  },
];
const PROGRESS: CourseProgress = {
  total_items: 1,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(course.siteResources).mockReset();
  jest.mocked(course.startHereProgress).mockReset();
  mockSessionToken = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
  setActiveUser(1);
  useStartHereStore.getState().reset();
  jest.mocked(course.siteResources).mockResolvedValue(RESOURCES);
  jest.mocked(course.startHereProgress).mockResolvedValue(PROGRESS);
});
afterEach(() => {
  setActiveUser(null);
  useStartHereStore.getState().reset();
});

describe('shared confirmed Start Here state', () => {
  it.each([
    ['no credential', undefined],
    ['a malformed credential', 'not-a-session'],
    ['a credential without a subject', 'e30.eyJleHAiOjQxMDI0NDQ4MDB9.signature'],
    ['the previous account credential', 'e30.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature'],
  ])('does not dispatch a new read with %s', async (_label, token) => {
    mockSessionToken = token;
    await expect(useStartHereStore.getState().load()).resolves.toBeNull();
    expect(course.siteResources).not.toHaveBeenCalled();
    expect(course.startHereProgress).not.toHaveBeenCalled();
  });

  it('does not return an earlier ready cache after an A to B to A namespace transition', async () => {
    await useStartHereStore.getState().load();
    setActiveUser(2);
    setActiveUser(1);
    const confirmed = RESOURCES.map((resource) => ({ ...resource, is_read: true }));
    jest.mocked(course.siteResources).mockResolvedValueOnce(confirmed);
    jest
      .mocked(course.startHereProgress)
      .mockResolvedValueOnce({ ...PROGRESS, read_items: 1, progress_percent: 100 });
    const snapshot = await useStartHereStore.getState().load();
    expect(snapshot?.resources).toEqual(confirmed);
    expect(course.siteResources).toHaveBeenLastCalledWith(mockSessionToken);
    expect(course.startHereProgress).toHaveBeenLastCalledWith(mockSessionToken);
  });

  it('does not dispatch into an anonymous namespace with a signed-in credential', async () => {
    setActiveUser(null);
    await expect(useStartHereStore.getState().load()).resolves.toBeNull();
    expect(course.siteResources).not.toHaveBeenCalled();
    expect(course.startHereProgress).not.toHaveBeenCalled();
  });

  it('drops an old response after A to B to A even without an explicit reset', async () => {
    const old = deferred<SiteResource[]>();
    jest.mocked(course.siteResources).mockReturnValueOnce(old.promise);
    const pending = useStartHereStore.getState().load();
    setActiveUser(2);
    setActiveUser(1);
    old.resolve(RESOURCES);
    await expect(pending).resolves.toBeNull();
    expect(useStartHereStore.getState().resources).toEqual([]);
  });

  it('coalesces concurrent list/progress reads and retains the served resource marks', async () => {
    const first = useStartHereStore.getState().load();
    const second = useStartHereStore.getState().load();
    await Promise.all([first, second]);
    expect(course.siteResources).toHaveBeenCalledTimes(1);
    expect(course.startHereProgress).toHaveBeenCalledTimes(1);
    expect(useStartHereStore.getState()).toMatchObject({
      resources: RESOURCES,
      progress: PROGRESS,
      status: 'ready',
    });
  });

  it('does not describe a failed progress read as all read', async () => {
    jest.mocked(course.startHereProgress).mockRejectedValueOnce(new Error('unavailable'));
    await expect(useStartHereStore.getState().load()).resolves.toBeNull();
    expect(useStartHereStore.getState()).toMatchObject({ progress: null, status: 'error' });
  });

  it('rejects old responses after account A to B to A, preserving the new confirmed marks', async () => {
    const old = deferred<SiteResource[]>();
    jest.mocked(course.siteResources).mockReturnValueOnce(old.promise);
    const stale = useStartHereStore.getState().load();
    setActiveUser(2);
    useStartHereStore.getState().reset();
    setActiveUser(1);
    useStartHereStore.getState().reset();
    const confirmed = RESOURCES.map((row) => ({ ...row, is_read: true }));
    jest.mocked(course.siteResources).mockResolvedValueOnce(confirmed);
    jest
      .mocked(course.startHereProgress)
      .mockResolvedValueOnce({ ...PROGRESS, read_items: 1, progress_percent: 100 });
    await useStartHereStore.getState().load();
    old.resolve(RESOURCES);
    await expect(stale).resolves.toBeNull();
    expect(getActiveUser()).toBe(1);
    expect(useStartHereStore.getState().resources).toEqual(confirmed);
  });
});
