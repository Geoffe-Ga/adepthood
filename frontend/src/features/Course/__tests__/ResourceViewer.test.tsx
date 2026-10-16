import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import ResourceViewer from '../ResourceViewer';
import { useStartHereStore } from '../startHereStore';

import { course } from '@/api';
import { beginAuthSession } from '@/api/sessionToken';
import { setActiveUser } from '@/storage/userScope';

let mockSessionToken: string | undefined = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
jest.mock('@/api', () => ({
  captureSessionToken: () => mockSessionToken,
  course: { markResourceRead: jest.fn() },
}));
jest.mock('../ChapterReader', () => ({
  __esModule: true,
  default: ({ renderFooter }: { renderFooter: (_end: boolean) => React.ReactNode }) =>
    renderFooter(true),
}));
beforeEach(() => {
  mockSessionToken = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
  setActiveUser(1);
  useStartHereStore.getState().reset();
  jest.clearAllMocks();
  jest.mocked(course.markResourceRead).mockReset();
});
describe('confirmed resource reading state', () => {
  it.each([
    ['no credential', undefined],
    ['a malformed credential', 'not-a-session'],
    ['a credential without a subject', 'e30.eyJleHAiOjQxMDI0NDQ4MDB9.signature'],
    ['the previous account credential', 'e30.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature'],
  ])('does not send a mark with %s', async (_label, token) => {
    mockSessionToken = token;
    const view = render(
      <ResourceViewer
        resource={{ slug: 'about', title: 'About' }}
        onBack={jest.fn()}
        onMarkedRead={jest.fn()}
      />,
    );
    await act(async () => fireEvent.press(view.getByLabelText('Mark as Read')));
    expect(course.markResourceRead).not.toHaveBeenCalled();
    expect(view.queryByText('✓ Read')).toBeNull();
  });

  it('sends the captured credential on a successful mark and refreshes only after confirmation', async () => {
    const completion = { id: 1, slug: 'about', completed_at: '2026-10-14T00:00:00Z' };
    jest.mocked(course.markResourceRead).mockResolvedValueOnce(completion);
    const changed = jest.fn();
    const view = render(
      <ResourceViewer
        resource={{ slug: 'about', title: 'About' }}
        onBack={jest.fn()}
        onMarkedRead={changed}
      />,
    );
    await act(async () => fireEvent.press(view.getByLabelText('Mark as Read')));
    expect(course.markResourceRead).toHaveBeenCalledWith('about', mockSessionToken);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(view.getByText('✓ Read')).toBeTruthy();
  });

  it('reopens a known read resource without offering a new mark', () => {
    const view = render(
      <ResourceViewer
        resource={{ slug: 'about', title: 'About', is_read: true }}
        onBack={jest.fn()}
        onMarkedRead={jest.fn()}
      />,
    );
    expect(view.getByLabelText('Already read')).toBeDisabled();
    expect(course.markResourceRead).not.toHaveBeenCalled();
  });
  it('does not apply an old mark after switching accounts while the reader is mounted', async () => {
    let resolve!: (_value: Awaited<ReturnType<typeof course.markResourceRead>>) => void;
    jest.mocked(course.markResourceRead).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const changed = jest.fn();
    const view = render(
      <ResourceViewer
        resource={{ slug: 'about', title: 'About' }}
        onBack={jest.fn()}
        onMarkedRead={changed}
      />,
    );
    fireEvent.press(view.getByLabelText('Mark as Read'));
    act(() => {
      setActiveUser(2);
      useStartHereStore.getState().reset();
    });
    view.rerender(
      <ResourceViewer
        resource={{ slug: 'about', title: 'About' }}
        onBack={jest.fn()}
        onMarkedRead={changed}
      />,
    );
    await act(async () => resolve({ id: 1, slug: 'about', completed_at: '2026-10-14T00:00:00Z' }));
    expect(changed).not.toHaveBeenCalled();
    expect(view.queryByText('✓ Read')).toBeNull();
  });

  it.each([
    ['the same account signs back in', false],
    ['the token is only refreshed (control)', true],
  ])(
    'when %s mid-mark, the old answer lands only in its own session (#3423)',
    async (_label, lands) => {
      let resolve!: (_value: Awaited<ReturnType<typeof course.markResourceRead>>) => void;
      jest.mocked(course.markResourceRead).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const changed = jest.fn();
      const view = render(
        <ResourceViewer
          resource={{ slug: 'about', title: 'About' }}
          onBack={jest.fn()}
          onMarkedRead={changed}
        />,
      );
      fireEvent.press(view.getByLabelText('Mark as Read'));
      expect(view.getByTestId('resource-mark-read-loading')).toBeTruthy();
      if (!lands) beginAuthSession();
      await act(async () =>
        resolve({ id: 1, slug: 'about', completed_at: '2026-10-14T00:00:00Z' }),
      );
      expect(changed).toHaveBeenCalledTimes(lands ? 1 : 0);
      expect(view.queryByText('✓ Read') !== null).toBe(lands);
      // Either way the button is released, not left spinning.
      expect(view.queryByTestId('resource-mark-read-loading')).toBeNull();
    },
  );
});
