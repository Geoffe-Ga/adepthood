/* eslint-env jest */
import { describe, expect, it, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Platform } from 'react-native';

jest.mock('../../../api', () => ({
  course: {
    contentBody: jest.fn(),
    siteResourceBody: jest.fn(),
  },
}));

import type * as Api from '../../../api';
import ChapterReader from '../ChapterReader';

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
    siteResourceBody: jest.MockedFunction<typeof Api.course.siteResourceBody>;
  };
};

const { contentBody: mockContentBody } = courseApi;

describe('ChapterReader (web platform)', () => {
  // Platform.OS is read inside renderBody at render time, so flipping it for
  // this file's tests is enough; the native test file leaves it on the default
  // ('ios') and continues to exercise the WebView branch.
  let originalOS: typeof Platform.OS;

  beforeAll(() => {
    originalOS = Platform.OS;
    (Platform as { OS: typeof Platform.OS }).OS = 'web';
  });

  afterAll(() => {
    (Platform as { OS: typeof Platform.OS }).OS = originalOS;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'Chapter One',
      body_html: '<article>chapter body</article>',
    });
  });

  it('renders an iframe with the cleaned document and the popup sandbox', async () => {
    // ``react-test-renderer`` strips props it does not recognise from the
    // snapshot for unknown host elements like ``iframe``, but the underlying
    // ``ReactTestInstance`` keeps the original props — that's what we read.
    const { UNSAFE_root } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="Loading…"
        onBack={jest.fn()}
      />,
    );

    const iframe = await waitFor(() =>
      UNSAFE_root.findByType('iframe' as unknown as React.ComponentType),
    );
    expect(String(iframe.props.srcDoc)).toMatch(/<!doctype html>/i);
    expect(String(iframe.props.srcDoc)).toContain('chapter body');
    expect(iframe.props.sandbox).toBe('allow-popups');
    expect(iframe.props.title).toBe('Chapter One');
    // The <base target="_blank"> in buildDocument is what makes links open in
    // a new tab on web (replaces the native onShouldStartLoadWithRequest
    // guard).  Pin it so a future buildDocument tweak can't drop it.
    expect(String(iframe.props.srcDoc)).toContain('<base target="_blank"');
  });

  it('does not render the native WebView on web', async () => {
    const { queryByTestId, UNSAFE_root } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="Loading…"
        onBack={jest.fn()}
      />,
    );

    await waitFor(() => UNSAFE_root.findByType('iframe' as unknown as React.ComponentType));
    expect(queryByTestId('reader-webview')).toBeNull();
  });
});
