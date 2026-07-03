/* eslint-env jest */
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

import JournalHero from '../JournalHero';

import { STAGE_ORDER, onShowcase, touchTarget } from '@/design/tokens';
import {
  TOTAL_PROGRAM_WEEKS,
  programStage,
  programWeek,
  useProgramStore,
} from '@/store/useProgramStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const MID_PROGRAM_DAYS_AGO = 50;

beforeEach(() => {
  mockNavigate.mockClear();
  useProgramStore.getState().hydrateProgramStartDate(null);
});

afterEach(() => {
  useProgramStore.getState().hydrateProgramStartDate(null);
  jest.useRealTimers();
});

describe('JournalHero', () => {
  it('renders the showcase card with the eyebrow and a not-yet-started position', () => {
    const { getByTestId, getByText, getByRole } = render(<JournalHero />);
    expect(getByTestId('journal-hero')).toBeTruthy();
    expect(getByText('Today')).toBeTruthy();
    expect(getByRole('header')).toBeTruthy();
    expect(getByText('Your journey awaits')).toBeTruthy();
  });

  it('greets "Good morning" before noon', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T08:00:00'));
    const { getByText } = render(<JournalHero />);
    expect(getByText('Good morning')).toBeTruthy();
  });

  it('greets "Good afternoon" between noon and 6pm', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T14:00:00'));
    const { getByText } = render(<JournalHero />);
    expect(getByText('Good afternoon')).toBeTruthy();
  });

  it('greets "Good evening" after 6pm', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T20:00:00'));
    const { getByText } = render(<JournalHero />);
    expect(getByText('Good evening')).toBeTruthy();
  });

  it('shows the current week and stage once the program has started', () => {
    const anchor = new Date(Date.now() - MID_PROGRAM_DAYS_AGO * DAY_MS);
    useProgramStore.getState().hydrateProgramStartDate(anchor);
    const week = programWeek(anchor);
    const stage = programStage(anchor);
    const stageName = stage === null ? null : STAGE_ORDER[stage - 1];
    const { getByText } = render(<JournalHero />);
    expect(getByText(new RegExp(`Week ${String(week)} of ${TOTAL_PROGRAM_WEEKS}`))).toBeTruthy();
    expect(getByText(new RegExp(String(stageName)))).toBeTruthy();
  });

  it('exposes the position line as a pressable button with a map-opening label (no anchor)', () => {
    const { getByTestId } = render(<JournalHero />);
    const position = getByTestId('journal-hero-position');
    expect(position.props.accessibilityRole).toBe('button');
    const label: string = position.props.accessibilityLabel ?? '';
    expect(label.length).toBeGreaterThan(0);
    expect(label.endsWith('Open the map')).toBe(true);
  });

  it('navigates to the Map tab when the position line is pressed (no anchor)', () => {
    const { getByTestId } = render(<JournalHero />);
    fireEvent.press(getByTestId('journal-hero-position'));
    expect(mockNavigate).toHaveBeenCalledWith('Map');
  });

  it('navigates to the Map tab when the position line is pressed (seeded anchor)', () => {
    const anchor = new Date(Date.now() - MID_PROGRAM_DAYS_AGO * DAY_MS);
    useProgramStore.getState().hydrateProgramStartDate(anchor);
    const { getByTestId } = render(<JournalHero />);
    fireEvent.press(getByTestId('journal-hero-position'));
    expect(mockNavigate).toHaveBeenCalledWith('Map');
  });

  it('gives the seeded-anchor position line a map-opening label too', () => {
    const anchor = new Date(Date.now() - MID_PROGRAM_DAYS_AGO * DAY_MS);
    useProgramStore.getState().hydrateProgramStartDate(anchor);
    const { getByTestId } = render(<JournalHero />);
    const position = getByTestId('journal-hero-position');
    const label: string = position.props.accessibilityLabel ?? '';
    expect(label.endsWith('Open the map')).toBe(true);
  });

  it('sizes the position pressable to at least the minimum touch target', () => {
    const { getByTestId } = render(<JournalHero />);
    const position = getByTestId('journal-hero-position');
    const style = StyleSheet.flatten(position.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('colors the position text with an on-showcase ink token', () => {
    const { getByText } = render(<JournalHero />);
    const text = getByText('Your journey awaits');
    const style = StyleSheet.flatten(text.props.style);
    expect(Object.values(onShowcase)).toContain(style.color);
  });
});
