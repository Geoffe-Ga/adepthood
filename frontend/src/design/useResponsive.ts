import { useWindowDimensions } from 'react-native';

import { breakpoints, spacing } from './tokens';

const SCALE_XS = 0.85;
const SCALE_SM = 0.9;
const SCALE_MD = 1;
const SCALE_LG = 1.1;
const SCALE_XL = 1.2;
const SHORT_HEIGHT_THRESHOLD = 700;
const SHORT_HEIGHT_SCALE = 0.85;

const scaleByBreakpoint = new Map<string, number>([
  ['xs', SCALE_XS],
  ['sm', SCALE_SM],
  ['md', SCALE_MD],
  ['lg', SCALE_LG],
  ['xl', SCALE_XL],
]);

const getBreakpointKey = (width: number): string => {
  if (width < breakpoints.sm) return 'xs';
  if (width < breakpoints.md) return 'sm';
  if (width < breakpoints.lg) return 'md';
  if (width < breakpoints.xl) return 'lg';
  return 'xl';
};

const getBaseScale = (width: number): number =>
  scaleByBreakpoint.get(getBreakpointKey(width)) ?? SCALE_MD;

const getHeightScale = (height: number): number =>
  height < SHORT_HEIGHT_THRESHOLD ? SHORT_HEIGHT_SCALE : 1;

export const useResponsive = () => {
  const { width, height } = useWindowDimensions();
  const breakpointKey = getBreakpointKey(width);

  const baseScale = getBaseScale(width);
  const scale = baseScale * getHeightScale(height);
  const columns = width > height ? 2 : 1;
  const gridGutter = spacing(1, scale);

  return {
    width,
    height,
    isXS: breakpointKey === 'xs',
    isSM: breakpointKey === 'sm',
    isMD: breakpointKey === 'md',
    isLG: breakpointKey === 'lg',
    isXL: breakpointKey === 'xl',
    columns,
    gridGutter,
    scale,
  } as const;
};

export default useResponsive;
