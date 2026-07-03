import React from 'react';
import { View, type DimensionValue, type ViewStyle } from 'react-native';

import { TierStar } from '../../components/TierStar';

import { centeredTranslateX, tooltipBoxStyle, type TierType } from './goalMarker';
import { clampPercentage, getTierColor } from './HabitUtils';
import { longPressGestureStyle } from './longPressGestureStyle';

/**
 * One tier marker's render spec: which tier, where it sits on the bar
 * (`position` as a 0–100 percent), its stacking `zIndex`, whether the goal is
 * `met` (drives the star fill), and whether it is `visible` at all.
 */
export interface TierMarkerSpec {
  tier: TierType;
  position: number;
  zIndex: number;
  met: boolean;
  visible: boolean;
}

/**
 * How a marker wraps and wires its press/pan interaction. `Wrapper` is the
 * element type (e.g. `TouchableOpacity` for tap tooltips, `View` for pan
 * drag), and `interactionProps` are spread onto it. The overlay layers its
 * own hover handlers on top, so mouse enter/leave always win.
 */
export interface MarkerInteraction {
  Wrapper: React.ComponentType<Record<string, unknown>>;
  interactionProps: Record<string, unknown>;
}

/** Center a tier star on its bar position and vertically on the bar height. */
const markerContainerStyle = (
  position: number,
  zIndex: number,
  starSize: number,
  barHeight: number,
): ViewStyle => {
  const clamped = clampPercentage(position);
  return {
    position: 'absolute',
    left: `${clamped}%` as DimensionValue,
    top: (barHeight - starSize) / 2,
    transform: [{ translateX: centeredTranslateX(clamped, starSize) }],
    zIndex,
    alignItems: 'center',
    ...longPressGestureStyle,
  };
};

interface TierMarkerOverlayProps<T extends TierMarkerSpec> {
  markers: T[];
  barHeight: number;
  starSize: number;
  tooltip: TierType | null;
  setTooltip: (_v: TierType | null) => void;
  markerTestIDPrefix: string;
  tooltipTestIDPrefix: string;
  renderTooltip: (_m: T) => React.ReactNode;
  resolveInteraction: (_m: T) => MarkerInteraction;
}

/**
 * The shared three-tier goal-marker overlay: renders a tier star per visible
 * marker, positioned along a progress bar, each with a hover/press tooltip.
 * Callers supply the marker specs, the tooltip body, and the interaction
 * wrapper so the habit tile and the goal modal can share one implementation
 * while keeping their own sizing, wrappers, and tooltip typography.
 */
export function TierMarkerOverlay<T extends TierMarkerSpec>({
  markers,
  barHeight,
  starSize,
  tooltip,
  setTooltip,
  markerTestIDPrefix,
  tooltipTestIDPrefix,
  renderTooltip,
  resolveInteraction,
}: TierMarkerOverlayProps<T>): React.JSX.Element {
  return (
    <>
      {markers
        .filter((m) => m.visible)
        .map((m) => {
          const { Wrapper, interactionProps } = resolveInteraction(m);
          return (
            <Wrapper
              key={m.tier}
              testID={`${markerTestIDPrefix}-${m.tier}`}
              {...interactionProps}
              onMouseEnter={() => setTooltip(m.tier)}
              onMouseLeave={() => setTooltip(null)}
              style={markerContainerStyle(m.position, m.zIndex, starSize, barHeight)}
            >
              {tooltip === m.tier && (
                <View
                  testID={`${tooltipTestIDPrefix}-${m.tier}`}
                  style={tooltipBoxStyle(getTierColor(m.tier))}
                >
                  {renderTooltip(m)}
                </View>
              )}
              <TierStar tier={m.tier} met={m.met} size={starSize} />
            </Wrapper>
          );
        })}
    </>
  );
}
