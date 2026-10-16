/* eslint-env jest */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useAuthLineage } from '../useAuthLineage';

import { beginAuthSession } from '@/api/sessionToken';
import { setActiveUser } from '@/storage/userScope';

/**
 * #3452: every term of the session-lineage fence, one at a time.
 *
 * Each refusal below moves exactly one thing, so removing the term that
 * catches it turns that case green-to-red on its own: the captured session,
 * the account scope (owner and generation), the render-time lineage epoch,
 * the authenticated status and the credential's owner. The renewal case moves
 * only the token and must keep the fence, and its identity.
 */
type Status = 'authenticated' | 'reauth-required' | 'anonymous';
let mockAuth: { token: string | null; authStatus: Status };

jest.mock('@/context/AuthContext', () => ({ useAuth: () => mockAuth }));

const OWNER = 1;
const OTHER = 2;
const tokenFor = (owner: number, jti: string): string =>
  `e30.${btoa(JSON.stringify({ sub: String(owner), exp: 4_000_000_000, jti })).replaceAll('=', '')}.sig`;

function mount() {
  const view = renderHook(() => useAuthLineage());
  return { view, lineage: () => view.result.current };
}

beforeEach(() => {
  setActiveUser(OWNER);
  mockAuth = { token: tokenFor(OWNER, 'first'), authStatus: 'authenticated' };
});

describe('useAuthLineage', () => {
  test('a renewal keeps the fence, its identity and the epoch', () => {
    const { view, lineage } = mount();
    const before = lineage();
    expect(before.isCurrent()).toBe(true);

    mockAuth = { ...mockAuth, token: tokenFor(OWNER, 'renewed') };
    view.rerender({});

    expect(lineage()).toBe(before);
    expect(before.isCurrent()).toBe(true);
  });

  test('a session boundary refuses at once, before any render (captured session)', () => {
    const { lineage } = mount();
    const fence = lineage().isCurrent;

    act(() => {
      beginAuthSession();
    });

    expect(fence()).toBe(false);
  });

  test('another account refuses at once, before any render (owner)', () => {
    const { lineage } = mount();
    const fence = lineage().isCurrent;

    setActiveUser(OTHER);

    expect(fence()).toBe(false);
  });

  test('A to B to A refuses at once, before any render (generation)', () => {
    const { lineage } = mount();
    const fence = lineage().isCurrent;

    setActiveUser(OTHER);
    setActiveUser(OWNER);

    expect(fence()).toBe(false);
  });

  test('a rendered status change ends the lineage even with the session unmoved (epoch)', () => {
    const { view, lineage } = mount();
    const before = lineage();

    mockAuth = { ...mockAuth, authStatus: 'reauth-required' };
    view.rerender({});
    mockAuth = { ...mockAuth, authStatus: 'authenticated' };
    view.rerender({});

    expect(lineage().epoch).not.toBe(before.epoch);
    expect(before.isCurrent()).toBe(false);
    expect(lineage().isCurrent()).toBe(true);
  });

  test('a status other than authenticated admits nothing', () => {
    mockAuth = { ...mockAuth, authStatus: 'reauth-required' };
    const { lineage } = mount();

    expect(lineage().isCurrent()).toBe(false);
  });

  test("a credential that is not the active account's admits nothing", () => {
    mockAuth = { ...mockAuth, token: tokenFor(OTHER, 'stray') };
    const { lineage } = mount();

    expect(lineage().isCurrent()).toBe(false);
  });

  test('signed out admits nothing', () => {
    mockAuth = { token: null, authStatus: 'anonymous' };
    const { lineage } = mount();

    expect(lineage().isCurrent()).toBe(false);
  });
});
