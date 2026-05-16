/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockContentBody = (jest.fn() as any).mockResolvedValue({
  url: 'https://aptitude.guru/course/beige-1',
  title: 'Chapter One',
  body_html: '<article>chapter body</article>',
});
const mockSiteResourceBody = (jest.fn() as any).mockResolvedValue({
  url: 'https://aptitude.guru/philosophy',
  title: 'Philosophy',
  body_html: '<article>philosophy body</article>',
});

jest.mock('../../../api', () => ({
  course: {
    contentBody: (...args: unknown[]) => mockContentBody(...args),
    siteResourceBody: (...args: unknown[]) => mockSiteResourceBody(...args),
  },
}));

// eslint-disable-next-line import/order
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const ChapterReader = require('../ChapterReader').default;

describe('ChapterReader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentBody.mockResolvedValue({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'Chapter One',
      body_html: '<article>chapter body</article>',
    });
    mockSiteResourceBody.mockResolvedValue({
      url: 'https://aptitude.guru/philosophy',
      title: 'Philosophy',
      body_html: '<article>philosophy body</article>',
    });
  });

  it('renders the fallback title until the live one arrives', async () => {
    const onBack = jest.fn() as any;
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
    const onBack = jest.fn() as any;
    render(
      <ChapterReader source={{ kind: 'content', id: 42 }} fallbackTitle="x" onBack={onBack} />,
    );
    await waitFor(() => expect(mockContentBody).toHaveBeenCalledWith(42));
    expect(mockSiteResourceBody).not.toHaveBeenCalled();
  });

  it('routes resource sources to course.siteResourceBody', async () => {
    const onBack = jest.fn() as any;
    render(
      <ChapterReader
        source={{ kind: 'resource', slug: 'philosophy' }}
        fallbackTitle="x"
        onBack={onBack}
      />,
    );
    await waitFor(() => expect(mockSiteResourceBody).toHaveBeenCalledWith('philosophy'));
    expect(mockContentBody).not.toHaveBeenCalled();
  });

  it('renders a footer when one is provided', async () => {
    const { Text } = require('react-native');
    const onBack = jest.fn() as any;
    const { findByText } = render(
      <ChapterReader
        source={{ kind: 'content', id: 1 }}
        fallbackTitle="x"
        onBack={onBack}
        footer={<Text>FOOTER_HERE</Text>}
      />,
    );
    await findByText('FOOTER_HERE');
  });

  it('triggers onBack from the header back button', async () => {
    const onBack = jest.fn() as any;
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={onBack} />,
    );
    fireEvent.press(await findByTestId('reader-back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('wraps the cleaned HTML in a styled document', async () => {
    const onBack = jest.fn() as any;
    const { findByTestId } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={onBack} />,
    );
    const webview = await findByTestId('reader-webview');
    const html: string = webview.props['data-source-html'];
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<article>chapter body</article>');
    // Mobile viewport is set so the WebView renders at native scale.
    expect(html).toMatch(/<meta name="viewport"/);
  });

  it('shows an error and lets the user retry on transient failure', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'cms_unavailable' }).mockResolvedValueOnce({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'After retry',
      body_html: '<article>retried</article>',
    });
    const onBack = jest.fn() as any;
    const { findByTestId, findByText } = render(
      <ChapterReader source={{ kind: 'content', id: 1 }} fallbackTitle="x" onBack={onBack} />,
    );
    await findByText(/temporarily unreachable/i);
    fireEvent.press(await findByTestId('reader-retry-button'));
    const webview = await findByTestId('reader-webview');
    expect(webview.props['data-source-html']).toContain('retried');
  });
});
