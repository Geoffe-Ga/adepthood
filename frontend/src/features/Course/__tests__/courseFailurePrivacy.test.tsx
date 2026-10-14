import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import ReadNextButton, { useNextUnread } from '../ReadNextButton';
import ResourceViewer from '../ResourceViewer';

import type * as Api from '@/api';
import { ApiError, course } from '@/api';

jest.mock('@/api', () => {
  const actual = jest.requireActual<typeof Api>('@/api');
  return { ...actual, course: { markResourceRead: jest.fn(), nextUnread: jest.fn() } };
});

// Render the real resource footer without unrelated markdown fetching/geometry.
jest.mock('../ChapterReader', () => ({
  __esModule: true,
  default: ({ renderFooter }: { renderFooter: (atEnd: boolean) => React.ReactNode }) =>
    renderFooter(true),
}));

const mockMark = course.markResourceRead as jest.MockedFunction<typeof course.markResourceRead>;
const mockNext = course.nextUnread as jest.MockedFunction<typeof course.nextUnread>;
const CANARIES = [
  'private brief',
  'private '.repeat(100),
  '隐私日本語',
  'private\nsecond line',
  '秘密\u202Eprivate',
  'private 🪷',
];
let records: unknown[][];

/** Error's message, stack and cause are non-enumerable; JSON.stringify misses them. */
function allText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .map((field) => ('value' in field ? allText(field.value, seen) : ''))
    .join(' ');
}

beforeEach(() => {
  mockMark.mockReset();
  mockNext.mockReset();
  records = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      records.push(args);
    });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('Course failure privacy and recovery (#3210)', () => {
  it.each(CANARIES)(
    'resource mark failure retains retry without logging private detail (%s)',
    async (canary) => {
      const failure = new ApiError(503, canary);
      failure.cause = new Error(canary);
      mockMark.mockRejectedValueOnce(failure);
      const onMarkedRead = jest.fn();
      const screen = render(
        <ResourceViewer
          resource={{ slug: 'start-here', title: 'Start Here' }}
          onBack={jest.fn()}
          onMarkedRead={onMarkedRead}
        />,
      );
      await act(async () => fireEvent.press(screen.getByTestId('resource-mark-read-button')));
      expect(mockMark).toHaveBeenCalledTimes(1);
      expect(onMarkedRead).not.toHaveBeenCalled();
      expect(screen.getByTestId('resource-mark-read-button')).toBeEnabled();
      expect(allText(records)).not.toContain(canary);
      expect(records).toContainEqual(['course_read_failed']);
      mockMark.mockResolvedValueOnce({
        id: 1,
        slug: 'start-here',
        completed_at: '2026-10-14T00:00:00Z',
      });
      await act(async () => fireEvent.press(screen.getByTestId('resource-mark-read-button')));
      expect(onMarkedRead).toHaveBeenCalledTimes(1);
      expect(screen.getByText('✓ Read')).toBeTruthy();
    },
  );

  it.each(CANARIES)(
    'next unread failure stays distinct from caught-up and recovers (%s)',
    async (canary) => {
      const failure = new ApiError(503, canary);
      failure.cause = new Error(canary);
      mockNext.mockRejectedValueOnce(failure);
      const { result } = renderHook(() => useNextUnread());
      await waitFor(() => expect(result.current.state).toEqual({ status: 'error' }));
      const screen = render(<ReadNextButton state={result.current.state} onOpen={jest.fn()} />);
      expect(screen.queryByTestId('read-next')).toBeNull();
      expect(screen.queryByText('All caught up')).toBeNull();
      expect(allText(records)).not.toContain(canary);
      expect(records).toContainEqual(['course_load_failed']);
      mockNext.mockResolvedValueOnce(null);
      await act(async () => result.current.refresh());
      expect(result.current.state).toEqual({ status: 'ready', target: null });
      screen.rerender(<ReadNextButton state={result.current.state} onOpen={jest.fn()} />);
      expect(screen.getByText('All caught up')).toBeTruthy();
    },
  );
});
