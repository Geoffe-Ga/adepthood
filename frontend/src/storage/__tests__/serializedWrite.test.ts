import { beforeEach, describe, expect, it } from '@jest/globals';

import { _resetSerializedWriteForTests, serialize } from '../serializedWrite';

beforeEach(() => {
  _resetSerializedWriteForTests();
});

describe('serialize', () => {
  it('runs writes for the same key in submission order', async () => {
    const order: number[] = [];
    const make = (n: number, delay: number) =>
      new Promise<number>((resolve) => {
        setTimeout(() => {
          order.push(n);
          resolve(n);
        }, delay);
      });

    const p1 = serialize('k', () => make(1, 50));
    const p2 = serialize('k', () => make(2, 5));
    const p3 = serialize('k', () => make(3, 0));

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('isolates chains across keys (different keys run in parallel)', async () => {
    const log: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const a = serialize('a', async () => {
      await sleep(40);
      log.push('a-done');
    });
    const b = serialize('b', async () => {
      await sleep(5);
      log.push('b-done');
    });

    await Promise.all([a, b]);
    expect(log).toEqual(['b-done', 'a-done']);
  });

  it('propagates a rejection to its caller without poisoning the next write', async () => {
    const fail = serialize('k', async () => {
      throw new Error('first failed');
    });
    const succeed = serialize('k', async () => 'ok');

    await expect(fail).rejects.toThrow('first failed');
    await expect(succeed).resolves.toBe('ok');
  });

  it('serializes a read-modify-write pattern so concurrent appenders never lose data', async () => {
    const store: { items: number[] } = { items: [] };
    const append = (n: number) =>
      serialize('rmw', async () => {
        const snapshot = [...store.items];
        await new Promise((r) => setTimeout(r, 5));
        snapshot.push(n);
        store.items = snapshot;
      });

    await Promise.all([append(1), append(2), append(3), append(4), append(5)]);

    expect(store.items).toEqual([1, 2, 3, 4, 5]);
  });
});
