import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import renderer from 'react-test-renderer';

import { BottomFade } from '../BottomFade';

import { rhythm, surface } from '@/design/tokens';

// react-test-renderer ships no type definitions in this project, so test
// instances are annotated structurally (matching the TierStar renderer tests)
// to satisfy noImplicitAny.
interface TestNode {
  props: Record<string, unknown>;
}

type Rendered = ReturnType<typeof renderer.create>;

const findStopAtOffset = (component: Rendered, offset: string): TestNode =>
  component.root.find(
    (node: TestNode) => node.props.offset === offset && 'stopColor' in node.props,
  );

const findGradient = (component: Rendered): TestNode =>
  component.root.find((node: TestNode) => node.props.id === 'bottom-fade-grad');

const findAnyGradient = (component: Rendered): TestNode =>
  component.root.find(
    (node: TestNode) => typeof node.props.id === 'string' && node.props.x1 !== undefined,
  );

const findRect = (component: Rendered): TestNode =>
  component.root.find((node: TestNode) => typeof node.props.fill === 'string');

describe('BottomFade', () => {
  it('fades from transparent to the canvas surface color, top to bottom', () => {
    const component = renderer.create(<BottomFade />);
    const top = findStopAtOffset(component, '0').props;
    expect(top.stopColor).toBe(surface.canvas);
    expect(top.stopOpacity).toBe('0');
    const bottom = findStopAtOffset(component, '1').props;
    expect(bottom.stopColor).toBe(surface.canvas);
    expect(bottom.stopOpacity).toBe('1');
  });

  it('orients the gradient vertically', () => {
    const component = renderer.create(<BottomFade />);
    const gradient = findGradient(component).props;
    expect(gradient.x1).toBe('0');
    expect(gradient.y1).toBe('0');
    expect(gradient.x2).toBe('0');
    expect(gradient.y2).toBe('1');
  });

  it('is non-interactive and pinned to the bottom edge', () => {
    const { getByTestId } = render(<BottomFade />);
    const wrapper = getByTestId('bottom-fade');
    expect(wrapper.props.pointerEvents).toBe('none');
    const flat = StyleSheet.flatten(wrapper.props.style);
    expect(flat.position).toBe('absolute');
    expect(flat.bottom).toBe(0);
  });

  it('sizes its height from the rhythm token', () => {
    const { getByTestId } = render(<BottomFade />);
    const flat = StyleSheet.flatten(getByTestId('bottom-fade').props.style);
    expect(flat.height).toBe(rhythm.bottomFadeHeight);
  });

  it('keeps a fixed veil height regardless of the bottom safe-area inset', () => {
    const { getByTestId } = render(
      <SafeAreaInsetsContext.Provider value={{ top: 0, bottom: 34, left: 0, right: 0 }}>
        <BottomFade />
      </SafeAreaInsetsContext.Provider>,
    );
    const flat = StyleSheet.flatten(getByTestId('bottom-fade').props.style);
    expect(flat.height).toBe(rhythm.bottomFadeHeight);
  });

  it('forwards a custom testID', () => {
    const { getByTestId } = render(<BottomFade testID="fade-x" />);
    expect(getByTestId('fade-x')).toBeTruthy();
  });

  it('does not intercept touches on controls it overlaps', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(
      <View>
        <Pressable onPress={onPress}>
          <Text>Underneath</Text>
        </Pressable>
        <BottomFade />
      </View>,
    );
    expect(getByTestId('bottom-fade').props.pointerEvents).toBe('none');
    fireEvent.press(getByText('Underneath'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('fades to the desk surface color when given a color prop, opacity ramp unchanged', () => {
    const component = renderer.create(<BottomFade color={surface.desk} />);
    const top = findStopAtOffset(component, '0').props;
    expect(top.stopColor).toBe(surface.desk);
    expect(top.stopOpacity).toBe('0');
    const bottom = findStopAtOffset(component, '1').props;
    expect(bottom.stopColor).toBe(surface.desk);
    expect(bottom.stopOpacity).toBe('1');
  });

  it('gives each instance a distinct gradient id and points its own Rect at it', () => {
    const first = renderer.create(<BottomFade testID="fade-one" />);
    const second = renderer.create(<BottomFade testID="fade-two" />);
    const firstGradientId = findAnyGradient(first).props.id;
    const secondGradientId = findAnyGradient(second).props.id;
    expect(firstGradientId).not.toBe(secondGradientId);
    expect(findRect(first).props.fill).toBe(`url(#${String(firstGradientId)})`);
    expect(findRect(second).props.fill).toBe(`url(#${String(secondGradientId)})`);
  });
});
