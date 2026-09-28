import { describe, expect, it } from '@jest/globals';

import {
  LOADED_TIER_STATE,
  carriedTierEscalation,
  confirmTierWrite,
  knownTier,
  reconcileUnloadedDraft,
  shouldReloadEntryOnReconnect,
  type EntryReloadGate,
} from '../journalReconnectLoad';

import type { JournalClassification } from '@/api';

const OPEN: EntryReloadGate = {
  wasOnline: false,
  isOnline: true,
  hasEntryId: true,
  loaded: false,
  loadFailed: true,
  inFlight: false,
};

describe('shouldReloadEntryOnReconnect (#2935)', () => {
  it('reloads a failed, unloaded, idle entry on the offline -> online edge', () => {
    expect(shouldReloadEntryOnReconnect(OPEN)).toBe(true);
  });

  it.each<[string, Partial<EntryReloadGate>]>([
    ['it was already online (no edge)', { wasOnline: true }],
    ['the device is still offline', { isOnline: false }],
    ['it is going offline', { wasOnline: true, isOnline: false }],
    ['the page is a fresh entry with no id', { hasEntryId: false }],
    ['the entry already loaded', { loaded: true }],
    ['the last load did not fail (still pending)', { loadFailed: false }],
    ['a load is already in flight', { inFlight: true }],
  ])('does not reload when %s', (_why, patch) => {
    expect(shouldReloadEntryOnReconnect({ ...OPEN, ...patch })).toBe(false);
  });
});

const SERVER = { title: 'Rivers', body: 'A page about rivers.' };
const BLANK = { title: '', body: '' };

describe('reconcileUnloadedDraft (#2935)', () => {
  it('applies the server copy exactly on an untouched page', () => {
    expect(reconcileUnloadedDraft(SERVER, BLANK, BLANK)).toEqual({ ...SERVER, carried: false });
  });

  it('treats a page still holding its pre-fill as untouched', () => {
    const prefill = { title: 'Prompt', body: 'Seeded words.' };
    expect(reconcileUnloadedDraft(SERVER, prefill, prefill)).toEqual({
      ...SERVER,
      carried: false,
    });
  });

  it('appends body text typed while unloaded below the stored body', () => {
    expect(reconcileUnloadedDraft(SERVER, { title: '', body: 'Typed offline.' }, BLANK)).toEqual({
      title: 'Rivers',
      body: 'A page about rivers.\n\nTyped offline.',
      carried: true,
    });
  });

  it('lets the typed body stand alone when the stored body is empty', () => {
    const server = { title: 'Rivers', body: '' };
    expect(reconcileUnloadedDraft(server, { title: '', body: 'Typed offline.' }, BLANK)).toEqual({
      title: 'Rivers',
      body: 'Typed offline.',
      carried: true,
    });
  });

  it('adopts a typed title when the stored entry has none', () => {
    const server = { title: '', body: 'A page about rivers.' };
    expect(reconcileUnloadedDraft(server, { title: 'Streams', body: '' }, BLANK)).toEqual({
      title: 'Streams',
      body: 'A page about rivers.',
      carried: true,
    });
  });

  it('ignores a typed title identical to the stored one', () => {
    expect(reconcileUnloadedDraft(SERVER, { title: 'Rivers', body: '' }, BLANK)).toEqual({
      ...SERVER,
      carried: false,
    });
  });

  it('keeps the stored title and leads the carried block with a differing typed title', () => {
    expect(
      reconcileUnloadedDraft(SERVER, { title: 'Streams', body: 'Typed offline.' }, BLANK),
    ).toEqual({
      title: 'Rivers',
      body: 'A page about rivers.\n\nStreams\nTyped offline.',
      carried: true,
    });
  });

  it('carries a differing typed title on its own when no body was typed', () => {
    expect(reconcileUnloadedDraft(SERVER, { title: 'Streams', body: '' }, BLANK)).toEqual({
      title: 'Rivers',
      body: 'A page about rivers.\n\nStreams',
      carried: true,
    });
  });

  it('carries nothing for whitespace-only typing', () => {
    expect(reconcileUnloadedDraft(SERVER, { title: '  ', body: ' \n ' }, BLANK)).toEqual({
      ...SERVER,
      carried: false,
    });
  });

  it('never adopts a whitespace-only title over an empty stored title', () => {
    const server = { title: '', body: 'A page about rivers.' };
    expect(reconcileUnloadedDraft(server, { title: '   ', body: '' }, BLANK)).toEqual({
      ...server,
      carried: false,
    });
  });

  it('never lets a cleared local buffer blank the stored copy', () => {
    const prefill = { title: 'Prompt', body: 'Seeded words.' };
    expect(reconcileUnloadedDraft(SERVER, BLANK, prefill)).toEqual({ ...SERVER, carried: false });
  });
});

describe('carriedTierEscalation (#2935)', () => {
  it.each<[JournalClassification, JournalClassification, JournalClassification | null]>([
    ['public', 'personal', 'personal'],
    ['public', 'intimate', 'intimate'],
    ['personal', 'intimate', 'intimate'],
    ['personal', 'personal', null],
    ['intimate', 'personal', null],
    ['intimate', 'public', null],
    ['personal', 'public', null],
  ])('stored %s, typed under %s -> %s', (stored, typedUnder, expected) => {
    expect(carriedTierEscalation(stored, typedUnder)).toBe(expected);
  });
});

describe('confirmTierWrite / knownTier (#2935)', () => {
  const ok = (seq: number, stored: JournalClassification) => ({ seq, ok: true as const, stored });
  const fail = (seq: number) => ({ seq, ok: false as const });

  it('starts at the loaded tier, known', () => {
    expect(knownTier(LOADED_TIER_STATE, 'public')).toBe('public');
  });

  it('follows a newer success', () => {
    expect(knownTier(confirmTierWrite(LOADED_TIER_STATE, ok(1, 'personal')), 'public')).toBe(
      'personal',
    );
  });

  it('ignores a success older than the one it already has (out-of-order response)', () => {
    const newer = confirmTierWrite(LOADED_TIER_STATE, ok(2, 'public'));
    expect(knownTier(confirmTierWrite(newer, ok(1, 'personal')), 'public')).toBe('public');
  });

  it('becomes unknown on a newer failure', () => {
    const confirmed = confirmTierWrite(LOADED_TIER_STATE, ok(1, 'personal'));
    expect(knownTier(confirmTierWrite(confirmed, fail(2)), 'public')).toBeNull();
  });

  it('ignores a failure older than its last success', () => {
    const confirmed = confirmTierWrite(LOADED_TIER_STATE, ok(2, 'personal'));
    expect(knownTier(confirmTierWrite(confirmed, fail(1)), 'public')).toBe('personal');
  });

  it('stays unknown on a success older than the failure', () => {
    const unknown = confirmTierWrite(LOADED_TIER_STATE, fail(2));
    expect(knownTier(confirmTierWrite(unknown, ok(1, 'intimate')), 'public')).toBeNull();
  });

  it('is known again on a success newer than the failure', () => {
    const unknown = confirmTierWrite(LOADED_TIER_STATE, fail(1));
    expect(knownTier(confirmTierWrite(unknown, ok(2, 'intimate')), 'public')).toBe('intimate');
  });
});
