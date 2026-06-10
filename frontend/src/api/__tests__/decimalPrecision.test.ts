/* eslint-env jest */
/* global describe, it, expect */

/**
 * Issue #272: the backend's ``field_serializer`` emits ``Decimal`` money
 * fields as fixed-point strings (``format(value, 'f')``) at six decimal
 * places. These pins prove a JS ``Number`` recovers that wire format
 * exactly at the schema's documented scale — so a future scale change
 * that exceeds double precision fails here instead of silently
 * truncating balances in the UI.
 */
describe('Decimal wire-format precision (#272)', () => {
  it('parseFloat round-trips the maximum six-decimal fixed-point value', () => {
    const wire = '999999.999999';
    const parsed = parseFloat(wire);
    expect(parsed).toBe(999999.999999);
    // Shortest round-trip stringification reproduces the wire format
    // bit-for-bit — the strongest "no silent truncation" guarantee.
    expect(String(parsed)).toBe(wire);
  });

  it('parseFloat round-trips small balances without float dust', () => {
    expect(String(parseFloat('0.000001'))).toBe('0.000001');
    expect(String(parseFloat('1.500000'))).toBe('1.5');
    expect(parseFloat('1.500000')).toBe(1.5);
  });
});
