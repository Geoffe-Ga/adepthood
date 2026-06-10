import { describe, expect, it } from '@jest/globals';

import { ALLOWED_SENSES } from '../../engine/validation';
import {
  GROUNDING_CATALOG,
  GROUNDING_GROUPS,
  findGroundingOption,
  searchGroundingCatalog,
} from '../groundingCatalog';

describe('groundingCatalog', () => {
  it('exposes a non-trivial, uniquely-keyed catalogue', () => {
    expect(GROUNDING_CATALOG.length).toBeGreaterThan(20);
    const ids = GROUNDING_CATALOG.map((opt) => opt.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps every option onto a real backend sense and known group', () => {
    for (const opt of GROUNDING_CATALOG) {
      expect(ALLOWED_SENSES).toContain(opt.sense);
      expect(GROUNDING_GROUPS).toContain(opt.group);
      expect(opt.label.trim().length).toBeGreaterThan(0);
      expect(opt.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers all five senses and the colours/shapes history examples', () => {
    const senses = new Set(GROUNDING_CATALOG.map((opt) => opt.sense));
    expect(senses).toEqual(new Set(['sight', 'touch', 'hearing', 'smell', 'taste']));
    const groups = new Set(GROUNDING_CATALOG.map((opt) => opt.group));
    expect(groups).toContain('Colours');
    expect(groups).toContain('Shapes');
  });

  it('returns the whole catalogue for an empty query', () => {
    expect(searchGroundingCatalog('')).toEqual(GROUNDING_CATALOG);
    expect(searchGroundingCatalog('   ')).toEqual(GROUNDING_CATALOG);
  });

  it('filters case-insensitively across label, prompt, group and sense', () => {
    const red = searchGroundingCatalog('RED');
    expect(red.some((opt) => opt.id === 'colour_red')).toBe(true);
    expect(red.every((opt) => /red/i.test(`${opt.label} ${opt.prompt}`))).toBe(true);

    const byGroup = searchGroundingCatalog('shape');
    expect(byGroup.length).toBeGreaterThan(0);
    expect(byGroup.every((opt) => opt.group === 'Shapes')).toBe(true);

    const bySense = searchGroundingCatalog('hearing');
    expect(bySense.every((opt) => opt.sense === 'hearing')).toBe(true);
  });

  it('returns nothing for a query that matches no option', () => {
    expect(searchGroundingCatalog('zzzzzz-nope')).toEqual([]);
  });

  it('matches a stored prompt back to its catalogue option', () => {
    const match = findGroundingOption('sight', 'something blue');
    expect(match?.id).toBe('colour_blue');
    expect(findGroundingOption('taste', 'something blue')).toBeUndefined();
    expect(findGroundingOption('sight', 'a label nobody catalogued')).toBeUndefined();
  });
});
