import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { decorativeHidden } from '../a11yHidden';

import { chartStyles } from './chartStyles';
import { domainY } from './geometry';
import type { ChartAsk } from './types';

import { chartLayout, surface } from '@/design/tokens';

export function Plot({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} {...decorativeHidden()}>
      {children}
    </Svg>
  );
}

export function AskLine({
  ask,
  max,
  width,
  height,
  min = 0,
}: {
  ask?: ChartAsk;
  max: number;
  width: number;
  height: number;
  min?: number;
}) {
  if (!ask) return null;
  const y = domainY(ask.value, min, max, height);
  return (
    <Line
      x1={0}
      x2={width}
      y1={y}
      y2={y}
      stroke={surface.hairline}
      strokeWidth={chartLayout.hairlineWidth}
    />
  );
}

export function AskLabel({ ask }: { ask?: ChartAsk }) {
  return ask ? <Text style={chartStyles.caption}>{ask.label}</Text> : null;
}

export function AxisLabels({ first, last }: { first?: string; last?: string }) {
  return (
    <View style={chartStyles.axis}>
      <Text style={chartStyles.tick}>{first}</Text>
      <Text style={chartStyles.tick}>{last}</Text>
    </View>
  );
}
