/* eslint-env jest */
/* global describe, it, expect */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import renderer from 'react-test-renderer';

import { TierStar } from '../../../components/TierStar';
import { TierMarkerOverlay } from '../TierMarkerOverlay';
import type { MarkerInteraction, TierMarkerSpec } from '../TierMarkerOverlay';

interface TestMarkerSpec extends TierMarkerSpec {
  label: string;
}

const PAN_PROP_KEY = 'data-pan';
const PAN_PROP_VALUE = 'yes';
const DEFAULT_BAR_HEIGHT = 24;
const DEFAULT_STAR_SIZE = 14;
const OVER_MAX_POSITION = 150;

const baseMarkers: Record<TierMarkerSpec['tier'], TestMarkerSpec> = {
  low: { tier: 'low', position: 10, zIndex: 1, met: false, visible: true, label: 'Low' },
  clear: { tier: 'clear', position: 50, zIndex: 2, met: false, visible: true, label: 'Clear' },
  stretch: { tier: 'stretch', position: 90, zIndex: 3, met: true, visible: true, label: 'Stretch' },
};

const buildMarkers = (
  overrides: Partial<Record<TierMarkerSpec['tier'], Partial<TestMarkerSpec>>> = {},
): TestMarkerSpec[] =>
  (['low', 'clear', 'stretch'] as const).map((tier) => ({
    ...baseMarkers[tier],
    ...overrides[tier],
  }));

const defaultRenderTooltip = (m: TestMarkerSpec): React.ReactNode => <Text>{m.label}</Text>;

interface HarnessProps {
  markers: TestMarkerSpec[];
  markerTestIDPrefix?: string;
  tooltipTestIDPrefix?: string;
  renderTooltip?: (m: TestMarkerSpec) => React.ReactNode;
}

// Wraps TierMarkerOverlay with real useState so setTooltip round-trips
// through a re-render, exercising the hover/press wiring end-to-end.
const Harness = ({
  markers,
  markerTestIDPrefix = 'marker',
  tooltipTestIDPrefix = 'tooltip',
  renderTooltip = defaultRenderTooltip,
}: HarnessProps) => {
  const [tooltip, setTooltip] = useState<TierMarkerSpec['tier'] | null>(null);

  const resolveInteraction = (m: TestMarkerSpec): MarkerInteraction => {
    if (m.tier === 'stretch') {
      return {
        Wrapper: TouchableOpacity,
        interactionProps: {
          onPressIn: () => setTooltip(m.tier),
          onPressOut: () => setTooltip(null),
        },
      };
    }
    return { Wrapper: View, interactionProps: { [PAN_PROP_KEY]: PAN_PROP_VALUE } };
  };

  return (
    <TierMarkerOverlay
      markers={markers}
      barHeight={DEFAULT_BAR_HEIGHT}
      starSize={DEFAULT_STAR_SIZE}
      tooltip={tooltip}
      setTooltip={setTooltip}
      markerTestIDPrefix={markerTestIDPrefix}
      tooltipTestIDPrefix={tooltipTestIDPrefix}
      renderTooltip={renderTooltip}
      resolveInteraction={resolveInteraction}
    />
  );
};

describe('TierMarkerOverlay visibility', () => {
  it('renders only markers whose visible flag is true', () => {
    const markers = buildMarkers({ clear: { visible: false } });
    const component = renderer.create(<Harness markers={markers} />);

    expect(component.root.findByProps({ testID: 'marker-low' })).toBeTruthy();
    expect(component.root.findByProps({ testID: 'marker-stretch' })).toBeTruthy();
    expect(() => component.root.findByProps({ testID: 'marker-clear' })).toThrow();
  });
});

describe('TierMarkerOverlay resolveInteraction wiring', () => {
  it('spreads interactionProps from resolveInteraction onto the Wrapper', () => {
    const markers = buildMarkers();
    const component = renderer.create(<Harness markers={markers} />);

    const marker = component.root.findByProps({ testID: 'marker-low' });
    expect(marker.props[PAN_PROP_KEY]).toBe(PAN_PROP_VALUE);
  });

  it('honors a resolveInteraction Wrapper whose onPressIn/onPressOut drive the tooltip', () => {
    const markers = buildMarkers();
    const component = renderer.create(<Harness markers={markers} />);

    const marker = component.root.findByProps({ testID: 'marker-stretch' });
    expect(typeof marker.props.onPressIn).toBe('function');
    expect(() => component.root.findByProps({ testID: 'tooltip-stretch' })).toThrow();

    renderer.act(() => {
      marker.props.onPressIn();
    });
    expect(component.root.findByProps({ testID: 'tooltip-stretch' })).toBeTruthy();

    renderer.act(() => {
      marker.props.onPressOut();
    });
    expect(() => component.root.findByProps({ testID: 'tooltip-stretch' })).toThrow();
  });
});

