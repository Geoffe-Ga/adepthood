import { describe, expect, it } from '@jest/globals';

import { taskOrdinalAt, toggleTaskAt, toggleTaskAtOrdinal } from '../toggleTaskAt';

describe('toggleTaskAt', () => {
  it.each([
    ['- [ ] milk', 0, '- [x] milk'],
    ['- [x] milk', 0, '- [ ] milk'],
    ['- [X] milk', 0, '- [ ] milk'],
    ['  - [ ] nested', 0, '  - [x] nested'],
    ['before\n\t- [x] nested', 7, 'before\n\t- [ ] nested'],
  ])('swaps only the task state in %j', (body, lineStart, expected) => {
    const toggled = toggleTaskAt(body, lineStart);

    expect(toggled).toBe(expected);
    expect(Array.from(toggled)).toHaveLength(Array.from(body).length);
    const changed = Array.from(body).flatMap((character, index) =>
      character === Array.from(toggled)[index] ? [] : [index],
    );
    expect(changed).toHaveLength(1);
  });

  it('uses code-point offsets when multibyte prose precedes the task', () => {
    const body = '🌊 café\n- [ ] दूध';
    const lineStart = Array.from(body).indexOf('-');

    expect(toggleTaskAt(body, lineStart)).toBe('🌊 café\n- [x] दूध');
  });

  it('rebases a task ordinal after earlier server text changes length', () => {
    const optimistic = '- [x] milk\n- [ ] bread';
    const second = Array.from(optimistic).lastIndexOf('-');
    const ordinal = taskOrdinalAt(optimistic, second);

    expect(ordinal).toBe(1);
    expect(toggleTaskAtOrdinal('- [x] milk (stored)\n- [ ] bread', ordinal!)).toBe(
      '- [x] milk (stored)\n- [x] bread',
    );
  });

  it.each([
    ['plain prose', 0],
    ['- not a task', 0],
    ['- [ ] task', 1],
    ['- [ ] task', 99],
  ])('leaves non-task or non-line-start input unchanged for %j at %i', (body, lineStart) => {
    expect(toggleTaskAt(body, lineStart)).toBe(body);
  });
});
