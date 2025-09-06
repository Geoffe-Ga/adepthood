export const breakpoints = { xs: 0, sm: 360, md: 600, lg: 900, xl: 1200 } as const;

const BASE_SPACING = 8;
export const spacing = (n: number, scale = 1): number => n * BASE_SPACING * scale;

export const radius = {
  sm: 4,
  md: 8,
  lg: 16,
} as const;

export const elevation = {
  sm: 1,
  md: 3,
  lg: 6,
} as const;

export const border = {
  width: 1,
  color: '#ddd',
} as const;

export const typography = (width: number) => {
  const base =
    width < breakpoints.sm
      ? 14
      : width < breakpoints.md
        ? 16
        : width < breakpoints.lg
          ? 18
          : width < breakpoints.xl
            ? 20
            : 22;
  return {
    title: base * 1.4,
    body: base,
    caption: base * 0.8,
  } as const;
};
