import { useWindowDimensions } from 'react-native';

import { breakpoints, spacing } from './DesignSystem';

export const useResponsive = () => {
  const { width, height } = useWindowDimensions();
  const isXS = width < breakpoints.sm;
  const isSM = width >= breakpoints.sm && width < breakpoints.md;
  const isMD = width >= breakpoints.md && width < breakpoints.lg;
  const isLG = width >= breakpoints.lg && width < breakpoints.xl;
  const isXL = width >= breakpoints.xl;

  const scale = isXS ? 0.85 : isSM ? 0.9 : isMD ? 1 : isLG ? 1.1 : 1.2;
  const columns = width > height ? 2 : 1;
  const gridGutter = spacing(2, scale);

  return {
    width,
    height,
    isXS,
    isSM,
    isMD,
    isLG,
    isXL,
    columns,
    gridGutter,
    scale,
  } as const;
};

export default useResponsive;
