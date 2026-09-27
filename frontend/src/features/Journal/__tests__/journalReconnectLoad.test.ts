import { describe, expect, it } from '@jest/globals';

import {
  reconcileUnloadedDraft,
  shouldReloadEntryOnReconnect,
  type EntryReloadGate,
} from '../journalReconnectLoad';

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
