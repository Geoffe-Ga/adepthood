import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { preserveLegacyDeclineOwner } from '../declineOwnership';
import {
  loadLinkHabitNudgeDeclined,
  restoreLinkHabitNudge,
  saveLinkHabitNudgeDeclined,
} from '../linkHabitNudgeStorage';
import {
  loadMorningPagesTipState,
  restoreMorningPagesTip,
  saveMorningPagesTipNeverOffer,
} from '../morningPagesTipStorage';
import { loadReflectionDismissed, saveReflectionDismissed } from '../reflectionDismissalStorage';
import { setActiveUser } from '../userScope';
import { loadWritingOfferAnswered, saveWritingOfferAnswered } from '../writingOfferStorage';

const mockRows = new Map<string, string>();
/** Keys whose removal keeps failing, even across a simulated app restart. */
const mockStuckKeys = new Set<string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockRows.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockRows.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    if (mockStuckKeys.has(key)) throw new Error('remove interrupted');
    mockRows.delete(key);
  }),
}));

const LEGACY_OWNER_KEY = '@adepthood/legacy_decline_owner';
const OWNER_ONE_PROVENANCE = JSON.stringify({ version: 1, owner: 1 });

const DECLINES = [
  {
    name: 'finished writing',
    baseKey: '@adepthood/writing_habit_offer_answered',
    decline: () => saveWritingOfferAnswered(true),
    read: loadWritingOfferAnswered,
    restore: () => saveWritingOfferAnswered(false),
  },
  {
    name: 'link a habit',
    baseKey: '@adepthood/link_habit_nudge_never_offer',
    decline: saveLinkHabitNudgeDeclined,
    read: loadLinkHabitNudgeDeclined,
    restore: restoreLinkHabitNudge,
  },
  {
    name: 'morning pages',
    baseKey: '@adepthood/morning_pages_tip_never_offer',
    decline: () => saveMorningPagesTipNeverOffer(true),
    read: async () => (await loadMorningPagesTipState()).neverOffer,
    restore: restoreMorningPagesTip,
  },
  {
    name: 'reflection episode',
    baseKey: '@adepthood/reflection_dismissed:week-2026-42',
    decline: () => saveReflectionDismissed('week-2026-42', true),
    read: () => loadReflectionDismissed('week-2026-42'),
    restore: () => saveReflectionDismissed('week-2026-42', false),
  },
];

interface RestartedApp {
  setActiveUser: typeof setActiveUser;
  reads: Record<string, () => Promise<boolean>>;
}

/** Fresh module instances with no in-memory state: only storage survives. */
function loadAfterRestart(): RestartedApp {
  let app: RestartedApp | null = null;
  jest.isolateModules(() => {
    const scope = require('../userScope') as { setActiveUser: typeof setActiveUser };
    const writing = require('../writingOfferStorage') as {
      loadWritingOfferAnswered: typeof loadWritingOfferAnswered;
    };
    const link = require('../linkHabitNudgeStorage') as {
      loadLinkHabitNudgeDeclined: typeof loadLinkHabitNudgeDeclined;
    };
    const morning = require('../morningPagesTipStorage') as {
      loadMorningPagesTipState: typeof loadMorningPagesTipState;
    };
    const reflection = require('../reflectionDismissalStorage') as {
      loadReflectionDismissed: typeof loadReflectionDismissed;
    };
    app = {
      setActiveUser: scope.setActiveUser,
      reads: {
        '@adepthood/writing_habit_offer_answered': writing.loadWritingOfferAnswered,
        '@adepthood/link_habit_nudge_never_offer': link.loadLinkHabitNudgeDeclined,
        '@adepthood/morning_pages_tip_never_offer': async () =>
          (await morning.loadMorningPagesTipState()).neverOffer,
        '@adepthood/reflection_dismissed:week-2026-42': () =>
          reflection.loadReflectionDismissed('week-2026-42'),
      },
    };
  });
  if (app === null) throw new Error('isolated modules did not load');
  return app;
}

beforeEach(() => {
  mockRows.clear();
  mockStuckKeys.clear();
  jest.clearAllMocks();
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
  jest.restoreAllMocks();
});

describe.each(DECLINES)('$name device-local choice ownership', ({ decline, read, restore }) => {
  it('keeps A’s decline and restore independent of B on the same device', async () => {
    await decline();
    expect(await read()).toBe(true);
    setActiveUser(2);
    expect(await read()).toBe(false);
    await decline();
    setActiveUser(1);
    expect(await read()).toBe(true);
    await restore();
    expect(await read()).toBe(false);
    setActiveUser(2);
    expect(await read()).toBe(true);
  });
});

describe.each(DECLINES)('$name legacy-owner migration', ({ baseKey, read }) => {
  it('preserves a legacy decline positively attributed before the device stamp changed', async () => {
    mockRows.set('@adepthood/legacy_decline_owner', JSON.stringify({ version: 1, owner: 1 }));
    mockRows.set(baseKey, 'true');
    expect(await read()).toBe(true);
    expect(mockRows.get(`${baseKey}#u1`)).toBe('true');
    expect(mockRows.has(baseKey)).toBe(false);
  });

  it('keeps unknown legacy bytes without assigning them to the incoming account', async () => {
    mockRows.set(baseKey, 'true');
    expect(await read()).toBe(false);
    expect(mockRows.get(baseKey)).toBe('true');
    expect(mockRows.has(`${baseKey}#u1`)).toBe(false);
  });

  it('keeps an explicit scoped restore instead of an old global decline', async () => {
    mockRows.set('@adepthood/legacy_decline_owner', JSON.stringify({ version: 1, owner: 1 }));
    mockRows.set(baseKey, 'true');
    mockRows.set(`${baseKey}#u1`, 'false');
    expect(await read()).toBe(false);
    expect(mockRows.get(`${baseKey}#u1`)).toBe('false');
  });
});

