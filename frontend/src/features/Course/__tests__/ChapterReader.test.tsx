/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import type * as Api from '../../../api';
import ChapterReader from '../ChapterReader';

jest.mock('../../../api', () => ({
  course: {
    contentBody: jest.fn(),
    siteResourceBody: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
    siteResourceBody: jest.MockedFunction<typeof Api.course.siteResourceBody>;
  };
};

const { contentBody: mockContentBody, siteResourceBody: mockSiteResourceBody } = courseApi;

const HAPPY_CHAPTER = {
  url: 'https://aptitude.guru/course/beige-1',
  title: 'Chapter One',
  body_html: '<article>chapter body</article>',
};

const HAPPY_RESOURCE = {
  url: 'https://aptitude.guru/philosophy',
  title: 'Philosophy',
  body_html: '<article>philosophy body</article>',
};

describe('ChapterReader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue(HAPPY_CHAPTER);
    mockSiteResourceBody.mockResolvedValue(HAPPY_RESOURCE);
  });

  it('renders the fallback title until the live one arrives', async () => {
    const onBack = jest.fn();
    const { getByText, findByText } = render(
      <ChapterReader
        source={{ kind: 'content', id: 7 }}
        fallbackTitle="Loading…"
        onBack={onBack}
      />,
    );
    expect(getByText('Loading…')).toBeTruthy();
    await findByText('Chapter One');
  });

  it('routes content sources to course.contentBody', async () => {
    render(
      <ChapterReader source={{ kind: 'content', id: 42 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await waitFor(() => expect(mockContentBody).toHaveBeenCalledWith(42));
    expect(mockSiteResourceBody).not.toHaveBeenCalled();
  });

  it('routes resource sources to course.siteResourceBody', async () => {
    render(
      <ChapterReader
        source={{ kind: 'resource', slug: 'philosophy' }}
        fallbackTitle="x"
        onBack={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockSiteResourceBody).toHaveBeenCalledWith('philosophy'));
    expect(mockContentBody).not.toHaveBeenCalled();
  });

  it('renders a footer when one is provided', async () => {
    const { findByText } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="x"
        onBack={jest.fn()}
        footer={<Text>FOOTER_HERE</Text>}
      />,
    );
    await findByText('FOOTER_HERE');
  });

  it('triggers onBack from the header back button', async () => {
    const onBack = jest.fn();
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={onBack} />,
    );
    fireEvent.press(await findByTestId('reader-back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('wraps the cleaned HTML in a styled document', async () => {
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    const webview = await findByTestId('reader-webview');
    const html = String(webview.props['data-source-html']);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<article>chapter body</article>');
    // Mobile viewport is set so the WebView renders at native scale.
    expect(html).toMatch(/<meta name="viewport"/);
    // <base target="_blank"> is web-only; on native it could drop navigations
    // past the onShouldStartLoadWithRequest guard, so it must not be emitted.
    expect(html).not.toContain('<base');
  });

  it('shows an error and lets the user retry on transient failure', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'cms_unavailable' }).mockResolvedValueOnce({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'After retry',
      body_html: '<article>retried</article>',
    });
    const { findByTestId, findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByText(/temporarily unreachable/i);
    fireEvent.press(await findByTestId('reader-retry-button'));
    const webview = await findByTestId('reader-webview');
    expect(String(webview.props['data-source-html'])).toContain('retried');
  });

  it('shows the server-config message when the CMS auth detail comes back', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'cms_auth_failed' });
    const { findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={jest.fn()} />,
    );
    await findByText(/site password is not set/i);
  });
});
