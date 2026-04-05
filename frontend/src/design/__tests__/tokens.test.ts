/* eslint-env jest */
/* global describe, it, expect */
import {
  BORDER_RADIUS,
  MAP_STAGE_COLORS,
  SPACING,
  STAGE_COLORS,
  STAGE_ORDER,
  colors,
  radius,
  shadows,
  spacing,
  typography,
} from '../tokens';

describe('design tokens', () => {
  describe('colors', () => {
    it('exports primary palette colors', () => {
      expect(colors.primary).toBe('#1a1910');
      expect(colors.secondary).toBe('#413d2f');
      expect(colors.success).toBe('#535c46');
      expect(colors.warning).toBe('#6c6b63');
      expect(colors.danger).toBe('#7b3f30');
      expect(colors.neutral).toBe('#8c8c8c');
    });

    it('exports background shades', () => {
      expect(colors.background.primary).toBe('#f8f8f8');
      expect(colors.background.card).toBe('#ffffff');
      expect(colors.background.accent).toBe('#f0f0f0');
    });

    it('exports text shades', () => {
      expect(colors.text.primary).toBe('#333333');
      expect(colors.text.secondary).toBe('#666666');
      expect(colors.text.tertiary).toBe('#999999');
      expect(colors.text.light).toBe('#ffffff');
    });

    it('exports mystical effect colors', () => {
      expect(colors.mystical.glowLight).toBe('rgba(255, 255, 255, 0.2)');
      expect(colors.mystical.glowPurple).toBe('rgba(103, 58, 183, 0.15)');
      expect(colors.mystical.overlay).toBe('rgba(0, 0, 0, 0.5)');
      expect(colors.mystical.transparentLight).toBe('rgba(255, 255, 255, 0.7)');
    });

    it('exports tier colors for goal display', () => {
      expect(colors.tier.low).toBe('#bc845d');
      expect(colors.tier.clear).toBe('#807f66');
      expect(colors.tier.stretch).toBe('#b0ae91');
      expect(colors.tier.default).toBe('#dad9d4');
    });

    it('exports border color', () => {
      expect(colors.border).toBe('#ddd');
    });
  });

  describe('STAGE_COLORS', () => {
    it('maps all ten stage names to hex colors', () => {
      expect(Object.keys(STAGE_COLORS)).toHaveLength(10);
      expect(STAGE_COLORS['Beige']).toBe('#d8cbb8');
      expect(STAGE_COLORS['Purple']).toBe('#a093c6');
      expect(STAGE_COLORS['Red']).toBe('#cc5b5b');
      expect(STAGE_COLORS['Blue']).toBe('#6fa3d3');
      expect(STAGE_COLORS['Orange']).toBe('#f29f67');
      expect(STAGE_COLORS['Green']).toBe('#6fcf97');
      expect(STAGE_COLORS['Yellow']).toBe('#f2e96d');
      expect(STAGE_COLORS['Turquoise']).toBe('#50c9c3');
      expect(STAGE_COLORS['Ultraviolet']).toBe('#8e44ad');
      expect(STAGE_COLORS['Clear Light']).toBe('#ffffff');
    });

    it('contains only valid hex color values', () => {
      Object.values(STAGE_COLORS).forEach((color) => {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      });
    });
  });

  describe('STAGE_ORDER', () => {
    it('lists all ten stages in progression order', () => {
      expect(STAGE_ORDER).toHaveLength(10);
      expect(STAGE_ORDER[0]).toBe('Beige');
      expect(STAGE_ORDER[9]).toBe('Clear Light');
    });

    it('contains exactly the same keys as STAGE_COLORS', () => {
      const colorKeys = Object.keys(STAGE_COLORS).sort();
      const orderKeys = [...STAGE_ORDER].sort();
      expect(orderKeys).toEqual(colorKeys);
    });
  });

  describe('MAP_STAGE_COLORS', () => {
    it('exports colors for the map spiral', () => {
      expect(MAP_STAGE_COLORS).toHaveLength(10);
      expect(MAP_STAGE_COLORS[0]).toBe('#7f1d1d');
    });
  });

  describe('spacing', () => {
    it('returns multiples of 8 by default', () => {
      expect(spacing(0)).toBe(0);
      expect(spacing(1)).toBe(8);
      expect(spacing(2)).toBe(16);
      expect(spacing(3)).toBe(24);
    });

    it('applies a custom scale factor', () => {
      expect(spacing(1, 0.5)).toBe(4);
      expect(spacing(2, 1.5)).toBe(24);
    });

    it('exports named spacing constants', () => {
      expect(SPACING.xs).toBe(4);
      expect(SPACING.sm).toBe(8);
      expect(SPACING.md).toBe(12);
      expect(SPACING.lg).toBe(16);
      expect(SPACING.xl).toBe(20);
      expect(SPACING.xxl).toBe(30);
    });
  });

  describe('radius', () => {
    it('exports border radius values', () => {
      expect(radius.sm).toBe(4);
      expect(radius.md).toBe(8);
      expect(radius.lg).toBe(16);
    });

    it('exports extended radius values for habits UI', () => {
      expect(BORDER_RADIUS.xs).toBe(2);
      expect(BORDER_RADIUS.sm).toBe(4);
      expect(BORDER_RADIUS.md).toBe(8);
      expect(BORDER_RADIUS.lg).toBe(12);
      expect(BORDER_RADIUS.xl).toBe(15);
      expect(BORDER_RADIUS.xxl).toBe(30);
      expect(BORDER_RADIUS.circle).toBe(9999);
    });
  });

  describe('shadows', () => {
    it('exports shadow presets with elevation values', () => {
      expect(shadows.small.elevation).toBe(2);
      expect(shadows.medium.elevation).toBe(3);
      expect(shadows.large.elevation).toBe(5);
      expect(shadows.glow.elevation).toBe(5);
    });

    it('includes shadow properties for each level', () => {
      expect(shadows.small).toHaveProperty('shadowColor');
      expect(shadows.small).toHaveProperty('shadowOffset');
      expect(shadows.small).toHaveProperty('shadowOpacity');
      expect(shadows.small).toHaveProperty('shadowRadius');
    });
  });

  describe('typography', () => {
    it('returns responsive font sizes based on width', () => {
      const small = typography(300);
      const medium = typography(600);
      const large = typography(1200);

      expect(small.body).toBeLessThan(medium.body);
      expect(medium.body).toBeLessThan(large.body);
    });

    it('scales title larger than body larger than caption', () => {
      const sizes = typography(600);
      expect(sizes.title).toBeGreaterThan(sizes.body);
      expect(sizes.body).toBeGreaterThan(sizes.caption);
    });
  });
});
