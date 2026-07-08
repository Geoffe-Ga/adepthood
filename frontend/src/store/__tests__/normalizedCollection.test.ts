import { describe, expect, it } from '@jest/globals';

import { createNormalizedById } from '../normalizedCollection';

interface WithId {
  id: number;
  name: string;
}

interface WithCode {
  code: number;
  label: string;
}

const makeItem = (id: number, name: string): WithId => ({ id, name });
const makeCoded = (code: number, label: string): WithCode => ({ code, label });

describe('createNormalizedById', () => {
  it('normalize on an empty array returns empty byId, order, and list', () => {
    const collection = createNormalizedById((item: WithId) => item.id);

    const result = collection.normalize([]);

    expect(result.byId).toEqual({});
    expect(result.order).toEqual([]);
    expect(result.list).toEqual([]);
  });

  it('normalize preserves input order in both order and list for ascending keys', () => {
    const collection = createNormalizedById((item: WithId) => item.id);
    const first = makeItem(1, 'First');
    const second = makeItem(2, 'Second');
    const third = makeItem(3, 'Third');

    const result = collection.normalize([first, second, third]);

    expect(result.order).toEqual([1, 2, 3]);
    expect(result.list).toEqual([first, second, third]);
    expect(result.byId[1]).toEqual(first);
    expect(result.byId[2]).toEqual(second);
    expect(result.byId[3]).toEqual(third);
  });

  it('normalize preserves input order for descending keys, mirroring the stage store', () => {
    const collection = createNormalizedById((item: WithId) => item.id);
    const tenth = makeItem(10, 'Tenth');
    const fifth = makeItem(5, 'Fifth');
    const first = makeItem(1, 'First');

    const result = collection.normalize([tenth, fifth, first]);

    expect(result.order).toEqual([10, 5, 1]);
    expect(result.list).toEqual([tenth, fifth, first]);
  });

  it('normalize is generic over the key field via keyOf', () => {
    const collection = createNormalizedById((item: WithCode) => item.code);
    const alpha = makeCoded(100, 'Alpha');
    const beta = makeCoded(200, 'Beta');

    const result = collection.normalize([alpha, beta]);

    expect(result.order).toEqual([100, 200]);
    expect(result.byId[100]).toEqual(alpha);
    expect(result.byId[200]).toEqual(beta);
  });

  it('normalize returns list as a shallow copy that preserves element references', () => {
    const collection = createNormalizedById((item: WithId) => item.id);
    const input = [makeItem(1, 'First'), makeItem(2, 'Second')];

    const result = collection.normalize(input);

    expect(result.list).not.toBe(input);
    expect(result.list[0]).toBe(input[0]);
    expect(result.list[1]).toBe(input[1]);
  });

  it('normalize keeps the last item on duplicate keys and repeats the key in order', () => {
    const collection = createNormalizedById((item: WithId) => item.id);
    const firstVersion = makeItem(1, 'Original');
    const secondVersion = makeItem(1, 'Overwritten');

    const result = collection.normalize([firstVersion, secondVersion]);

    expect(result.order).toEqual([1, 1]);
    expect(result.byId[1]).toEqual(secondVersion);
    expect(result.byId[1]).not.toEqual(firstVersion);
  });

  it('rebuild maps order through byId preserving element references', () => {
    const collection = createNormalizedById((item: WithId) => item.id);
    const first = makeItem(1, 'First');
    const second = makeItem(2, 'Second');
    const byId: Record<number, WithId> = { 1: first, 2: second };

    const result = collection.rebuild(byId, [2, 1]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });

  it('rebuild silently drops keys absent from byId', () => {
    const collection = createNormalizedById((item: WithId) => item.id);
    const first = makeItem(1, 'First');
    const byId: Record<number, WithId> = { 1: first };

    const result = collection.rebuild(byId, [1, 99, 1]);

    expect(result).toEqual([first, first]);
  });
});