describe('legacy provenance durability', () => {
  it('records the prior owner once, before any later owner can replace it', async () => {
    expect(await preserveLegacyDeclineOwner(1)).toBe(true);
    expect(await preserveLegacyDeclineOwner(2)).toBe(true);
    expect(JSON.parse(mockRows.get('@adepthood/legacy_decline_owner')!)).toEqual({
      version: 1,
      owner: 1,
    });
  });
  it('keeps an unstamped upgrade unassigned on every subsequent sign-in', async () => {
    expect(await preserveLegacyDeclineOwner(null)).toBe(true);
    expect(await preserveLegacyDeclineOwner(1)).toBe(true);
    mockRows.set('@adepthood/writing_habit_offer_answered', 'true');
    expect(await loadWritingOfferAnswered()).toBe(false);
    expect(mockRows.get('@adepthood/writing_habit_offer_answered')).toBe('true');
  });
  it('refuses stamp replacement when recording provenance fails', async () => {
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await preserveLegacyDeclineOwner(null)).toBe(false);
    expect(mockRows.has('@adepthood/legacy_decline_owner')).toBe(false);
  });
});

describe.each(DECLINES)('$name interrupted migration', ({ baseKey, read }) => {
  it('retains the original row when the scoped write fails, then retries safely', async () => {
    mockRows.set('@adepthood/legacy_decline_owner', JSON.stringify({ version: 1, owner: 1 }));
    mockRows.set(baseKey, 'true');
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    expect(await read()).toBe(false);
    expect(mockRows.get(baseKey)).toBe('true');
    expect(await read()).toBe(true);
  });
});

describe.each(DECLINES)('$name restore during migration', ({ baseKey, read, restore }) => {
  it('keeps a Settings restore that starts while the legacy write is pending', async () => {
    mockRows.set('@adepthood/legacy_decline_owner', JSON.stringify({ version: 1, owner: 1 }));
    mockRows.set(baseKey, 'true');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
      await held;
      mockRows.set(key, value);
    });
    const migrating = read();
    for (let tick = 0; tick < 15; tick += 1) await Promise.resolve();
    const restoring = restore();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    release();
    await Promise.all([migrating, restoring]);
    expect(await read()).toBe(false);
  });
});

describe.each(DECLINES)(
  '$name copied decline when legacy cleanup fails',
  ({ baseKey, read, restore }) => {
    beforeEach(() => {
      mockRows.set(LEGACY_OWNER_KEY, OWNER_ONE_PROVENANCE);
      mockRows.set(baseKey, 'true');
      mockStuckKeys.add(baseKey);
    });

    it('honours the decline on the very first read after the scoped copy lands', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await read()).toBe(true);
      expect(warn).toHaveBeenCalledWith('storage_clear_failed', { storage: 'user_scope' });
      expect(mockRows.get(`${baseKey}#u1`)).toBe('true');
      expect(mockRows.get(baseKey)).toBe('true');
      expect(await read()).toBe(true);
    });

    it('keeps the stranded legacy row out of another account', async () => {
      expect(await read()).toBe(true);
      setActiveUser(2);
      expect(await read()).toBe(false);
      expect(mockRows.has(`${baseKey}#u2`)).toBe(false);
    });

    it('lets an explicit restore win over the stranded legacy row', async () => {
      expect(await read()).toBe(true);
      await restore();
      expect(await read()).toBe(false);
      expect(await read()).toBe(false);
    });

    it('keeps the decline across a restart while cleanup keeps failing', async () => {
      expect(await read()).toBe(true);
      const restarted = loadAfterRestart();
      restarted.setActiveUser(1);
      try {
        expect(await restarted.reads[baseKey]!()).toBe(true);
        expect(mockRows.get(baseKey)).toBe('true');
      } finally {
        restarted.setActiveUser(null);
      }
    });
  },
);

describe('morning pages legacy dismissal cleanup', () => {
  const LEGACY_DISMISSED = '@adepthood/morning_pages_tip_dismissed';

  it('keeps the carried-over never-offer when the scoped legacy row cannot be removed', async () => {
    mockRows.set(`${LEGACY_DISMISSED}#u1`, 'true');
    mockStuckKeys.add(`${LEGACY_DISMISSED}#u1`);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await loadMorningPagesTipState()).neverOffer).toBe(true);
    expect(warn).toHaveBeenCalledWith('storage_clear_failed', { storage: 'morning_pages' });
    expect(mockRows.get('@adepthood/morning_pages_tip_never_offer#u1')).toBe('true');
    expect((await loadMorningPagesTipState()).neverOffer).toBe(true);
  });

  it('keeps a positively attributed global dismissal when neither legacy row can be removed', async () => {
    mockRows.set(LEGACY_OWNER_KEY, OWNER_ONE_PROVENANCE);
    mockRows.set(LEGACY_DISMISSED, 'true');
    mockStuckKeys.add(LEGACY_DISMISSED);
    mockStuckKeys.add(`${LEGACY_DISMISSED}#u1`);
    expect((await loadMorningPagesTipState()).neverOffer).toBe(true);
    expect(await restoreMorningPagesTip()).toBe(false);
    mockStuckKeys.clear();
    expect(await restoreMorningPagesTip()).toBe(true);
    expect((await loadMorningPagesTipState()).neverOffer).toBe(false);
  });
});