describe('TierMarkerOverlay hover', () => {
  it('shows the tooltip on mouse enter and hides it on mouse leave', () => {
    const markers = buildMarkers();
    const component = renderer.create(<Harness markers={markers} />);

    const marker = component.root.findByProps({ testID: 'marker-low' });
    expect(() => component.root.findByProps({ testID: 'tooltip-low' })).toThrow();

    renderer.act(() => {
      marker.props.onMouseEnter();
    });
    expect(component.root.findByProps({ testID: 'tooltip-low' })).toBeTruthy();
    expect(() => component.root.findByProps({ testID: 'tooltip-clear' })).toThrow();

    renderer.act(() => {
      marker.props.onMouseLeave();
    });
    expect(() => component.root.findByProps({ testID: 'tooltip-low' })).toThrow();
  });
});

describe('TierMarkerOverlay renderTooltip', () => {
  it('renders the renderTooltip output inside the tooltip box', () => {
    const markers = buildMarkers();
    const component = renderer.create(
      <Harness markers={markers} renderTooltip={(m) => <Text>{`known-${m.tier}`}</Text>} />,
    );

    const marker = component.root.findByProps({ testID: 'marker-clear' });
    renderer.act(() => {
      marker.props.onMouseEnter();
    });

    const box = component.root.findByProps({ testID: 'tooltip-clear' });
    const text = box.findByType(Text);
    expect(text.props.children).toBe('known-clear');
  });
});

describe('TierMarkerOverlay position style', () => {
  it('places a marker at left = position% with a translateX transform', () => {
    const markers = buildMarkers({ clear: { position: 50 } });
    const component = renderer.create(<Harness markers={markers} />);

    const marker = component.root.findByProps({ testID: 'marker-clear' });
    expect(marker.props.style.position).toBe('absolute');
    expect(marker.props.style.left).toBe('50%');
    expect(marker.props.style.zIndex).toBe(2);
    expect(marker.props.style.alignItems).toBe('center');
    expect(Array.isArray(marker.props.style.transform)).toBe(true);
  });

  it('clamps an out-of-range position to 100%', () => {
    const markers = buildMarkers({ stretch: { position: OVER_MAX_POSITION } });
    const component = renderer.create(<Harness markers={markers} />);

    const marker = component.root.findByProps({ testID: 'marker-stretch' });
    expect(marker.props.style.left).toBe('100%');
  });
});

describe('TierMarkerOverlay testID prefixes', () => {
  it('honors a custom markerTestIDPrefix/tooltipTestIDPrefix pair', () => {
    const markers = buildMarkers();
    const component = renderer.create(
      <Harness
        markers={markers}
        markerTestIDPrefix="modal-marker"
        tooltipTestIDPrefix="modal-tooltip"
      />,
    );

    const marker = component.root.findByProps({ testID: 'modal-marker-low' });
    renderer.act(() => {
      marker.props.onMouseEnter();
    });
    expect(component.root.findByProps({ testID: 'modal-tooltip-low' })).toBeTruthy();
  });

  it('honors the default markerTestIDPrefix/tooltipTestIDPrefix pair', () => {
    const markers = buildMarkers();
    const component = renderer.create(<Harness markers={markers} />);

    const marker = component.root.findByProps({ testID: 'marker-low' });
    renderer.act(() => {
      marker.props.onMouseEnter();
    });
    expect(component.root.findByProps({ testID: 'tooltip-low' })).toBeTruthy();
  });
});

describe('TierMarkerOverlay star rendering', () => {
  it('renders one image-role TierStar per visible marker', () => {
    const markers = buildMarkers({ clear: { visible: false } });
    const component = renderer.create(<Harness markers={markers} />);

    const stars = component.root.findAllByType(TierStar);
    expect(stars).toHaveLength(2);
  });
});
